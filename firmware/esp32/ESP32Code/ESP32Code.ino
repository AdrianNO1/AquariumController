#include <WiFi.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <PubSubClient.h>
#include <Update.h>
#include <EEPROM.h>
#include <ArduinoJson.h>
#include <map>
#include <string>
#include <vector>  // Added for std::vector
#include <SPIFFS.h>
#include <time.h>  // Added for time functions
#include <esp_wifi.h>
#include <esp_sntp.h>
#include <atomic>
#include <cerrno>
#include <climits>
#include <cstdio>
#include <cstdlib>
#include <cstring>  // for strlcpy, strlen
#include <esp_ota_ops.h>
#include <esp_partition.h>
#include <mbedtls/sha256.h>
#include "firmware-config.h"

unsigned long lastReconnectAttempt = 0;
const unsigned long reconnectInterval = 5000; // 5 seconds
const char* DEFAULT_DEVICE_NAME = "ESP32_Device"; // Default name

const int DEFAULT_FREQ = 5000; // Default frequency in Hz
const int DEFAULT_RES = 8;    // Don't change without altering manager.py
const int MIN_PIN = 0;
const int MAX_PIN = 63;
const char* HARDWARE_PROFILE = "nodemcu-esp32s-v1.1";
const char* HARDWARE_MODEL = "Ai-Thinker NodeMCU-32S V1.1";
// Conservative production outputs: GPIO0/2/5/15 are reset strapping pins,
// GPIO1/3 are the serial console, GPIO6-11 drive flash, and GPIO34-39 are
// input-only. GPIO12 is the sole strapping-pin exception because it is already
// deployed and its attached driver circuit is known not to pull it high at
// reset; see isAllowedPwmPin() for the replacement-wiring warning.
const int ALLOWED_PWM_PINS[] = {
    4, 12, 13, 14, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33
};
const int ALLOWED_ANALOG_INPUT_PINS[] = {32, 33, 34, 35, 36, 39};
const unsigned long MAX_SYNC_UNIX_TIME = 2147483647UL;
const uint64_t LEDC_SOURCE_CLOCK_HZ = 80000000ULL;

const char* VERSION = "5.0.5";
const bool TEST = false;
const long gmtOffset_sec = 0;           // GMT offset in seconds (UTC)
const int daylightOffset_sec = 0;      // No daylight savings offset
const time_t MIN_VALID_UNIX_TIME = 1735689600; // January 1, 2025 UTC
const unsigned long NTP_SYNC_TIMEOUT_MS = 15000;
const unsigned long NTP_RETRY_INTERVAL_MS = 60000;
const unsigned long NTP_RESYNC_INTERVAL_MS = 6UL * 60UL * 60UL * 1000UL;
const unsigned long TIME_CHECKPOINT_INTERVAL_MS = 60UL * 60UL * 1000UL;
const unsigned long PERSISTENCE_RETRY_INTERVAL_MS =
    TIME_CHECKPOINT_INTERVAL_MS;
const unsigned long DIAGNOSTIC_PERSIST_INTERVAL_MS = 60UL * 60UL * 1000UL;
const unsigned long DIAGNOSTIC_ANNOUNCEMENT_RETRY_INTERVAL_MS = 60UL * 1000UL;
const unsigned long TELEMETRY_ANNOUNCEMENT_INTERVAL_MS = 1000;
const unsigned long OTA_PROBATION_TIMEOUT_MS = 5UL * 60UL * 1000UL;
const unsigned int OTA_MAX_PROBATION_BOOTS = 3;
const size_t OTA_DOWNLOAD_BUFFER_SIZE = 4096;
const size_t OTA_MINIMUM_IMAGE_SIZE = 100000;
const size_t OTA_MAXIMUM_IMAGE_SIZE = 1900000;

std::atomic<bool> ntpTimeAvailable(false);
bool ntpSyncInProgress = false;
bool ntpSyncEverAttempted = false;
bool ntpSyncHasCompleted = false;
unsigned long ntpSyncStartedAt = 0;
unsigned long lastNtpSyncAttemptAt = 0;
unsigned long lastNtpSyncCompletedAt = 0;

JsonDocument globalDoc;

// EEPROM configuration
#define EEPROM_SIZE 512
#define NAME_ADDR 0
#define ID_ADDR 64
#define FREQ_ADDR 128
#define RES_ADDR 132
#define NAME_MAX_LENGTH 31
#define ID_MAX_LENGTH 8
#define SCHEDULE_UPDATE_INTERVAL 1000  // Check schedule every 1000ms
#define SCHEDULE_ATTACH_RETRY_INTERVAL 60000
#define MQTT_MAX_COMMAND_PAYLOAD_SIZE 5120
#define MQTT_PACKET_BUFFER_SIZE 6144
#define MAX_REQUEST_ID_LENGTH 64
#define MAX_LAST_ERROR_CODE_LENGTH 48
#define MAX_LAST_ERROR_MESSAGE_LENGTH 160

const unsigned long OVERWRITE_DURATION = 120000; // 120 seconds in milliseconds

struct PinState {
    int lastValue;
    bool isOverwritten;
    unsigned long overwriteStartedAt;
};
std::map<int, PinState> pinStates;

WiFiClient espClient;
PubSubClient client(espClient);

String configuredWifiSsid;
String configuredWifiPassword;
String configuredMqttServer;
uint16_t configuredMqttPort = 0;
String configuredMqttUsername;
String configuredMqttPassword;
String configuredNtpServer;

struct OtaRequest {
    String targetVersion;
    String url;
    String sha256;
    size_t size;
    bool pending;
};

struct OtaReport {
    String status;
    String targetVersion;
    String error;
    unsigned int progress;
};

OtaRequest otaRequest = {"", "", "", 0, false};
OtaReport otaReport = {"idle", "", "", 0};
bool otaProbationActive = false;
unsigned long otaProbationStartedAt = 0;
esp_partition_subtype_t otaPreviousPartitionSubtype = ESP_PARTITION_SUBTYPE_APP_OTA_MIN;
bool telemetryAnnouncementPending = false;
unsigned long telemetryAnnouncementAttemptAt = 0;

bool attachedPins[64] = {false};
int lastPinValues[64] = {0};

String deviceName;
String deviceId;
int freq;
int resolution;

unsigned long lastScheduleUpdate = 0;
unsigned long lastScheduleAttachRetry = 0;

// Fixed-size buffer holding the active schedule JSON; avoids dynamic heap usage
char currentSchedule[4096] = {0};

// Track last day we performed the daily 4 AM restart
int lastRestartDayOfYear = -1;

// Update the struct to include channel type
struct ChannelConfig {
    int pin;
    int currentValue;
    int8_t type;  // 'p' for pump, 'l' for light - using int8_t instead of char
};

// Change from std::map to std::vector since we no longer use channel names as keys
std::vector<ChannelConfig> activeChannels;

// Time management
struct TimeInfo {
    time_t lastSyncTime;      // Last time we synced with NTP or received a sync command
    time_t lastSavedTime;     // Last time we saved before reboot/power loss
    unsigned long lastMillis; // millis() value when we last saved the time
    bool timeInitialized;     // Whether time has been initialized
};
TimeInfo timeInfo;

// A valid EEPROM estimate is intentionally trusted for local failover. NTP or
// an explicit MQTT sync replaces it with fresher time when either is reachable.
bool scheduleTimeAvailableThisBoot = false;
bool scheduleTimeGateNoticePrinted = false;

struct FirmwareLastError {
    String code;
    String severity;
    String message;
    unsigned long sequence;
    bool active;
    time_t at;
};

struct ScheduleAttachResult {
    int attachFailedCount;
    int firstAttachFailedPin;
    int writeFailedCount;
    int firstWriteFailedPin;
};

FirmwareLastError lastError = {"", "", "", 0, false, 0};
bool spiffsAvailable = false;
bool spiffsReformattedThisBoot = false;
bool lastErrorPersistenceDirty = false;
bool lastErrorPersistedThisBoot = false;
bool lastErrorPersistenceFailed = false;
unsigned long lastErrorPersistenceAttemptAt = 0;
unsigned long lastErrorPersistenceSuccessAt = 0;
bool diagnosticAnnouncementPending = false;
bool diagnosticAnnouncementAttempted = false;
unsigned long diagnosticAnnouncementAttemptAt = 0;

bool timeCheckpointPending = false;
bool timeCheckpointImmediatePending = false;
bool freshTimeCheckpointCommittedThisBoot = false;
bool timeCheckpointFailed = false;
unsigned long timeCheckpointAttemptAt = 0;
unsigned long timeCheckpointSuccessAt = 0;

// EEPROM addresses for time management
#define TIME_INFO_ADDR 200    // Start address for TimeInfo struct

// Generate random ID if none exists
String generateId() {
	const char charset[] = "0123456789ABCDEF";
	String id = "";
	for (int i = 0; i < 8; i++) {
		id += charset[random(16)];
	}
	Serial.println("Generated new ID: " + id);
	return id;
}

// Read string from EEPROM
String readFromEEPROM(int startAddr, int maximumLength) {
    String data;
    int addr = startAddr;
    int endAddr = startAddr + maximumLength;
    if (startAddr < 0 || maximumLength < 1 || endAddr >= EEPROM_SIZE) {
        Serial.println("Invalid EEPROM read range");
        return data;
    }
    while (addr < endAddr) {
        char ch = EEPROM.read(addr);
        if (ch == '\0') {
            break;
        }
        // Only add printable characters
        if (ch >= 32 && ch <= 126) {  // ASCII printable characters
            data += ch;
        }
        addr++;
    }
    Serial.println("Read from EEPROM at address " + String(startAddr) + ": " + data);
    return data;
}

// Write string to EEPROM
bool writeToEEPROM(int startAddr, String data, int maximumLength) {
    int endAddr = startAddr + maximumLength;
    if (startAddr < 0 || maximumLength < 1 || endAddr >= EEPROM_SIZE) {
        Serial.println("Invalid EEPROM write range");
        return false;
    }
    // Sanitize the input string
    String sanitized = "";
    for (char c : data) {
        if (c >= 32 && c <= 126 && sanitized.length() < static_cast<size_t>(maximumLength)) {
            sanitized += c;
        }
    }
    
    // Write the data
    for (int i = 0; i < sanitized.length(); i++) {
        EEPROM.write(startAddr + i, sanitized[i]);
    }
    EEPROM.write(startAddr + sanitized.length(), '\0');
    
    // Commit and verify
    bool commitSuccess = EEPROM.commit();
    Serial.println("EEPROM commit " + String(commitSuccess ? "successful" : "failed"));
    
    if (commitSuccess) {
        // Add a small delay to ensure write is complete
        delay(10);
        
        // Verify the write
        String verification = "";
        for (int i = 0; i < sanitized.length(); i++) {
            char c = EEPROM.read(startAddr + i);
            verification += c;
        }
        
        if (verification == sanitized) {
            Serial.println("Wrote to EEPROM at address " + String(startAddr) + ": " + sanitized);
            return true;
        } else {
            Serial.println("EEPROM verification failed! Written: " + sanitized + ", Read: " + verification);
        }
    }
    return false;
}

void initializeEEPROM() {
	String storedName = readFromEEPROM(NAME_ADDR, NAME_MAX_LENGTH);
	if (storedName.length() == 0 || storedName[0] == 0xFF) {	// Check if EEPROM is empty or corrupted
		Serial.println("Initializing EEPROM with default device name");
		writeToEEPROM(NAME_ADDR, String(DEFAULT_DEVICE_NAME), NAME_MAX_LENGTH);
		deviceName = DEFAULT_DEVICE_NAME;
	} else {
		deviceName = storedName;
	}
	
	String storedId = readFromEEPROM(ID_ADDR, ID_MAX_LENGTH);
	if (storedId.length() == 0 || storedId[0] == 0xFF) {
		deviceId = generateId();
		writeToEEPROM(ID_ADDR, deviceId, ID_MAX_LENGTH);
	} else {
		deviceId = storedId;
	}

	// Read frequency from EEPROM
	EEPROM.get(FREQ_ADDR, freq);
	if (freq <= 0 || freq > 40000) {	// Validate frequency
		freq = DEFAULT_FREQ;
		EEPROM.put(FREQ_ADDR, freq);
		EEPROM.commit();
	}

	// Read resolution from EEPROM
	EEPROM.get(RES_ADDR, resolution);
	if (resolution < 1 || resolution > 16) {	// Validate resolution
		resolution = DEFAULT_RES;
		EEPROM.put(RES_ADDR, resolution);
		EEPROM.commit();
	}
	if (!isValidPwmConfiguration(freq, resolution)) {
		Serial.println("Persisted PWM frequency/resolution pair is unsupported; restoring defaults");
		freq = DEFAULT_FREQ;
		resolution = DEFAULT_RES;
		EEPROM.put(FREQ_ADDR, freq);
		EEPROM.put(RES_ADDR, resolution);
		EEPROM.commit();
	}
	
	Serial.println("Device Name: " + deviceName);
	Serial.println("Device ID: " + deviceId);
	Serial.println("Frequency: " + String(freq) + " Hz");
	Serial.println("Resolution: " + String(resolution) + " bits");
}

bool persistLastError() {
    if (!spiffsAvailable || lastError.code.length() == 0) {
        return false;
    }

    JsonDocument doc;
    doc["code"] = lastError.code;
    doc["severity"] = lastError.severity;
    doc["message"] = lastError.message;
    doc["sequence"] = lastError.sequence;
    doc["active"] = lastError.active;
    doc["at"] = static_cast<unsigned long>(lastError.at);

    String payload;
    serializeJson(doc, payload);
    const char* currentPath = "/last-error.json";
    const char* nextPath = "/last-error.next";
    if (SPIFFS.exists(nextPath) && !SPIFFS.remove(nextPath)) {
        Serial.println("Failed to remove stale last-error staging file");
        return false;
    }

    File file = SPIFFS.open(nextPath, "w");
    if (!file) {
        Serial.println("Failed to open last-error staging file");
        return false;
    }
    size_t written = file.print(payload);
    file.flush();
    file.close();
    if (written != payload.length()) {
        Serial.println("Failed to persist the complete last-error document");
        SPIFFS.remove(nextPath);
        return false;
    }
    if (SPIFFS.exists(currentPath) && !SPIFFS.remove(currentPath)) {
        Serial.println("Failed to replace the prior last-error document");
        SPIFFS.remove(nextPath);
        return false;
    }
    if (!SPIFFS.rename(nextPath, currentPath)) {
        Serial.println("Failed to publish the last-error document");
        return false;
    }
    return true;
}

bool isValidLastErrorCode(const String& code) {
    if (code.length() < 1 || code.length() > MAX_LAST_ERROR_CODE_LENGTH) {
        return false;
    }
    for (size_t index = 0; index < code.length(); index++) {
        char character = code[index];
        if (!(
            (character >= 'a' && character <= 'z') ||
            (character >= '0' && character <= '9') ||
            character == '_'
        )) {
            return false;
        }
    }
    return true;
}

void serviceLastErrorPersistence() {
    if (!lastErrorPersistenceDirty) {
        return;
    }
    unsigned long currentMillis = millis();
    bool due = false;
    if (lastErrorPersistenceFailed) {
        due = currentMillis - lastErrorPersistenceAttemptAt >=
            PERSISTENCE_RETRY_INTERVAL_MS;
    } else if (!lastErrorPersistedThisBoot) {
        due = true;
    } else {
        due = currentMillis - lastErrorPersistenceSuccessAt >=
            DIAGNOSTIC_PERSIST_INTERVAL_MS;
    }
    if (!due) {
        return;
    }

    lastErrorPersistenceAttemptAt = currentMillis;
    if (persistLastError()) {
        lastErrorPersistenceDirty = false;
        lastErrorPersistedThisBoot = true;
        lastErrorPersistenceFailed = false;
        lastErrorPersistenceSuccessAt = currentMillis;
    } else {
        lastErrorPersistenceFailed = true;
    }
}

void queueLastErrorTransition() {
    lastErrorPersistenceDirty = true;
    diagnosticAnnouncementPending = true;
    diagnosticAnnouncementAttempted = false;
    serviceLastErrorPersistence();
}

void loadLastError() {
    const char* currentPath = "/last-error.json";
    const char* nextPath = "/last-error.next";
    if (!SPIFFS.exists(currentPath) && SPIFFS.exists(nextPath)) {
        if (!SPIFFS.rename(nextPath, currentPath)) {
            Serial.println("Could not recover the staged last-error document");
        }
    }
    if (!SPIFFS.exists(currentPath)) {
        return;
    }

    File file = SPIFFS.open(currentPath, "r");
    if (!file) {
        Serial.println("Failed to open the persisted last-error document");
        return;
    }
    JsonDocument doc;
    DeserializationError error = deserializeJson(doc, file);
    file.close();
    JsonVariant codeValue = doc["code"];
    JsonVariant severityValue = doc["severity"];
    JsonVariant messageValue = doc["message"];
    JsonVariant sequenceValue = doc["sequence"];
    JsonVariant activeValue = doc["active"];
    JsonVariant atValue = doc["at"];
    if (error || !codeValue.is<const char*>() ||
        !severityValue.is<const char*>() || !messageValue.is<const char*>() ||
        !sequenceValue.is<unsigned long>() || !activeValue.is<bool>() ||
        !atValue.is<unsigned long>()) {
        Serial.println("Persisted last-error document is invalid; ignoring it");
        return;
    }

    String code = codeValue.as<String>();
    String severity = severityValue.as<String>();
    String message = messageValue.as<String>();
    unsigned long sequence = sequenceValue.as<unsigned long>();
    unsigned long at = atValue.as<unsigned long>();
    if (!isValidLastErrorCode(code) ||
        (severity != "warning" && severity != "error") ||
        message.length() < 1 || message.length() > MAX_LAST_ERROR_MESSAGE_LENGTH ||
        sequence < 1 || at > MAX_SYNC_UNIX_TIME) {
        Serial.println("Persisted last-error fields are invalid; ignoring them");
        return;
    }

    lastError = {
        code,
        severity,
        message,
        sequence,
        activeValue.as<bool>(),
        static_cast<time_t>(at)
    };
    Serial.println("Loaded persisted firmware diagnostic " + lastError.code);
}

void recordLastError(
    const String& code,
    const String& severity,
    const String& message
) {
    String boundedMessage = message.substring(0, MAX_LAST_ERROR_MESSAGE_LENGTH);
    if (!isValidLastErrorCode(code) || boundedMessage.length() == 0 ||
        (severity != "warning" && severity != "error")) {
        Serial.println("Refusing to record an invalid firmware diagnostic");
        return;
    }
    if (lastError.code == code && lastError.severity == severity &&
        lastError.message == boundedMessage && lastError.active) {
        return;
    }

    unsigned long nextSequence =
        lastError.sequence == ULONG_MAX ? 1 : lastError.sequence + 1;
    time_t diagnosticTime = timeInfo.timeInitialized ? getCurrentTime() : 0;
    if (diagnosticTime < 0 ||
        static_cast<unsigned long>(diagnosticTime) > MAX_SYNC_UNIX_TIME) {
        diagnosticTime = 0;
    }
    lastError = {
        code,
        severity,
        boundedMessage,
        nextSequence,
        true,
        diagnosticTime
    };
    Serial.println(
        "Firmware diagnostic " + lastError.code + ": " + lastError.message
    );
    queueLastErrorTransition();
}

void resolveLastError(const String& code) {
    if (lastError.code != code || !lastError.active) {
        return;
    }
    lastError.active = false;
    lastError.sequence =
        lastError.sequence == ULONG_MAX ? 1 : lastError.sequence + 1;
    Serial.println("Firmware diagnostic resolved: " + lastError.code);
    queueLastErrorTransition();
}

void resolveLastErrorForPin(const String& code, int pin) {
    String expectedMessage;
    if (code == "pin_attach_failed") {
        expectedMessage = "LEDC attach failed on pin " + String(pin);
    } else if (code == "pin_write_failed") {
        expectedMessage = "LEDC write failed on pin " + String(pin);
    } else if (code == "pin_detach_failed") {
        expectedMessage = "LEDC detach failed on pin " + String(pin);
    } else {
        return;
    }
    if (lastError.code == code && lastError.active &&
        lastError.message == expectedMessage) {
        resolveLastError(code);
    }
}

bool storeSchedule(const String& schedule) {
    if (!spiffsAvailable) {
        Serial.println("Cannot save schedule because SPIFFS is unavailable");
        return false;
    }
    const char* currentPath = "/schedule.json";
    const char* nextPath = "/schedule.next";
    const char* previousPath = "/schedule.previous";
    if (SPIFFS.exists(nextPath) && !SPIFFS.remove(nextPath)) {
        Serial.println("Failed to remove stale schedule staging file");
        return false;
    }

    File file = SPIFFS.open(nextPath, "w");
    if (!file) {
        Serial.println("Failed to open schedule file for writing");
        return false;
    }

    size_t written = file.print(schedule);
    file.flush();
    file.close();
    if (written != schedule.length()) {
        Serial.println("Schedule write failed");
        SPIFFS.remove(nextPath);
        return false;
    }

    bool hadCurrent = SPIFFS.exists(currentPath);
    if (hadCurrent) {
        if (SPIFFS.exists(previousPath) && !SPIFFS.remove(previousPath)) {
            Serial.println("Failed to remove stale previous schedule");
            SPIFFS.remove(nextPath);
            return false;
        }
        if (!SPIFFS.rename(currentPath, previousPath)) {
            Serial.println("Failed to stage the prior schedule for replacement");
            SPIFFS.remove(nextPath);
            return false;
        }
    }
    if (!SPIFFS.rename(nextPath, currentPath)) {
        Serial.println("Failed to publish the replacement schedule");
        bool restoredPrior = hadCurrent && SPIFFS.rename(previousPath, currentPath);
        if (hadCurrent && !restoredPrior) {
            Serial.println("Failed to restore the prior schedule file; preserving recovery marker");
        } else {
            SPIFFS.remove(nextPath);
        }
        return false;
    }
    if (SPIFFS.exists(previousPath) && !SPIFFS.remove(previousPath)) {
        Serial.println("Replacement succeeded but prior schedule cleanup failed");
    }
    Serial.println("Schedule saved to SPIFFS, size: " + String(schedule.length()) + " bytes");
    return true;
}

String loadSchedule() {
    if (!spiffsAvailable) {
        Serial.println("Cannot load schedule because SPIFFS is unavailable");
        return "";
    }
    const char* schedulePath = "/schedule.json";
    if (!SPIFFS.exists(schedulePath)) {
        if (!SPIFFS.exists("/schedule.previous") || !SPIFFS.exists("/schedule.next")) {
            Serial.println("No saved schedule found");
            return "";
        }
        if (SPIFFS.rename("/schedule.previous", schedulePath)) {
            Serial.println("Recovered prior schedule after interrupted replacement");
        } else {
            schedulePath = "/schedule.previous";
            Serial.println("Using prior schedule after interrupted replacement");
        }
    }

    File file = SPIFFS.open(schedulePath, "r");
    if (!file) {
        Serial.println("Failed to open schedule file for reading");
        return "";
    }
    
    // Read the schedule from the file
    String schedule = "";
    while (file.available() && schedule.length() < sizeof(currentSchedule) - 1) {
        schedule += (char)file.read();
    }
    if (file.available()) {
        file.close();
        Serial.println("Saved schedule exceeds the firmware buffer; refusing restore");
        return "";
    }
    
    file.close();
    Serial.println("Schedule loaded from SPIFFS, size: " + String(schedule.length()) + " bytes");
    return schedule;
}

int getScheduledValue(JsonArray& links, int currentMinute) {
    for (JsonVariant link : links) {
        int sourceTime = link["s"]["t"].as<int>();
        int targetTime = link["d"]["t"].as<int>();
        
        if (currentMinute >= sourceTime && currentMinute <= targetTime) {
            int sourcePercentage = link["s"]["p"].as<int>();
            int targetPercentage = link["d"]["p"].as<int>();
            
            if (targetTime == sourceTime) return sourcePercentage;
            
            float progress = (float)(currentMinute - sourceTime) / (targetTime - sourceTime);
            return sourcePercentage + (targetPercentage - sourcePercentage) * progress;
        }
    }
    return 0;
}

bool pinAppearsIn(const int* pins, size_t count, int pin) {
    for (size_t index = 0; index < count; index++) {
        if (pins[index] == pin) {
            return true;
        }
    }
    return false;
}

bool isAllowedPwmPin(int pin) {
    // GPIO12 is an ESP32 flash-voltage strapping pin. It is intentionally
    // allowed because the deployed aquarium driver wiring is proven not to
    // pull it high during reset. Replacement circuits must preserve that.
    return pinAppearsIn(
        ALLOWED_PWM_PINS,
        sizeof(ALLOWED_PWM_PINS) / sizeof(ALLOWED_PWM_PINS[0]),
        pin
    );
}

bool isAllowedAnalogInputPin(int pin) {
    return pinAppearsIn(
        ALLOWED_ANALOG_INPUT_PINS,
        sizeof(ALLOWED_ANALOG_INPUT_PINS) /
            sizeof(ALLOWED_ANALOG_INPUT_PINS[0]),
        pin
    );
}

bool isValidDeviceName(const String& name) {
    if (name.length() < 1 || name.length() > static_cast<size_t>(NAME_MAX_LENGTH)) {
        return false;
    }
    for (size_t index = 0; index < name.length(); index++) {
        char character = name[index];
        if (character < 33 || character > 126) {
            return false;
        }
    }
    return true;
}

bool isValidPwmConfiguration(int frequency, int pwmResolution) {
    if (frequency < 1 || frequency > 40000 || pwmResolution < 1 || pwmResolution > 16) {
        return false;
    }
    return static_cast<uint64_t>(frequency) * (1ULL << pwmResolution) <= LEDC_SOURCE_CLOCK_HZ;
}

uint32_t pwmMaximumForResolution(int pwmResolution) {
    return (1UL << pwmResolution) - 1UL;
}

int rescalePwmValue(int value, int sourceResolution, int targetResolution) {
    const uint32_t sourceMaximum = pwmMaximumForResolution(sourceResolution);
    const uint32_t targetMaximum = pwmMaximumForResolution(targetResolution);
    return static_cast<int>(
        (static_cast<uint64_t>(value) * targetMaximum) / sourceMaximum
    );
}

int scaleNormalizedPwmValue(int value, int targetResolution) {
    return rescalePwmValue(value, 8, targetResolution);
}

bool reattachConfiguredPins(
    int targetFrequency,
    int targetResolution,
    int rollbackFrequency,
    int rollbackResolution
) {
    bool wasAttached[MAX_PIN + 1] = {false};
    int restoreValues[MAX_PIN + 1] = {0};
    bool detachFailed = false;
    for (int pin = MIN_PIN; pin <= MAX_PIN; pin++) {
        wasAttached[pin] = attachedPins[pin];
        restoreValues[pin] = lastPinValues[pin];
        if (wasAttached[pin]) {
            if (ledcDetach(pin)) {
                attachedPins[pin] = false;
                resolveLastErrorForPin("pin_detach_failed", pin);
            } else {
                detachFailed = true;
                recordLastError(
                    "pin_detach_failed",
                    "error",
                    "LEDC detach failed on pin " + String(pin)
                );
            }
        }
    }

    bool targetFailed = detachFailed;
    if (!targetFailed) {
        for (int pin = MIN_PIN; pin <= MAX_PIN; pin++) {
            if (!wasAttached[pin]) {
                continue;
            }
            const int rescaledValue = rescalePwmValue(
                restoreValues[pin],
                rollbackResolution,
                targetResolution
            );
            if (!ledcAttach(pin, targetFrequency, targetResolution)) {
                recordLastError(
                    "pin_attach_failed",
                    "error",
                    "LEDC attach failed on pin " + String(pin)
                );
                targetFailed = true;
                break;
            }
            attachedPins[pin] = true;
            resolveLastErrorForPin("pin_attach_failed", pin);
            if (!ledcWrite(pin, rescaledValue)) {
                recordLastError(
                    "pin_write_failed",
                    "error",
                    "LEDC write failed on pin " + String(pin)
                );
                targetFailed = true;
                break;
            }
            resolveLastErrorForPin("pin_write_failed", pin);
            lastPinValues[pin] = rescaledValue;
            auto pinState = pinStates.find(pin);
            if (pinState != pinStates.end()) {
                pinState->second.lastValue = rescaledValue;
            }
        }
    }
    if (!targetFailed) {
        for (auto& channel : activeChannels) {
            channel.currentValue = -1;
        }
        queueOutputAnnouncement();
        return true;
    }

    Serial.println("LEDC configuration failed; rolling every attached pin back");
    for (int pin = MIN_PIN; pin <= MAX_PIN; pin++) {
        if (attachedPins[pin]) {
            if (ledcDetach(pin)) {
                attachedPins[pin] = false;
                resolveLastErrorForPin("pin_detach_failed", pin);
            } else {
                recordLastError(
                    "pin_detach_failed",
                    "error",
                    "LEDC detach failed on pin " + String(pin)
                );
            }
        }
    }
    for (int pin = MIN_PIN; pin <= MAX_PIN; pin++) {
        if (!wasAttached[pin] || attachedPins[pin]) {
            continue;
        }
        if (ledcAttach(pin, rollbackFrequency, rollbackResolution)) {
            attachedPins[pin] = true;
            resolveLastErrorForPin("pin_attach_failed", pin);
            if (ledcWrite(pin, restoreValues[pin])) {
                lastPinValues[pin] = restoreValues[pin];
                auto restoredPinState = pinStates.find(pin);
                if (restoredPinState != pinStates.end()) {
                    restoredPinState->second.lastValue = restoreValues[pin];
                }
                resolveLastErrorForPin("pin_write_failed", pin);
                continue;
            }
            recordLastError(
                "pin_write_failed",
                "error",
                "LEDC write failed on pin " + String(pin)
            );
            if (!ledcDetach(pin)) {
                recordLastError(
                    "pin_detach_failed",
                    "error",
                    "LEDC detach failed on pin " + String(pin)
                );
                continue;
            }
            attachedPins[pin] = false;
            resolveLastErrorForPin("pin_detach_failed", pin);
        } else {
            recordLastError(
                "pin_attach_failed",
                "error",
                "LEDC attach failed on pin " + String(pin)
            );
        }

        pinMode(pin, OUTPUT);
        digitalWrite(pin, LOW);
        lastPinValues[pin] = 0;
        auto failedPinState = pinStates.find(pin);
        if (failedPinState != pinStates.end()) {
            failedPinState->second.lastValue = 0;
            failedPinState->second.isOverwritten = false;
            failedPinState->second.overwriteStartedAt = 0;
        }
        for (auto& channel : activeChannels) {
            if (channel.pin == pin) {
                channel.currentValue = -1;
                break;
            }
        }
        Serial.println("LEDC rollback failed for pin " + String(pin) + "; output forced off");
    }
    queueOutputAnnouncement();
    return false;
}

bool parseBoundedDecimal(const String& value, int maximum, int& parsed) {
    if (value.length() == 0) {
        return false;
    }
    int result = 0;
    for (size_t index = 0; index < value.length(); index++) {
        char character = value[index];
        if (character < '0' || character > '9') {
            return false;
        }
        int digit = character - '0';
        if (result > (maximum - digit) / 10) {
            return false;
        }
        result = result * 10 + digit;
    }
    parsed = result;
    return true;
}

bool isCommandWhitespace(char character) {
    return character == ' ' || character == '\t' || character == '\r' || character == '\n';
}

void skipCommandWhitespace(const char*& cursor) {
    while (isCommandWhitespace(*cursor)) {
        cursor++;
    }
}

bool parseCommandInteger(const char*& cursor, int& parsed) {
    skipCommandWhitespace(cursor);
    if (*cursor == '\0') {
        return false;
    }
    errno = 0;
    char* end = nullptr;
    long result = strtol(cursor, &end, 10);
    if (end == cursor || errno == ERANGE || result < INT_MIN || result > INT_MAX) {
        return false;
    }
    if (*end != '\0' && !isCommandWhitespace(*end)) {
        return false;
    }
    parsed = static_cast<int>(result);
    cursor = end;
    return true;
}

bool parseSetArguments(const String& value, int& pin, int& output, int& overwrite) {
    const char* cursor = value.c_str();
    if (!parseCommandInteger(cursor, pin) || !parseCommandInteger(cursor, output) ||
        !parseCommandInteger(cursor, overwrite)) {
        return false;
    }
    skipCommandWhitespace(cursor);
    return *cursor == '\0';
}

bool parseEditArguments(
    const String& value,
    String& deviceNameValue,
    int& frequencyValue,
    int& resolutionValue
) {
    const char* cursor = value.c_str();
    skipCommandWhitespace(cursor);
    const char* nameStart = cursor;
    while (*cursor != '\0' && !isCommandWhitespace(*cursor)) {
        cursor++;
    }
    size_t nameLength = static_cast<size_t>(cursor - nameStart);
    if (nameLength < 1 || nameLength > static_cast<size_t>(NAME_MAX_LENGTH)) {
        return false;
    }
    deviceNameValue = "";
    for (size_t index = 0; index < nameLength; index++) {
        deviceNameValue += nameStart[index];
    }
    if (!parseCommandInteger(cursor, frequencyValue) ||
        !parseCommandInteger(cursor, resolutionValue)) {
        return false;
    }
    skipCommandWhitespace(cursor);
    return *cursor == '\0';
}

bool isValidRequestId(const String& requestId) {
    if (requestId.length() < 1 || requestId.length() > MAX_REQUEST_ID_LENGTH) {
        return false;
    }
    for (size_t index = 0; index < requestId.length(); index++) {
        char character = requestId[index];
        bool valid =
            (character >= 'A' && character <= 'Z') ||
            (character >= 'a' && character <= 'z') ||
            (character >= '0' && character <= '9') ||
            character == '_' || character == '-';
        if (!valid) {
            return false;
        }
    }
    return true;
}

bool unwrapRequestEnvelope(String& message, String& requestId) {
    requestId = "";
    if (!message.startsWith("request:")) {
        return true;
    }
    int separator = message.indexOf('|', 8);
    if (separator < 0) {
        return false;
    }
    requestId = message.substring(8, separator);
    if (!isValidRequestId(requestId)) {
        return false;
    }
    message = message.substring(separator + 1);
    return message.length() > 0;
}

bool schedulePointIsValid(JsonVariant point) {
    if (!point.is<JsonObject>()) {
        return false;
    }
    JsonVariant minuteValue = point["t"];
    JsonVariant percentageValue = point["p"];
    return minuteValue.is<int>() && minuteValue.as<int>() >= 0 &&
        minuteValue.as<int>() <= 1439 && percentageValue.is<int>() &&
        percentageValue.as<int>() >= 0 && percentageValue.as<int>() <= 100;
}

bool schedulePinsAreValid(JsonDocument& doc) {
    JsonVariant channelsValue = doc["c"];
    JsonVariant syncTimeValue = doc["syncTime"];
    if (!channelsValue.is<JsonArray>() || !syncTimeValue.is<unsigned long>() ||
        syncTimeValue.as<unsigned long>() < 1 ||
        syncTimeValue.as<unsigned long>() > MAX_SYNC_UNIX_TIME) {
        return false;
    }
    JsonArray channels = channelsValue.as<JsonArray>();
    if (channels.size() > static_cast<size_t>(MAX_PIN + 1)) {
        return false;
    }
    bool seenPins[MAX_PIN + 1] = {false};
    for (JsonVariant channel : channels) {
        if (!channel.is<JsonObject>()) {
            return false;
        }
        JsonVariant pinValue = channel["o"];
        if (!pinValue.is<int>() || !isAllowedPwmPin(pinValue.as<int>())) {
            return false;
        }
        JsonVariant typeValue = channel["t"];
        if (!typeValue.is<int>() ||
            (typeValue.as<int>() != 108 && typeValue.as<int>() != 112)) {
            return false;
        }
        JsonVariant linksValue = channel["l"];
        if (!linksValue.is<JsonArray>()) {
            return false;
        }
        JsonArray links = linksValue.as<JsonArray>();
        for (JsonVariant link : links) {
            if (!link.is<JsonObject>() || !schedulePointIsValid(link["s"]) ||
                !schedulePointIsValid(link["d"])) {
                return false;
            }
        }
        int pin = pinValue.as<int>();
        if (seenPins[pin]) {
            return false;
        }
        seenPins[pin] = true;
    }
    return true;
}

void rollbackNewSchedulePins(bool newlyAttached[MAX_PIN + 1]) {
    for (int pin = MIN_PIN; pin <= MAX_PIN; pin++) {
        if (!newlyAttached[pin]) {
            continue;
        }
        if (!ledcWrite(pin, 0)) {
            recordLastError(
                "pin_write_failed",
                "error",
                "LEDC write failed on pin " + String(pin)
            );
        } else {
            lastPinValues[pin] = 0;
            resolveLastErrorForPin("pin_write_failed", pin);
        }
        if (!ledcDetach(pin)) {
            recordLastError(
                "pin_detach_failed",
                "error",
                "LEDC detach failed on pin " + String(pin)
            );
            continue;
        }
        attachedPins[pin] = false;
        resolveLastErrorForPin("pin_detach_failed", pin);
        pinMode(pin, OUTPUT);
        digitalWrite(pin, LOW);
        lastPinValues[pin] = 0;
    }
    queueOutputAnnouncement();
}

ScheduleAttachResult attachMissingSchedulePins(
    JsonArray& channels,
    bool newlyAttached[MAX_PIN + 1]
) {
    ScheduleAttachResult result = {0, -1, 0, -1};
    for (int pin = MIN_PIN; pin <= MAX_PIN; pin++) {
        newlyAttached[pin] = false;
    }
    for (JsonVariant channel : channels) {
        int pin = channel["o"].as<int>();
        if (attachedPins[pin]) {
            continue;
        }
        pinMode(pin, OUTPUT);
        digitalWrite(pin, LOW);
        if (!ledcAttach(pin, freq, resolution)) {
            Serial.println("Failed to attach scheduled pin " + String(pin));
            auto failedPinState = pinStates.find(pin);
            if (failedPinState != pinStates.end()) {
                failedPinState->second.lastValue = 0;
                failedPinState->second.isOverwritten = false;
                failedPinState->second.overwriteStartedAt = 0;
            }
            if (result.firstAttachFailedPin < 0) {
                result.firstAttachFailedPin = pin;
            }
            result.attachFailedCount++;
            continue;
        }
        attachedPins[pin] = true;
        newlyAttached[pin] = true;
        resolveLastErrorForPin("pin_attach_failed", pin);
        if (!ledcWrite(pin, 0)) {
            Serial.println("Failed to initialize scheduled pin " + String(pin));
            if (!ledcDetach(pin)) {
                recordLastError(
                    "pin_detach_failed",
                    "error",
                    "LEDC detach failed on pin " + String(pin)
                );
            } else {
                attachedPins[pin] = false;
                newlyAttached[pin] = false;
                resolveLastErrorForPin("pin_detach_failed", pin);
                pinMode(pin, OUTPUT);
                digitalWrite(pin, LOW);
            }
            if (result.firstWriteFailedPin < 0) {
                result.firstWriteFailedPin = pin;
            }
            result.writeFailedCount++;
            continue;
        }
        lastPinValues[pin] = 0;
        resolveLastErrorForPin("pin_write_failed", pin);
    }
    queueOutputAnnouncement();
    return result;
}

void reportScheduleAttachResult(const ScheduleAttachResult& result) {
    if (result.attachFailedCount > 0) {
        recordLastError(
            "pin_attach_failed",
            "error",
            "LEDC attach failed on pin " + String(result.firstAttachFailedPin)
        );
        return;
    }
    if (result.writeFailedCount > 0) {
        recordLastError(
            "pin_write_failed",
            "error",
            "LEDC write failed on pin " + String(result.firstWriteFailedPin)
        );
        return;
    }
}

void turnOffRemovedSchedulePins(JsonArray& nextChannels) {
    for (const auto& previousChannel : activeChannels) {
        bool retained = false;
        for (JsonVariant nextChannel : nextChannels) {
            if (nextChannel["o"].as<int>() == previousChannel.pin) {
                retained = true;
                break;
            }
        }
        if (retained) {
            continue;
        }

        int pin = previousChannel.pin;
        if (attachedPins[pin]) {
            if (!ledcWrite(pin, 0)) {
                recordLastError(
                    "pin_write_failed",
                    "error",
                    "LEDC write failed on pin " + String(pin)
                );
            } else {
                resolveLastErrorForPin("pin_write_failed", pin);
            }
            if (!ledcDetach(pin)) {
                recordLastError(
                    "pin_detach_failed",
                    "error",
                    "LEDC detach failed on pin " + String(pin)
                );
            } else {
                attachedPins[pin] = false;
                resolveLastErrorForPin("pin_detach_failed", pin);
            }
        }
        if (!attachedPins[pin]) {
            pinMode(pin, OUTPUT);
            digitalWrite(pin, LOW);
            lastPinValues[pin] = 0;
            pinStates.erase(pin);
        }
        Serial.println(
            "Replacement schedule removed and detached pin " + String(pin)
        );
    }
    queueOutputAnnouncement();
}

bool parseSyncTime(const String& value, unsigned long& parsed) {
    if (value.length() == 0) {
        return false;
    }
    unsigned long result = 0;
    for (size_t index = 0; index < value.length(); index++) {
        char character = value[index];
        if (character < '0' || character > '9') {
            return false;
        }
        unsigned long digit = static_cast<unsigned long>(character - '0');
        if (result > (MAX_SYNC_UNIX_TIME - digit) / 10UL) {
            return false;
        }
        result = result * 10UL + digit;
    }
    if (result < static_cast<unsigned long>(MIN_VALID_UNIX_TIME)) {
        return false;
    }
    parsed = result;
    return true;
}

void processSchedule(const String& schedule) {
    if (schedule.length() >= sizeof(currentSchedule)) {
        Serial.println("Schedule exceeds the firmware buffer; keeping outputs safely unchanged");
        return;
    }
    JsonDocument doc;
    DeserializationError error = deserializeJson(doc, schedule);
    
    if (error) {
        Serial.println("Failed to parse schedule");
        return;
    }
    if (!schedulePinsAreValid(doc)) {
        Serial.println("Schedule structure is invalid; keeping outputs safely unchanged");
        return;
    }

    JsonArray channels = doc["c"].as<JsonArray>();
    bool newlyAttached[MAX_PIN + 1] = {false};
    ScheduleAttachResult attachResult =
        attachMissingSchedulePins(channels, newlyAttached);

    strlcpy(currentSchedule, schedule.c_str(), sizeof(currentSchedule));
    turnOffRemovedSchedulePins(channels);

    // Clear existing channel configurations
    activeChannels.clear();
    
    // Setup channels
    for (JsonVariant channel : channels) {
        int pin = channel["o"].as<int>();
        // Use as<int>() instead of as<char>() and then cast to int8_t
        int8_t type = (int8_t)channel["t"].as<int>();
        
        // Initialize channel
        // -1 is outside the valid 0-100% range and forces the first schedule
        // loop to write the physical pin, including a zero target.
        activeChannels.push_back({pin, -1, type});
        
        // Successfully attached pins were initialized low. Failed pins remain
        // part of the schedule and are retried without blocking other outputs.
        if (attachedPins[pin]) {
            lastPinValues[pin] = 0;
        }
    }
    lastScheduleAttachRetry = millis();
    reportScheduleAttachResult(attachResult);
    queueOutputAnnouncement();
}

void retryMissingSchedulePins() {
    ScheduleAttachResult result = {0, -1, 0, -1};
    for (auto& channel : activeChannels) {
        int pin = channel.pin;
        if (attachedPins[pin]) {
            continue;
        }

        pinMode(pin, OUTPUT);
        digitalWrite(pin, LOW);
        if (!ledcAttach(pin, freq, resolution)) {
            if (result.firstAttachFailedPin < 0) {
                result.firstAttachFailedPin = pin;
            }
            result.attachFailedCount++;
            continue;
        }
        attachedPins[pin] = true;
        resolveLastErrorForPin("pin_attach_failed", pin);
        if (!ledcWrite(pin, 0)) {
            if (ledcDetach(pin)) {
                attachedPins[pin] = false;
                resolveLastErrorForPin("pin_detach_failed", pin);
                pinMode(pin, OUTPUT);
                digitalWrite(pin, LOW);
            } else {
                recordLastError(
                    "pin_detach_failed",
                    "error",
                    "LEDC detach failed on pin " + String(pin)
                );
            }
            if (result.firstWriteFailedPin < 0) {
                result.firstWriteFailedPin = pin;
            }
            result.writeFailedCount++;
            continue;
        }

        lastPinValues[pin] = 0;
        channel.currentValue = -1;
        resolveLastErrorForPin("pin_write_failed", pin);
        Serial.println("Recovered scheduled pin " + String(pin));
    }
    reportScheduleAttachResult(result);
    queueOutputAnnouncement();
}

const int MAX_RETRIES = 3;
const int RETRY_DELAY_MS = 1000;
bool publishWithRetry(const char* topic, const char* payload) {
    int attempt = 0;
    while (attempt < MAX_RETRIES) {
        if (client.publish(topic, payload)) {
            Serial.printf("Publish succeeded on attempt %d\n", attempt + 1);
            return true;  // Success
        } else {
            Serial.printf("Publish failed on attempt %d, retrying...\n", attempt + 1);
            attempt++;
            delay(RETRY_DELAY_MS);
            client.loop();  // Allow MQTT client to process incoming/outgoing packets
        }
    }

    Serial.println("Publish failed after maximum retries, disconnecting MQTT client");
    client.disconnect();  // Force reconnection on next loop iteration
    return false;         // Failed after retries
}


bool loadNetworkConfiguration() {
    Preferences preferences;
    if (!preferences.begin("aquarium", false)) {
        Serial.println("Could not open persistent network configuration");
        return false;
    }

    if (!preferences.getBool("cfgReady", false)) {
        Serial.println("Migrating compile-time network settings to persistent storage");
        bool stored =
            preferences.putString("wifiSsid", ssid) > 0 &&
            preferences.putString("wifiPass", password) > 0 &&
            preferences.putString("mqttHost", mqtt_server) > 0 &&
            preferences.putUShort("mqttPort", mqtt_port) > 0 &&
            preferences.putString("ntpHost", ntp_server) > 0;
        if (strlen(mqtt_username) > 0) {
            stored = preferences.putString("mqttUser", mqtt_username) > 0 && stored;
        } else {
            preferences.remove("mqttUser");
        }
        if (strlen(mqtt_password) > 0) {
            stored = preferences.putString("mqttPass", mqtt_password) > 0 && stored;
        } else {
            preferences.remove("mqttPass");
        }
        if (!stored || preferences.putBool("cfgReady", true) == 0) {
            preferences.end();
            Serial.println("Could not persist the bootstrap network configuration");
            return false;
        }
    }

    configuredWifiSsid = preferences.getString("wifiSsid", "");
    configuredWifiPassword = preferences.getString("wifiPass", "");
    configuredMqttServer = preferences.getString("mqttHost", "");
    configuredMqttPort = preferences.getUShort("mqttPort", 0);
    configuredMqttUsername = preferences.getString("mqttUser", "");
    configuredMqttPassword = preferences.getString("mqttPass", "");
    configuredNtpServer = preferences.getString("ntpHost", "");
    preferences.end();

    const bool credentialsPaired =
        configuredMqttUsername.isEmpty() == configuredMqttPassword.isEmpty();
    if (
        configuredWifiSsid.isEmpty() || configuredMqttServer.isEmpty() ||
        configuredMqttPort == 0 || configuredNtpServer.isEmpty() ||
        !credentialsPaired
    ) {
        Serial.println("Persistent network configuration is incomplete");
        return false;
    }
    Serial.println("Persistent network configuration loaded");
    return true;
}

void clearOtaMarker(Preferences& preferences) {
    preferences.remove("otaPending");
    preferences.remove("otaTarget");
    preferences.remove("otaPrev");
    preferences.remove("otaBoots");
}

bool selectPreviousOtaPartition() {
    const esp_partition_t* previous = esp_partition_find_first(
        ESP_PARTITION_TYPE_APP,
        otaPreviousPartitionSubtype,
        nullptr
    );
    if (previous == nullptr) {
        Serial.println("Previous OTA partition was not found");
        return false;
    }
    esp_err_t result = esp_ota_set_boot_partition(previous);
    if (result != ESP_OK) {
        Serial.println("Could not select the previous OTA partition: " + String(result));
        return false;
    }
    return true;
}

void rollbackOta(const String& reason) {
    Serial.println("OTA probation failed: " + reason);
    otaReport.status = "rolling_back";
    otaReport.error = reason;
    otaReport.progress = 0;
    if (client.connected()) {
        announcePresence();
    }
    if (!selectPreviousOtaPartition()) {
        otaReport.status = "failed";
        otaReport.error = "rollback_partition_unavailable";
        telemetryAnnouncementPending = true;
        return;
    }
    Serial.println("Rebooting into the previous firmware partition");
    Serial.flush();
    delay(250);
    ESP.restart();
}

void initializeOtaBootState() {
    Preferences preferences;
    if (!preferences.begin("aquarium", false)) {
        Serial.println("Could not inspect OTA probation state");
        return;
    }
    if (!preferences.getBool("otaPending", false)) {
        preferences.end();
        return;
    }

    const String targetVersion = preferences.getString("otaTarget", "");
    otaPreviousPartitionSubtype = static_cast<esp_partition_subtype_t>(
        preferences.getUChar(
            "otaPrev",
            static_cast<uint8_t>(ESP_PARTITION_SUBTYPE_APP_OTA_MIN)
        )
    );
    if (targetVersion != VERSION) {
        clearOtaMarker(preferences);
        preferences.end();
        otaReport = {"failed", targetVersion, "rolled_back", 0};
        telemetryAnnouncementPending = true;
        Serial.println("Previous firmware restored after OTA probation failure");
        return;
    }

    unsigned int probationBoots = preferences.getUInt("otaBoots", 0) + 1;
    preferences.putUInt("otaBoots", probationBoots);
    preferences.end();
    otaReport = {"probation", targetVersion, "", 100};
    otaProbationActive = true;
    otaProbationStartedAt = millis();
    telemetryAnnouncementPending = true;
    Serial.println(
        "OTA probation boot " + String(probationBoots) + " of " +
        String(OTA_MAX_PROBATION_BOOTS)
    );
    if (probationBoots >= OTA_MAX_PROBATION_BOOTS) {
        rollbackOta("boot_loop_detected");
    }
}

void confirmOtaProbation() {
    if (!otaProbationActive) {
        return;
    }
    esp_ota_mark_app_valid_cancel_rollback();
    Preferences preferences;
    if (preferences.begin("aquarium", false)) {
        clearOtaMarker(preferences);
        preferences.end();
    }
    otaProbationActive = false;
    otaReport.status = "succeeded";
    otaReport.error = "";
    otaReport.progress = 100;
    telemetryAnnouncementPending = true;
    Serial.println("OTA probation succeeded after MQTT announcement");
}

void serviceOtaProbation() {
    if (
        otaProbationActive &&
        millis() - otaProbationStartedAt >= OTA_PROBATION_TIMEOUT_MS
    ) {
        rollbackOta("mqtt_confirmation_timeout");
    }
}

bool isValidOtaToken(const String& value, size_t maximumLength) {
    if (value.isEmpty() || value.length() > maximumLength) {
        return false;
    }
    for (size_t index = 0; index < value.length(); index++) {
        const char character = value[index];
        if (!(
            (character >= 'a' && character <= 'z') ||
            (character >= 'A' && character <= 'Z') ||
            (character >= '0' && character <= '9') ||
            character == '.' || character == '-' || character == '_'
        )) {
            return false;
        }
    }
    return true;
}

bool isValidSha256(const String& value) {
    if (value.length() != 64) {
        return false;
    }
    for (size_t index = 0; index < value.length(); index++) {
        const char character = value[index];
        if (!(
            (character >= '0' && character <= '9') ||
            (character >= 'a' && character <= 'f') ||
            (character >= 'A' && character <= 'F')
        )) {
            return false;
        }
    }
    return true;
}

bool parseOtaArguments(const String& args, OtaRequest& request) {
    int firstSpace = args.indexOf(' ');
    int secondSpace = args.indexOf(' ', firstSpace + 1);
    int thirdSpace = args.indexOf(' ', secondSpace + 1);
    if (firstSpace <= 0 || secondSpace <= firstSpace || thirdSpace <= secondSpace) {
        return false;
    }
    request.targetVersion = args.substring(0, firstSpace);
    const String sizeText = args.substring(firstSpace + 1, secondSpace);
    request.sha256 = args.substring(secondSpace + 1, thirdSpace);
    request.url = args.substring(thirdSpace + 1);
    int parsedSize = 0;
    if (
        !isValidOtaToken(request.targetVersion, 31) ||
        !parseBoundedDecimal(sizeText, OTA_MAXIMUM_IMAGE_SIZE, parsedSize) ||
        parsedSize < static_cast<int>(OTA_MINIMUM_IMAGE_SIZE) ||
        !isValidSha256(request.sha256) || request.url.length() > 240 ||
        !request.url.startsWith("http://") || request.url.indexOf(' ') >= 0
    ) {
        return false;
    }
    request.size = static_cast<size_t>(parsedSize);
    request.pending = true;
    return true;
}

void setOtaFailure(const String& error) {
    otaRequest.pending = false;
    otaReport.status = "failed";
    otaReport.targetVersion = otaRequest.targetVersion;
    otaReport.error = error;
    otaReport.progress = 0;
    telemetryAnnouncementPending = true;
    Serial.println("OTA update failed: " + error);
    if (client.connected()) {
        announcePresence();
    }
}

String sha256Hex(const unsigned char digest[32]) {
    const char hex[] = "0123456789abcdef";
    String result;
    result.reserve(64);
    for (size_t index = 0; index < 32; index++) {
        result += hex[digest[index] >> 4];
        result += hex[digest[index] & 0x0f];
    }
    return result;
}

void publishOtaProgress(const String& status, unsigned int progress) {
    otaReport.status = status;
    otaReport.targetVersion = otaRequest.targetVersion;
    otaReport.error = "";
    otaReport.progress = progress;
    telemetryAnnouncementPending = true;
    if (client.connected()) {
        announcePresence();
        client.loop();
    }
}

void performOtaUpdate() {
    otaRequest.pending = false;
    publishOtaProgress("downloading", 0);

    HTTPClient http;
    if (!http.begin(otaRequest.url)) {
        setOtaFailure("http_initialization_failed");
        return;
    }
    http.setConnectTimeout(10000);
    http.setTimeout(10000);
    const int statusCode = http.GET();
    if (statusCode != HTTP_CODE_OK) {
        http.end();
        setOtaFailure("http_status_" + String(statusCode));
        return;
    }
    const int contentLength = http.getSize();
    if (contentLength != static_cast<int>(otaRequest.size)) {
        http.end();
        setOtaFailure("image_size_mismatch");
        return;
    }
    if (!Update.begin(otaRequest.size, U_FLASH)) {
        http.end();
        setOtaFailure("update_begin_failed_" + String(Update.getError()));
        return;
    }

    mbedtls_sha256_context shaContext;
    mbedtls_sha256_init(&shaContext);
    if (mbedtls_sha256_starts(&shaContext, 0) != 0) {
        Update.abort();
        http.end();
        mbedtls_sha256_free(&shaContext);
        setOtaFailure("sha256_initialization_failed");
        return;
    }

    WiFiClient* stream = http.getStreamPtr();
    uint8_t buffer[OTA_DOWNLOAD_BUFFER_SIZE];
    size_t received = 0;
    unsigned int publishedProgress = 0;
    unsigned long lastDataAt = millis();
    bool downloadFailed = false;
    while (received < otaRequest.size) {
        size_t available = stream->available();
        if (available == 0) {
            if (!http.connected() || millis() - lastDataAt >= 10000) {
                downloadFailed = true;
                break;
            }
            client.loop();
            delay(5);
            continue;
        }
        size_t toRead = min(
            available,
            min(sizeof(buffer), otaRequest.size - received)
        );
        int read = stream->readBytes(buffer, toRead);
        if (read <= 0) {
            downloadFailed = true;
            break;
        }
        lastDataAt = millis();
        if (mbedtls_sha256_update(&shaContext, buffer, read) != 0) {
            downloadFailed = true;
            break;
        }
        if (Update.write(buffer, read) != static_cast<size_t>(read)) {
            downloadFailed = true;
            break;
        }
        received += static_cast<size_t>(read);
        unsigned int progress = static_cast<unsigned int>(
            (static_cast<uint64_t>(received) * 100U) / otaRequest.size
        );
        if (progress == 100 || progress / 10 > publishedProgress / 10) {
            publishedProgress = progress;
            Serial.printf("OTA download progress: %u%%\n", progress);
            publishOtaProgress("downloading", progress);
        }
    }

    unsigned char digest[32];
    const int finishResult = mbedtls_sha256_finish(&shaContext, digest);
    mbedtls_sha256_free(&shaContext);
    http.end();
    if (downloadFailed || received != otaRequest.size || finishResult != 0) {
        Update.abort();
        setOtaFailure("firmware_download_failed");
        return;
    }

    publishOtaProgress("verifying", 100);
    const String actualSha256 = sha256Hex(digest);
    if (!actualSha256.equalsIgnoreCase(otaRequest.sha256)) {
        Update.abort();
        setOtaFailure("sha256_mismatch");
        return;
    }
    const esp_partition_t* running = esp_ota_get_running_partition();
    if (running == nullptr) {
        Update.abort();
        setOtaFailure("running_partition_unavailable");
        return;
    }
    Preferences preferences;
    if (!preferences.begin("aquarium", false)) {
        setOtaFailure("probation_marker_unavailable");
        return;
    }
    bool markerStored =
        preferences.putString("otaTarget", otaRequest.targetVersion) > 0 &&
        preferences.putUChar("otaPrev", static_cast<uint8_t>(running->subtype)) > 0 &&
        preferences.putUInt("otaBoots", 0) > 0 &&
        preferences.putBool("otaPending", true) > 0;
    preferences.end();
    if (!markerStored) {
        Update.abort();
        setOtaFailure("probation_marker_write_failed");
        return;
    }
    if (!Update.end(true)) {
        Preferences cleanup;
        if (cleanup.begin("aquarium", false)) {
            clearOtaMarker(cleanup);
            cleanup.end();
        }
        setOtaFailure("update_finalize_failed_" + String(Update.getError()));
        return;
    }

    publishOtaProgress("rebooting", 100);
    Serial.println("OTA image installed; rebooting into probation");
    Serial.flush();
    delay(250);
    ESP.restart();
}

void serviceFirmwareUpdate() {
    if (otaRequest.pending && !otaProbationActive) {
        performOtaUpdate();
    }
    serviceOtaProbation();
}

void setup_wifi() {
	Serial.println("Connecting to WiFi...");
	Serial.print("SSID: ");
	Serial.println(configuredWifiSsid);
	
	WiFi.begin(configuredWifiSsid.c_str(), configuredWifiPassword.c_str());

	WiFi.setSleep(false);           // Arduino-style call
    esp_wifi_set_ps(WIFI_PS_NONE);  // IDF-style call, does the same

	int attempts = 0;
	while (WiFi.status() != WL_CONNECTED && attempts < 20) {
		delay(500);
		Serial.print(".");
		attempts++;
	}
	
	if (WiFi.status() == WL_CONNECTED) {
		Serial.println("\nWiFi connected");
		Serial.println("IP address: " + WiFi.localIP().toString());
		Serial.println("Signal strength (RSSI): " + String(WiFi.RSSI()) + " dBm");
	} else {
		Serial.println("\nWiFi connection failed!");
		Serial.println("WiFi status: " + String(WiFi.status()));
	}
}

// Calculate a simple hash from a string
unsigned long calculateHash(const String& str) {
    unsigned long hash = 5381;
    for (size_t i = 0; i < str.length(); i++) {
        hash = ((hash << 5) + hash) + str[i]; // hash * 33 + c
    }
    return hash;
}

void queueOutputAnnouncement() {
	telemetryAnnouncementPending = true;
}

unsigned int outputPercentage(int pwmValue) {
	const int maximumDuty = (1 << resolution) - 1;
	if (maximumDuty <= 0 || pwmValue <= 0) {
		return 0;
	}
	return static_cast<unsigned int>(
		(static_cast<uint64_t>(pwmValue) * 100U + maximumDuty / 2) /
		maximumDuty
	);
}

bool allOutputsAreOff() {
	for (int pin = MIN_PIN; pin <= MAX_PIN; pin++) {
		if (attachedPins[pin] && lastPinValues[pin] != 0) {
			return false;
		}
	}
	return true;
}

String buildPresenceMessage() {
	JsonDocument doc;
	doc["name"] = deviceName;
	doc["freq"] = freq;
	doc["res"] = resolution;
	doc["id"] = deviceId;
	doc["status"] = "online";
  	doc["version"] = VERSION;
	doc["hardwareProfile"] = HARDWARE_PROFILE;
	doc["hardwareModel"] = HARDWARE_MODEL;
	doc["outputsOff"] = allOutputsAreOff();
	JsonArray outputs = doc["outputs"].to<JsonArray>();
	for (int pin = MIN_PIN; pin <= MAX_PIN; pin++) {
		if (!attachedPins[pin]) {
			continue;
		}
		JsonArray output = outputs.add<JsonArray>();
		output.add(pin);
		output.add(outputPercentage(lastPinValues[pin]));
	}
	JsonObject ota = doc["ota"].to<JsonObject>();
	ota["status"] = otaReport.status;
	ota["targetVersion"] = otaReport.targetVersion;
	ota["progress"] = otaReport.progress;
	if (!otaReport.error.isEmpty()) {
		ota["error"] = otaReport.error;
	}
	if (lastError.code.length() > 0) {
		JsonObject error = doc["lastError"].to<JsonObject>();
		error["code"] = lastError.code;
		error["severity"] = lastError.severity;
		error["message"] = lastError.message;
		error["sequence"] = lastError.sequence;
		error["active"] = lastError.active;
		error["at"] = static_cast<unsigned long>(lastError.at);
	}
	
	// Calculate and send a hash of the schedule instead of the entire schedule
	if (strlen(currentSchedule) > 0) {
		// Parse the schedule to remove syncTime before hashing
		JsonDocument scheduleDoc;
		deserializeJson(scheduleDoc, currentSchedule);
		
		// Create a copy without syncTime for consistent hashing
		JsonDocument channelsOnlyDoc;
		channelsOnlyDoc["c"] = scheduleDoc["c"];
		
		// Serialize back to a string and calculate hash
		String channelsOnly;
		serializeJson(channelsOnlyDoc, channelsOnly);
		unsigned long scheduleHash = calculateHash(channelsOnly);
		
		doc["scheduleHash"] = String(scheduleHash);
		Serial.println("Schedule hash (channels only): " + String(scheduleHash));
	} else {
		doc["scheduleHash"] = "0";
		Serial.println("No schedule available, hash: 0");
	}
	
	String message;
	serializeJson(doc, message);
	return message;
}

void finishPublishedAnnouncement() {
	diagnosticAnnouncementPending = false;
	diagnosticAnnouncementAttempted = false;
	telemetryAnnouncementPending = false;
	if (
		spiffsReformattedThisBoot &&
		lastError.code == "spiffs_reformatted" &&
		lastError.active
	) {
		spiffsReformattedThisBoot = false;
		resolveLastError("spiffs_reformatted");
	}
}

bool announcePresence() {
	String message = buildPresenceMessage();
	bool published = TEST
		? publishWithRetry("test/aquarium/announce", message.c_str())
		: publishWithRetry("aquarium/announce", message.c_str());
	if (published) {
		Serial.println("Announced presence: " + message);
		finishPublishedAnnouncement();
	}
	return published;
}

void serviceDiagnosticAnnouncement() {
	if (
		(!diagnosticAnnouncementPending && !telemetryAnnouncementPending) ||
		!client.connected()
	) {
		return;
	}
	unsigned long currentMillis = millis();
	const unsigned long retryInterval = telemetryAnnouncementPending
		? TELEMETRY_ANNOUNCEMENT_INTERVAL_MS
		: DIAGNOSTIC_ANNOUNCEMENT_RETRY_INTERVAL_MS;
	const unsigned long priorAttempt = telemetryAnnouncementPending
		? telemetryAnnouncementAttemptAt
		: diagnosticAnnouncementAttemptAt;
	if (priorAttempt > 0 && currentMillis - priorAttempt < retryInterval) {
		return;
	}

	diagnosticAnnouncementAttempted = true;
	diagnosticAnnouncementAttemptAt = currentMillis;
	telemetryAnnouncementAttemptAt = currentMillis;
	String message = buildPresenceMessage();
	const char* topic = TEST
		? "test/aquarium/announce"
		: "aquarium/announce";
	if (client.publish(topic, message.c_str())) {
		Serial.println("Published queued diagnostic announcement: " + message);
		finishPublishedAnnouncement();
	} else {
		Serial.println("Queued diagnostic announcement publish failed; retry remains pending");
	}
}

String handleScheduleCommand(const String& scheduleJson) {
    if (scheduleJson.length() >= sizeof(currentSchedule)) {
        return "E: Schedule too large";
    }
    // Verify JSON is valid
    JsonDocument doc;
    DeserializationError error = deserializeJson(doc, scheduleJson);
    if (error) {
        return "E: Invalid JSON";
    }
    if (!schedulePinsAreValid(doc)) {
        return "E: Invalid schedule";
    }
    
    JsonArray channels = doc["c"].as<JsonArray>();
    bool newlyAttached[MAX_PIN + 1] = {false};
    ScheduleAttachResult attachResult =
        attachMissingSchedulePins(channels, newlyAttached);
    if (!storeSchedule(scheduleJson)) {
        rollbackNewSchedulePins(newlyAttached);
        recordLastError(
            "schedule_storage_failed",
            "error",
            "Could not persist the replacement schedule"
        );
        return "E: Schedule storage failed";
    }
    resolveLastError("schedule_storage_failed");
    strlcpy(currentSchedule, scheduleJson.c_str(), sizeof(currentSchedule));

    turnOffRemovedSchedulePins(channels);

    // Clear and setup channels
    activeChannels.clear();
    
    // Setup channels
    for (JsonVariant channel : channels) {
        int pin = channel["o"].as<int>();
        // Use as<int>() instead of as<char>() and then cast to int8_t
        int8_t type = (int8_t)channel["t"].as<int>();
        
        // Initialize channel
        // Force a replacement schedule to write even when its first target is
        // zero or matches the previous schedule's cached percentage.
        activeChannels.push_back({pin, -1, type});
        
        // Attached pins were held low before durable publication. Missing pins
        // remain represented here so the bounded retry can recover them later.
    }
    lastScheduleAttachRetry = millis();
    reportScheduleAttachResult(attachResult);
    
    // Return a simple confirmation instead of the entire schedule
    return "schedule_ok";
}

String handleCommand(String command, String args) {
	Serial.println("Handling command: " + command + " with args: " + args);
	String response = "E: Invalid command";
	if (command == "s") {
		int pin, value, overwrite;
		if (parseSetArguments(args, pin, value, overwrite)) {
			Serial.println("Pin: " + String(pin));
			Serial.println("Value: " + String(value));
			Serial.println("Overwrite: " + String(overwrite));
			if (!isAllowedPwmPin(pin)) {
				response = "E: Invalid pin";
			} else if (value >= 0 && value <= 255 && (overwrite == 0 || overwrite == 1)) {
				const int pwmValue = scaleNormalizedPwmValue(value, resolution);
				bool newlyAttached = false;
				if (!attachedPins[pin]) {
					if (ledcAttach(pin, freq, resolution)) {
						attachedPins[pin] = true;
						newlyAttached = true;
					} else {
						recordLastError(
							"pin_attach_failed",
							"error",
							"LEDC attach failed on pin " + String(pin)
						);
						response = "E: LEDC attach failed";
					}
				}
				if (attachedPins[pin]) {
					const bool outputStateChanged =
						newlyAttached || lastPinValues[pin] != pwmValue;
					if (!ledcWrite(pin, pwmValue)) {
						if (newlyAttached) {
							if (ledcDetach(pin)) {
								attachedPins[pin] = false;
								resolveLastErrorForPin("pin_detach_failed", pin);
								pinMode(pin, OUTPUT);
								digitalWrite(pin, LOW);
							} else {
								recordLastError(
									"pin_detach_failed",
									"error",
									"LEDC detach failed on pin " + String(pin)
								);
							}
						}
						recordLastError(
							"pin_write_failed",
							"error",
							"LEDC write failed on pin " + String(pin)
						);
						response = "E: LEDC write failed";
					} else {
						lastPinValues[pin] = pwmValue;
						if (outputStateChanged) {
							queueOutputAnnouncement();
						}
					
						// Update pin state with overwrite information
						if (overwrite == 1) {
							pinStates[pin] = {pwmValue, true, millis()};
						} else {
							pinStates[pin] = {pwmValue, false, 0};
						}
					
						response = "s " + String(pin) + " " + String(value) + " " + String(overwrite);
						resolveLastErrorForPin("pin_attach_failed", pin);
						resolveLastErrorForPin("pin_write_failed", pin);
					}
				}
			} else {
				response = "E: Invalid value or overwrite parameter";
			}
		} else {
			response = "E: Invalid arguments";
		}
	}
	
	else if (command == "ota") {
		OtaRequest parsedRequest = {"", "", "", 0, false};
		if (!parseOtaArguments(args, parsedRequest)) {
			response = "E: Invalid OTA request";
		} else if (otaProbationActive || otaRequest.pending) {
			response = "E: OTA busy";
		} else if (parsedRequest.targetVersion == VERSION) {
			response = "E: Firmware already current";
		} else {
			otaRequest = parsedRequest;
			otaReport = {"accepted", otaRequest.targetVersion, "", 0};
			telemetryAnnouncementPending = true;
			Serial.println(
				"Accepted OTA update to firmware " + otaRequest.targetVersion
			);
			response = "ota_accepted";
		}
	}

	else if (command == "p" || command == "e") {
		if (command == "p") {
			response = "o";
		}
		else if (command == "e") {
			String newName;
			int newFreq;
			int newRes;
			if (!parseEditArguments(args, newName, newFreq, newRes)) {
				return "E: Invalid configuration";
			}
			if (!isValidDeviceName(newName) ||
				!isValidPwmConfiguration(newFreq, newRes)) {
				return "E: Invalid configuration";
			}

     		Serial.println(deviceName + " " + newName + " " + String(newFreq) + " " + String(newRes));

			String oldName = deviceName;
			int oldFreq = freq;
			int oldRes = resolution;
			bool needReattach = newFreq != oldFreq || newRes != oldRes;
			if (needReattach &&
				!reattachConfiguredPins(newFreq, newRes, oldFreq, oldRes)) {
				return "E: LEDC reattach failed";
			}

			bool persisted = newName == oldName ||
				writeToEEPROM(NAME_ADDR, newName, NAME_MAX_LENGTH);
			EEPROM.put(FREQ_ADDR, newFreq);
			EEPROM.put(RES_ADDR, newRes);
			persisted = EEPROM.commit() && persisted;
			if (!persisted) {
				Serial.println("Configuration persistence failed; rolling back");
				recordLastError(
					"configuration_persistence_failed",
					"error",
					"Could not persist the replacement PWM configuration"
				);
				writeToEEPROM(NAME_ADDR, oldName, NAME_MAX_LENGTH);
				EEPROM.put(FREQ_ADDR, oldFreq);
				EEPROM.put(RES_ADDR, oldRes);
				EEPROM.commit();
				if (needReattach) {
					reattachConfiguredPins(oldFreq, oldRes, newFreq, newRes);
				}
				return "E: Configuration persistence failed";
			}

			deviceName = newName;
			freq = newFreq;
			resolution = newRes;
			resolveLastError("configuration_persistence_failed");
			response = deviceName + " " + String(freq) + " " + String(resolution);
		}
	}
	else if (command == "sync") {
		unsigned long serverTime;
		if (
			parseSyncTime(args, serverTime) &&
			isUsableUnixTime(static_cast<time_t>(serverTime))
		) {
			// Update our internal time
			time_t syncTime = serverTime;
			timeInfo.lastSyncTime = syncTime;
			timeInfo.lastSavedTime = syncTime;
			timeInfo.lastMillis = millis();
			timeInfo.timeInitialized = true;
			scheduleTimeAvailableThisBoot = true;
			queueTimeCheckpoint(true);
			
			struct tm timeinfo;
			localtime_r(&syncTime, &timeinfo);
			Serial.print("Time synchronized to: ");
			Serial.println(&timeinfo, "%A, %B %d %Y %H:%M:%S");
			
			response = String(serverTime);
		} else {
			response = "E: Invalid time value";
		}
	}
	else if (command == "r") {
        int pin;
        const char* cursor = args.c_str();
        bool parsed = parseCommandInteger(cursor, pin);
        if (parsed) {
            skipCommandWhitespace(cursor);
        }

        if (!parsed) {
            response = "E: Invalid arguments";
        } else if (*cursor != '\0') {
            response = "E: Metadata not supported";
        } else if (!isAllowedAnalogInputPin(pin)) {
            response = "E: Invalid pin";
        } else if (attachedPins[pin]) {
            response = "E: Pin is configured as output";
        } else {
            pinMode(pin, INPUT);
            int val = analogRead(pin);
            response = "r " + String(pin) + " " + String(val);
        }
	}

	return response;
}

void callback(char* topic, byte* payload, unsigned int length) {
	Serial.println("Message received on topic: " + String(topic));

	if (length > MQTT_MAX_COMMAND_PAYLOAD_SIZE) {
		Serial.println("MQTT command exceeded the 5120-byte payload limit; ignoring message");
		return;
	}

	String message;
	if (!message.reserve(length)) {
		Serial.println("Could not allocate memory for MQTT command; ignoring message");
		return;
	}
	message.concat(reinterpret_cast<const char*>(payload), length);
	Serial.println("Message content: " + message);

	if ((!TEST && String(topic) == "aquarium/command") || (TEST && String(topic) == "test/aquarium/command")) {
		if (message == "discover") {
			Serial.println("Discover message received, announcing presence");
			announcePresence();
			return;
		}

		processCompleteMessage(message);
	} else {
		Serial.println("Invalid topic, ignoring message");
	}
}

String processCommand(String message) {
	// Find first space to get device name/id
	int firstSpace = message.indexOf(' ');
	if (firstSpace == -1) return "";

	String targetDevice = message.substring(0, firstSpace);
	if (targetDevice != deviceName && targetDevice != deviceId) return "";

	// Get remaining part after device name
	String remainder = message.substring(firstSpace + 1);

  // Check if this is a schedule command
  if (remainder.startsWith("sc ")) {
      String scheduleJson = remainder.substring(3);
      return handleScheduleCommand(scheduleJson);
  }
	
	// Find command
	int secondSpace = remainder.indexOf(' ');
	String command;
	String args;
	
	if (secondSpace == -1) {
		command = remainder;
		args = "";
	} else {
		command = remainder.substring(0, secondSpace);
		args = remainder.substring(secondSpace + 1);
	}

	return handleCommand(command, args);
}

void onNtpTimeAvailable(struct timeval*) {
    ntpTimeAvailable.store(true);
}

void beginNtpSync() {
    if (WiFi.status() != WL_CONNECTED) {
        return;
    }

    ntpSyncStartedAt = millis();
    lastNtpSyncAttemptAt = ntpSyncStartedAt;
    ntpSyncInProgress = true;
    ntpSyncEverAttempted = true;

    Serial.println("Starting asynchronous NTP synchronization");
    configTime(gmtOffset_sec, daylightOffset_sec, configuredNtpServer.c_str());
}

void serviceTimeSynchronization() {
    if (ntpTimeAvailable.exchange(false)) {
        time_t now;
        time(&now);

        if (isUsableUnixTime(now)) {
            timeInfo.lastSyncTime = now;
            timeInfo.lastSavedTime = now;
            timeInfo.lastMillis = millis();
            timeInfo.timeInitialized = true;
            scheduleTimeAvailableThisBoot = true;
            queueTimeCheckpoint(true);

            ntpSyncInProgress = false;
            ntpSyncHasCompleted = true;
            lastNtpSyncCompletedAt = millis();

            struct tm timeinfo;
            localtime_r(&now, &timeinfo);
            Serial.println("Time synchronized via NTP");
            Serial.print("Current time: ");
            Serial.println(&timeinfo, "%A, %B %d %Y %H:%M:%S");
        } else {
            Serial.println("NTP reported an invalid time; waiting for the next retry");
        }
    }

    const unsigned long currentMillis = millis();
    if (WiFi.status() != WL_CONNECTED) {
        return;
    }

    // All elapsed-time checks use unsigned subtraction. The 15-second,
    // 60-second, and six-hour intervals remain safe across millis() rollover.
    if (ntpSyncInProgress) {
        if (currentMillis - ntpSyncStartedAt >= NTP_SYNC_TIMEOUT_MS) {
            ntpSyncInProgress = false;
            Serial.println("NTP synchronization timed out; control remains online and retry is scheduled");
        }
        return;
    }

    const bool resyncDue = !ntpSyncHasCompleted ||
        currentMillis - lastNtpSyncCompletedAt >= NTP_RESYNC_INTERVAL_MS;
    const bool retryDue = !ntpSyncEverAttempted ||
        currentMillis - lastNtpSyncAttemptAt >= NTP_RETRY_INTERVAL_MS;

    if (resyncDue && retryDue) {
        beginNtpSync();
    }
}

// Configure NTP without waiting for DNS or a server response.
void initializeTime() {
    sntp_set_time_sync_notification_cb(onNtpTimeAvailable);

    if (WiFi.status() == WL_CONNECTED) {
        beginNtpSync();
    } else {
        Serial.println("WiFi not connected; NTP will start after WiFi reconnects");
    }
}

bool isUsableUnixTime(time_t value) {
    if (value < MIN_VALID_UNIX_TIME ||
        value > static_cast<time_t>(MAX_SYNC_UNIX_TIME)) {
        return false;
    }
    struct tm timeinfo;
    return localtime_r(&value, &timeinfo) != nullptr;
}

bool persistTimeCheckpoint() {
    if (!timeInfo.timeInitialized) {
        return false;
    }
    time_t currentTime = getCurrentTime();
    if (!isUsableUnixTime(currentTime)) {
        Serial.println("Refusing to persist an invalid time checkpoint");
        return false;
    }

    timeInfo.lastSavedTime = currentTime;
    timeInfo.lastMillis = millis();
    EEPROM.put(TIME_INFO_ADDR, timeInfo);
    if (!EEPROM.commit()) {
        Serial.println("Time checkpoint EEPROM commit failed");
        return false;
    }
    Serial.println("Time checkpoint saved to EEPROM");
    return true;
}

void serviceTimeCheckpoint() {
    if (!timeInfo.timeInitialized) {
        return;
    }
    unsigned long currentMillis = millis();
    if (
        !timeCheckpointPending &&
        currentMillis - timeCheckpointSuccessAt >= TIME_CHECKPOINT_INTERVAL_MS
    ) {
        timeCheckpointPending = true;
    }
    if (!timeCheckpointPending) {
        return;
    }

    bool due = false;
    if (timeCheckpointFailed) {
        due = currentMillis - timeCheckpointAttemptAt >=
            PERSISTENCE_RETRY_INTERVAL_MS;
    } else if (
        timeCheckpointImmediatePending &&
        !freshTimeCheckpointCommittedThisBoot
    ) {
        due = true;
    } else {
        due = currentMillis - timeCheckpointSuccessAt >=
            TIME_CHECKPOINT_INTERVAL_MS;
    }
    if (!due) {
        return;
    }

    timeCheckpointAttemptAt = currentMillis;
    const bool committingFreshTime = timeCheckpointImmediatePending;
    if (persistTimeCheckpoint()) {
        timeCheckpointPending = false;
        timeCheckpointImmediatePending = false;
        if (committingFreshTime) {
            freshTimeCheckpointCommittedThisBoot = true;
        }
        timeCheckpointFailed = false;
        timeCheckpointSuccessAt = currentMillis;
    } else {
        timeCheckpointFailed = true;
    }
}

void queueTimeCheckpoint(bool immediate) {
    timeCheckpointPending = true;
    if (immediate && !freshTimeCheckpointCommittedThisBoot &&
        !timeCheckpointImmediatePending) {
        timeCheckpointImmediatePending = true;
        // A newly available authoritative clock should not wait behind an
        // earlier failed fallback checkpoint. If this fresh attempt itself
        // fails, the normal retry backoff applies.
        timeCheckpointFailed = false;
    }
    serviceTimeCheckpoint();
}

// Load time information from EEPROM
void loadTimeInfo() {
    EEPROM.get(TIME_INFO_ADDR, timeInfo);
    
    // Verify if the loaded data makes sense
    if (!isUsableUnixTime(timeInfo.lastSavedTime)) {
        Serial.println("Invalid time data in EEPROM, resetting");
        timeInfo.timeInitialized = false;
        timeCheckpointSuccessAt = millis();
        return;
    }
    
    // Power-off duration is unknowable without an RTC. Resume from the last
    // hourly checkpoint; this boundedly stale estimate is preferable to
    // keeping aquarium lights off while both the Pi and NTP are unavailable.
    time_t currentTime = timeInfo.lastSavedTime;
    timeInfo.lastMillis = millis();
    timeInfo.timeInitialized = true;
    scheduleTimeAvailableThisBoot = true;
    timeCheckpointSuccessAt = millis();
    
    Serial.println("Time info loaded from EEPROM");
    Serial.print("Current time estimate: ");
    struct tm timeinfo;
    localtime_r(&currentTime, &timeinfo);
    Serial.println(&timeinfo, "%A, %B %d %Y %H:%M:%S");
}

// Get current time in seconds since epoch, using best available source
time_t getCurrentTime() {
    if (!timeInfo.timeInitialized) {
        return 0; // Time not initialized yet
    }
    
    // Calculate time based on saved time and elapsed milliseconds
    unsigned long elapsed = millis() - timeInfo.lastMillis;
    time_t currentTime = timeInfo.lastSavedTime + (elapsed / 1000);
    
    return currentTime;
}

// Convert current time to minutes since midnight (0-1439)
int getCurrentMinuteOfDay() {
    time_t now = getCurrentTime();
    if (now == 0) return 0; // Time not initialized
    
    struct tm timeinfo;
    localtime_r(&now, &timeinfo);
    return timeinfo.tm_hour * 60 + timeinfo.tm_min;
}

bool mountSpiffsWithRecovery() {
    const char* repairFailureKey = "fsRepairFails";
    const unsigned char maximumRepairFailures = 2;
    Preferences preferences;
    const bool preferencesAvailable = preferences.begin("aquarium", false);

    if (SPIFFS.begin(false)) {
        if (preferencesAvailable && preferences.isKey(repairFailureKey)) {
            preferences.remove(repairFailureKey);
        }
        if (preferencesAvailable) {
            preferences.end();
        }
        return true;
    }

    if (!preferencesAvailable) {
        Serial.println("SPIFFS repair counter is unavailable; refusing an unbounded format attempt");
        return false;
    }

    unsigned char repairFailures = preferences.getUChar(repairFailureKey, 0);
    if (repairFailures >= maximumRepairFailures) {
        Serial.println("SPIFFS automatic repair limit reached");
        if (preferencesAvailable) {
            preferences.end();
        }
        return false;
    }
    preferences.putUChar(repairFailureKey, repairFailures + 1);

    Serial.println("SPIFFS mount failed; formatting the filesystem once");
    SPIFFS.end();
    const bool recovered = SPIFFS.format() && SPIFFS.begin(false);
    if (recovered) {
        spiffsReformattedThisBoot = true;
        if (preferencesAvailable) {
            preferences.remove(repairFailureKey);
        }
    }
    if (preferencesAvailable) {
        preferences.end();
    }
    return recovered;
}

void setup() {
	Serial.begin(115200);
	Serial.println("\nStarting up...");
	initializeOtaBootState();
	
	// Initialize EEPROM with proper partition verification
	if (!EEPROM.begin(EEPROM_SIZE)) {
		Serial.println("Failed to initialize EEPROM!");
	}
	
	initializeEEPROM();
	loadTimeInfo(); // Load time info from EEPROM

    spiffsAvailable = mountSpiffsWithRecovery();
    if (!spiffsAvailable) {
        Serial.println("SPIFFS initialization failed!");
        recordLastError(
            "spiffs_mount_failed",
            "error",
            "SPIFFS could not be mounted or repaired"
        );
    } else {
        Serial.println("SPIFFS initialized successfully");
        loadLastError();
        if (spiffsReformattedThisBoot) {
            recordLastError(
                "spiffs_reformatted",
                "warning",
                "SPIFFS was reformatted after a mount failure; the controller must restore the schedule"
            );
        }
    }

    if (!client.setBufferSize(MQTT_PACKET_BUFFER_SIZE)) {
        Serial.println("Failed to allocate the required MQTT packet buffer");
        recordLastError(
            "mqtt_buffer_allocation_failed",
            "error",
            "Could not allocate the 6144-byte MQTT packet buffer"
        );
    } else {
        resolveLastError("mqtt_buffer_allocation_failed");
    }

  	// Load saved schedule if it exists
	String savedSchedule = loadSchedule();
	if (savedSchedule.length() > 0) {
		processSchedule(savedSchedule);
	}
	
	if (!loadNetworkConfiguration()) {
		Serial.println("Network configuration is unavailable; stopping startup");
		while (true) {
			delay(1000);
		}
	}

	setup_wifi();
	initializeTime();
	
	client.setServer(configuredMqttServer.c_str(), configuredMqttPort);
	client.setKeepAlive(15);
	client.setCallback(callback);
	
	Serial.println("Setup complete");
}

void loop() {
	if (WiFi.status() != WL_CONNECTED) {
		WiFi.reconnect();
		delay(200);
	}

	serviceTimeSynchronization();

	if (!client.connected()) {
		unsigned long currentMillis = millis();
		if (currentMillis - lastReconnectAttempt >= reconnectInterval) {
			lastReconnectAttempt = currentMillis;
			Serial.println("MQTT disconnected, attempting to reconnect...");
			
			// Generate a random client ID
			String clientId = "ESP32Client-";
			clientId += String(random(0xffff), HEX);
			
			Serial.println("Attempting MQTT connection with client ID: " + clientId);
			Serial.println("Broker: " + configuredMqttServer);
			
			// Print WiFi status
			Serial.println("WiFi status - SSID: " + String(WiFi.SSID()) + 
										" Signal strength: " + String(WiFi.RSSI()) + "dBm");
			
			const bool mqttConnected = configuredMqttUsername.isEmpty()
				? client.connect(clientId.c_str())
				: client.connect(
					clientId.c_str(),
					configuredMqttUsername.c_str(),
					configuredMqttPassword.c_str()
				);
			if (mqttConnected) {
				Serial.println("MQTT connected");
				if (TEST) {
					client.subscribe("test/aquarium/command");
				} else {
					client.subscribe("aquarium/command");
				}
				if (announcePresence()) {
					confirmOtaProbation();
				}
			} else {
				Serial.print("MQTT connection failed, rc=");
				Serial.println(client.state());
				Serial.println("Error meanings:");
				switch(client.state()) {
					case -4: Serial.println("MQTT_CONNECTION_TIMEOUT"); break;
					case -3: Serial.println("MQTT_CONNECTION_LOST"); break;
					case -2: Serial.println("MQTT_CONNECT_FAILED"); break;
					case -1: Serial.println("MQTT_DISCONNECTED"); break;
					case 0: Serial.println("MQTT_CONNECTED"); break;
					case 1: Serial.println("MQTT_CONNECT_BAD_PROTOCOL"); break;
					case 2: Serial.println("MQTT_CONNECT_BAD_CLIENT_ID"); break;
					case 3: Serial.println("MQTT_CONNECT_UNAVAILABLE"); break;
					case 4: Serial.println("MQTT_CONNECT_BAD_CREDENTIALS"); break;
					case 5: Serial.println("MQTT_CONNECT_UNAUTHORIZED"); break;
				}
				Serial.println("Retrying in 5 seconds");
			}
		}
	}

	serviceTimeCheckpoint();
	serviceLastErrorPersistence();

	static unsigned long lastOverwriteCheck = 0;
	if (millis() - lastOverwriteCheck >= 200) {
		checkOverwriteExpiries();
		lastOverwriteCheck = millis();
	}

	// Process schedule if active
	if (strlen(currentSchedule) > 0) {
		unsigned long currentMillis = millis();
		if (currentMillis - lastScheduleAttachRetry >= SCHEDULE_ATTACH_RETRY_INTERVAL) {
			lastScheduleAttachRetry = currentMillis;
			retryMissingSchedulePins();
		}
		
		// Only update if SCHEDULE_UPDATE_INTERVAL has passed
		if (currentMillis - lastScheduleUpdate >= SCHEDULE_UPDATE_INTERVAL) {
			lastScheduleUpdate = currentMillis;

			if (timeInfo.timeInitialized && scheduleTimeAvailableThisBoot) {
				// Get current minute of day (0-1439). Midnight is a valid zero.
				int currentMinute = getCurrentMinuteOfDay();
				deserializeJson(globalDoc, currentSchedule);
				
				// Process each channel in the array
				JsonArray channels = globalDoc["c"].as<JsonArray>();
				int failedWriteCount = 0;
				int firstFailedWritePin = -1;
				for (size_t i = 0; i < channels.size(); i++) {
					JsonVariant channel = channels[i];
					int pin = channel["o"].as<int>();
					JsonArray links = channel["l"].as<JsonArray>();
					// Get type as integer
					int8_t type = (int8_t)channel["t"].as<int>();
					
					// Find the matching channel in our active channels
					for (size_t j = 0; j < activeChannels.size(); j++) {
						if (activeChannels[j].pin == pin) {
							if (!attachedPins[pin]) {
								break;
							}
							// Check if pin is currently overwritten
							auto pinStateIt = pinStates.find(pin);
							if (pinStateIt != pinStates.end() && pinStateIt->second.isOverwritten) {
								break; // Skip schedule update for this pin
							}
							
							int targetValue = getScheduledValue(links, currentMinute);
							
							// Only update if value has changed
							if (activeChannels[j].currentValue != targetValue) {
								int pwmValue = (targetValue * ((1 << resolution) - 1)) / 100;
								Serial.println("Schedule: Setting pin " + String(pin) + " to " + String(pwmValue) + 
											  " (" + String(targetValue) + "%) at minute " + String(currentMinute) +
											  " [Type: " + (type == 112 ? "pump" : "light") + "]");
								if (!ledcWrite(pin, pwmValue)) {
									if (firstFailedWritePin < 0) {
										firstFailedWritePin = pin;
									}
									failedWriteCount++;
									break;
								}
								lastPinValues[pin] = pwmValue;
								queueOutputAnnouncement();
								resolveLastErrorForPin("pin_write_failed", pin);
								auto scheduledPinState = pinStates.find(pin);
								if (scheduledPinState != pinStates.end()) {
									scheduledPinState->second.lastValue = pwmValue;
								}
								activeChannels[j].currentValue = targetValue;
							}
							break;
						}
					}
				}
				if (failedWriteCount > 0) {
					recordLastError(
						"pin_write_failed",
						"error",
						"LEDC write failed on pin " + String(firstFailedWritePin)
					);
				}
			} else if (!scheduleTimeGateNoticePrinted) {
				Serial.println("Persisted schedule is off because no usable time is available");
				scheduleTimeGateNoticePrinted = true;
			}
		}
	}
 
	client.loop();
	serviceDiagnosticAnnouncement();
	serviceFirmwareUpdate();

    // ------------------------------------------------------------------
    // Daily maintenance: restart WiFi and MQTT at 04:00 to reclaim memory
    // ------------------------------------------------------------------
    static unsigned long lastMaintenanceCheck = 0;
    if (timeInfo.timeInitialized && millis() - lastMaintenanceCheck > 60000) {
        lastMaintenanceCheck = millis();
        time_t now = getCurrentTime();
        struct tm timeinfo;
        localtime_r(&now, &timeinfo);

        if (timeinfo.tm_hour == 4 && timeinfo.tm_min == 0 && lastRestartDayOfYear != timeinfo.tm_yday) {
            Serial.println("Daily 04:00 restart: Disconnecting WiFi and MQTT to reclaim memory");

            // Disconnect MQTT cleanly
            if (client.connected()) {
                client.disconnect();
            }

            // Reconnect WiFi
            WiFi.disconnect(true);
            delay(500);
            setup_wifi();

            // Force immediate MQTT reconnect attempt
            lastReconnectAttempt = 0;

            lastRestartDayOfYear = timeinfo.tm_yday;
        }
    }
}

void checkOverwriteExpiries() {
    unsigned long currentMillis = millis();
    for (auto& pair : pinStates) {
        int pin = pair.first;
        PinState& state = pair.second;

        if (state.isOverwritten && currentMillis - state.overwriteStartedAt >= OVERWRITE_DURATION) {
            Serial.println("Overwrite expired for pin " + String(pin));
            
            // Determine if this pin is controlled by the schedule
            bool controlledBySchedule = false;
            if (strlen(currentSchedule) > 0) {
				for (const auto& channel : activeChannels) {
					if (channel.pin == pin) {
						controlledBySchedule = true;
						break;
					}
				}
            }

            // Without a usable EEPROM, NTP, or controller clock there is no
            // scheduled value to restore when an overwrite expires.
            if (!controlledBySchedule || !scheduleTimeAvailableThisBoot) {
                Serial.println("No usable scheduled value for pin " + String(pin) + ", turning off");
                if (!ledcWrite(pin, 0)) {
                    recordLastError(
                        "pin_write_failed",
                        "error",
                        "LEDC write failed on pin " + String(pin)
                    );
                    // Preserve the overwrite state as a retry marker without
                    // hammering a failed peripheral every 200 ms.
                    state.overwriteStartedAt =
                        currentMillis -
                        (OVERWRITE_DURATION - SCHEDULE_ATTACH_RETRY_INTERVAL);
                    continue;
                }
                resolveLastErrorForPin("pin_write_failed", pin);
                state.isOverwritten = false;
                lastPinValues[pin] = 0;
				queueOutputAnnouncement();
				state.lastValue = 0;
			} else {
                state.isOverwritten = false;
				// The cached percentage still describes the value from before the
				// override. Invalidate it so a flat schedule is physically restored.
				for (auto& channel : activeChannels) {
					if (channel.pin == pin) {
						channel.currentValue = -1;
						break;
					}
				}
            }
        }
    }
}

void processCompleteMessage(String message) {
    String requestId;
    if (!unwrapRequestEnvelope(message, requestId)) {
        Serial.println("Invalid request envelope; ignoring message");
        return;
    }

    // Create JSON document for responses
    JsonDocument responses;
    responses["id"] = deviceId;
    responses["name"] = deviceName;
    if (requestId.length() > 0) {
        responses["requestId"] = requestId;
    }
    JsonArray commands = responses["responses"].to<JsonArray>();
    
    // Handle multiple commands separated by semicolon
    int startPos = 0;
    int endPos;
    int cmdIndex = 0;
    while ((endPos = message.indexOf(';', startPos)) != -1) {
        String response = processCommand(message.substring(startPos, endPos));
        if (response.length() > 0) {
            JsonObject cmd = commands.add<JsonObject>();
            cmd["index"] = cmdIndex;
            cmd["response"] = response;
        }
        startPos = endPos + 1;
        cmdIndex++;
    }
    // Process the last or only command
    if (startPos < message.length()) {
        String response = processCommand(message.substring(startPos));
        if (response.length() > 0) {
            JsonObject cmd = commands.add<JsonObject>();
            cmd["index"] = cmdIndex;
            cmd["response"] = response;
        }
    }
    
    // Publish responses if any commands were processed
    if (commands.size() > 0) {
        String responseStr;
        serializeJson(responses, responseStr);
        if (TEST) {
            Serial.println("Publishing response to test/aquarium/response: " + responseStr);
            publishWithRetry("test/aquarium/response", responseStr.c_str());
            Serial.println("Published to test/aquarium/response");
        } else {
            Serial.println("Publishing response to aquarium/response: " + responseStr);
            publishWithRetry("aquarium/response", responseStr.c_str());
            Serial.println("Published to aquarium/response");
        }
    }
}
