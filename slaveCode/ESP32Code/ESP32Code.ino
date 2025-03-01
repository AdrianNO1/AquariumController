#include <WiFi.h>
#include <PubSubClient.h>
#include <EEPROM.h>
#include <ArduinoJson.h>
#include <map>
#include <string>
#include <vector>  // Added for std::vector
#include <SPIFFS.h>
#include <time.h>  // Added for time functions

unsigned long lastReconnectAttempt = 0;
const unsigned long reconnectInterval = 5000; // 5 seconds
const char* ssid = "ASUS+";
const char* password = "nemo1234";
const char* mqtt_server = "192.168.1.73";
const int mqtt_port = 1883;
const char* DEFAULT_DEVICE_NAME = "ESP32_Device"; // Default name

const int DEFAULT_FREQ = 5000; // Default frequency in Hz
const int DEFAULT_RES = 8;		 // Default resolution in bits

const char* VERSION = "3w";
const bool TEST = false;
const char* ntpServer = "pool.ntp.org";  // NTP server for time sync
const long gmtOffset_sec = 0;           // GMT offset in seconds (UTC)
const int daylightOffset_sec = 0;      // No daylight savings offset

// Chunking configuration
#define MAX_CHUNK_SIZE 200
#define MAX_CHUNKS 50
#define CHUNK_TIMEOUT 10000  // 10 seconds timeout for receiving all chunks

struct ChunkInfo {
    String data;
    bool received;
};

struct ChunkedMessage {
    ChunkInfo chunks[MAX_CHUNKS];
    int totalChunks;
    unsigned long lastChunkTime;
    bool complete;
};

ChunkedMessage currentMessage;

// EEPROM configuration
#define EEPROM_SIZE 512
#define NAME_ADDR 0
#define ID_ADDR 64
#define FREQ_ADDR 128
#define RES_ADDR 132
#define SCHEDULE_UPDATE_INTERVAL 1000  // Check schedule every 1000ms

const unsigned long OVERWRITE_DURATION = 120000; // 120 seconds in milliseconds

struct PinState {
    int lastValue;
    bool isOverwritten;
    unsigned long overwriteExpiry;
};
std::map<int, PinState> pinStates;

WiFiClient espClient;
PubSubClient client(espClient);

bool attachedPins[64] = {false};
int lastPinValues[64] = {0};

String deviceName;
String deviceId;
int freq;
int resolution;

unsigned long lastScheduleUpdate = 0;

String currentSchedule = "";
unsigned long syncTimeOffset = 0;

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
String readFromEEPROM(int startAddr) {
    String data;
    char ch;
    int addr = startAddr;
    while ((ch = EEPROM.read(addr)) != '\0' && addr < EEPROM_SIZE) {
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
void writeToEEPROM(int startAddr, String data) {
    // Sanitize the input string
    String sanitized = "";
    for (char c : data) {
        if (c >= 32 && c <= 126) {  // Only allow printable ASCII characters
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
        } else {
            Serial.println("EEPROM verification failed! Written: " + sanitized + ", Read: " + verification);
        }
    }
}

void initializeEEPROM() {
	String storedName = readFromEEPROM(NAME_ADDR);
	if (storedName.length() == 0 || storedName[0] == 0xFF) {	// Check if EEPROM is empty or corrupted
		Serial.println("Initializing EEPROM with default device name");
		writeToEEPROM(NAME_ADDR, String(DEFAULT_DEVICE_NAME));
		deviceName = DEFAULT_DEVICE_NAME;
	} else {
		deviceName = storedName;
	}
	
	String storedId = readFromEEPROM(ID_ADDR);
	if (storedId.length() == 0 || storedId[0] == 0xFF) {
		deviceId = generateId();
		writeToEEPROM(ID_ADDR, deviceId);
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
	
	Serial.println("Device Name: " + deviceName);
	Serial.println("Device ID: " + deviceId);
	Serial.println("Frequency: " + String(freq) + " Hz");
	Serial.println("Resolution: " + String(resolution) + " bits");
}

void storeSchedule(const String& schedule) {
    // Open file for writing
    File file = SPIFFS.open("/schedule.json", "w");
    if (!file) {
        Serial.println("Failed to open schedule file for writing");
        return;
    }
    
    // Write the schedule to the file
    if (file.print(schedule)) {
        Serial.println("Schedule saved to SPIFFS, size: " + String(schedule.length()) + " bytes");
    } else {
        Serial.println("Schedule write failed");
    }
    
    file.close();
}

String loadSchedule() {
    // Check if file exists
    if (!SPIFFS.exists("/schedule.json")) {
        Serial.println("No saved schedule found");
        return "";
    }
    
    // Open file for reading
    File file = SPIFFS.open("/schedule.json", "r");
    if (!file) {
        Serial.println("Failed to open schedule file for reading");
        return "";
    }
    
    // Read the schedule from the file
    String schedule = "";
    while (file.available()) {
        schedule += (char)file.read();
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

void processSchedule(const String& schedule) {
    StaticJsonDocument<4096> doc;
    DeserializationError error = deserializeJson(doc, schedule);
    
    if (error) {
        Serial.println("Failed to parse schedule");
        return;
    }

    // Store the schedule
    storeSchedule(schedule);
    currentSchedule = schedule;
    
    // Get sync time from schedule
    unsigned long scheduleTime = doc["syncTime"].as<unsigned long>();
    
    // Update our time if we have syncTime in the schedule
    if (scheduleTime > 0) {
        // Set current time based on syncTime
        struct tm timeinfo;
        time_t syncTime = scheduleTime;
        localtime_r(&syncTime, &timeinfo);
        
        Serial.print("Syncing time to: ");
        Serial.println(&timeinfo, "%A, %B %d %Y %H:%M:%S");
        
        timeInfo.lastSyncTime = syncTime;
        timeInfo.lastSavedTime = syncTime;
        timeInfo.lastMillis = millis();
        timeInfo.timeInitialized = true;
        
        // Save to EEPROM
        saveTimeInfo();
    }
    
    // Clear existing channel configurations
    activeChannels.clear();
    
    // Setup channels
    JsonArray channels = doc["c"].as<JsonArray>();
    for (JsonVariant channel : channels) {
        int pin = channel["o"].as<int>();
        // Use as<int>() instead of as<char>() and then cast to int8_t
        int8_t type = (int8_t)channel["t"].as<int>();
        
        // Initialize channel
        activeChannels.push_back({pin, 0, type});
        
        // Setup PWM for this pin
        if (!attachedPins[pin]) {
            if (ledcAttach(pin, freq, resolution)) {
                attachedPins[pin] = true;
                ledcWrite(pin, 0);
            }
        }
    }
}

void setup_wifi() {
	Serial.println("Connecting to WiFi...");
	Serial.print("SSID: ");
	Serial.println(ssid);
	
	WiFi.begin(ssid, password);
	
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

void announcePresence() {
	StaticJsonDocument<200> doc;
	doc["name"] = deviceName;
	doc["freq"] = freq;
	doc["res"] = resolution;
	doc["id"] = deviceId;
	doc["status"] = "online";
  	doc["version"] = VERSION;
	
	// Calculate and send a hash of the schedule instead of the entire schedule
	if (currentSchedule.length() > 0) {
		// Parse the schedule to remove syncTime before hashing
		StaticJsonDocument<4096> scheduleDoc;
		deserializeJson(scheduleDoc, currentSchedule);
		
		// Create a copy without syncTime for consistent hashing
		StaticJsonDocument<4096> channelsOnlyDoc;
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
	if (TEST) {
		client.publish("test/aquarium/announce", message.c_str());
	} else {
		client.publish("aquarium/announce", message.c_str());
	}
	Serial.println("Announced presence: " + message);
}

String handleScheduleCommand(const String& scheduleJson) {
    // Verify JSON is valid
    StaticJsonDocument<4096> doc;
    DeserializationError error = deserializeJson(doc, scheduleJson);
    if (error) {
        return "E: Invalid JSON";
    }
    
    // Store and process the schedule
    storeSchedule(scheduleJson);
    currentSchedule = scheduleJson;
    
    // Set time offset
    syncTimeOffset = doc["syncTime"].as<unsigned long>() - (millis() / 1000);
    
    // Clear and setup channels
    activeChannels.clear();
    
    // Setup channels
    JsonArray channels = doc["c"].as<JsonArray>();
    for (JsonVariant channel : channels) {
        int pin = channel["o"].as<int>();
        // Use as<int>() instead of as<char>() and then cast to int8_t
        int8_t type = (int8_t)channel["t"].as<int>();
        
        // Initialize channel
        activeChannels.push_back({pin, 0, type});
        
        // Setup PWM for this pin
        if (!attachedPins[pin]) {
            if (ledcAttach(pin, freq, resolution)) {
                attachedPins[pin] = true;
                ledcWrite(pin, 0);
            }
        }
    }
    
    // Return a simple confirmation instead of the entire schedule
    return "schedule_ok";
}

String handleCommand(String command, String args) {
	Serial.println("Handling command: " + command + " with args: " + args);
	String response = "E: Invalid command";
	if (command == "s") {
		int pin, value, overwrite;
		if (sscanf(args.c_str(), "%d %d %d", &pin, &value, &overwrite) == 3) {
				Serial.println("Pin: " + String(pin));
				Serial.println("Value: " + String(value));
				Serial.println("Overwrite: " + String(overwrite));
				if (value >= 0 && value <= 255 && (overwrite == 0 || overwrite == 1)) {
						if (!attachedPins[pin]) {
								if (ledcAttach(pin, freq, resolution)) {
										attachedPins[pin] = true;
										ledcWrite(pin, value);
										lastPinValues[pin] = value;
										
										// Update pin state with overwrite information
										if (overwrite == 1) {
											pinStates[pin] = {value, true, millis() + OVERWRITE_DURATION};
										} else {
											pinStates[pin] = {value, false, 0};
										}
										
										response = "s " + String(pin) + " " + String(value) + " " + String(overwrite);
								} else {
										response = "E: LEDC attach failed";
								}
						} else {
								ledcWrite(pin, value);
								lastPinValues[pin] = value;
								
								// Update pin state with overwrite information
								if (overwrite == 1) {
									pinStates[pin] = {value, true, millis() + OVERWRITE_DURATION};
								} else {
									pinStates[pin] = {value, false, 0};
								}
								
								response = "s " + String(pin) + " " + String(value) + " " + String(overwrite);
						}
				} else {
						response = "E: Invalid value or overwrite parameter";
				}
		} else {
				response = "E: Invalid arguments";
		}
	}
	
	else if (command == "p" || command == "e") {
		if (command == "p") {
			response = "o";
		}
		else if (command == "e") {
			String args_array[4];
			int current_index = 0;
			int last_space = 0;
			int next_space = args.indexOf(' ');
			
			while (next_space >= 0 && current_index < 4) {
				args_array[current_index++] = args.substring(last_space, next_space);
				last_space = next_space + 1;
				next_space = args.indexOf(' ', last_space);
			}
			if (last_space < args.length()) {
				args_array[current_index++] = args.substring(last_space);
			}
	
			// args_array[0] is the new name
			// args_array[1] is the new frequency
			// args_array[2] is the new resolution

      
			
			String newName = args_array[0];
			int newFreq = args_array[1].toInt();
			int newRes = args_array[2].toInt();

     		Serial.println(deviceName + " " + newName + " " + String(newFreq) + " " + String(newRes));
			
			if (true) {
				bool needReattach = false;
				
				// Check and update name if different
				if (newName != deviceName) {
					writeToEEPROM(NAME_ADDR, newName);
					deviceName = readFromEEPROM(NAME_ADDR);
				}
				
				// Check and update frequency if different
				if (newFreq != freq && newFreq) {
					freq = newFreq;
					EEPROM.put(FREQ_ADDR, freq);
					needReattach = true;
				}
				
				// Check and update resolution if different
				if (newRes != resolution && newRes >= 1 && newRes <= 16) {
					resolution = newRes;
					EEPROM.put(RES_ADDR, resolution);
					needReattach = true;
				}
				
				EEPROM.commit();
				
				// If frequency or resolution changed, reattach all active pins
				if (needReattach) {
					for (int pin = 0; pin < 64; pin++) {
						if (attachedPins[pin]) {
							ledcDetach(pin);
							if (ledcAttach(pin, freq, resolution)) {
								ledcWrite(pin, lastPinValues[pin]);
							}
						}
					}
				}
				
				response = deviceName + " " + String(freq) + " " + String(resolution);
			} else {
				response = "E: Invalid arguments format";
			}
		}
	}
	else if (command == "sync") {
		unsigned long serverTime = args.toInt();
		if (serverTime > 0) {
			// Update our internal time
			time_t syncTime = serverTime;
			timeInfo.lastSyncTime = syncTime;
			timeInfo.lastSavedTime = syncTime;
			timeInfo.lastMillis = millis();
			timeInfo.timeInitialized = true;
			saveTimeInfo();
			
			struct tm timeinfo;
			localtime_r(&syncTime, &timeinfo);
			Serial.print("Time synchronized to: ");
			Serial.println(&timeinfo, "%A, %B %d %Y %H:%M:%S");
			
			response = String(serverTime);
		} else {
			response = "E: Invalid time value";
		}
	}

	return response;
}

void clearEEPROM() {
    for (int i = 0; i < EEPROM_SIZE; i++) {
        EEPROM.write(i, 0);
    }
    EEPROM.commit();
}

void callback(char* topic, byte* payload, unsigned int length) {
	Serial.println("Message received on topic: " + String(topic));
	
	String message;
	for (int i = 0; i < length; i++) {
		message += (char)payload[i];
	}
	Serial.println("Message content: " + message);

	if (!TEST && String(topic) == "aquarium/command" || TEST && String(topic) == "test/aquarium/command") {
		// Check if this is a chunked message
		if (message.startsWith("chunk:")) {
			handleChunkedMessage(message.substring(6));
			return;
		}
		
		if (message == "discover") {
			Serial.println("Discover message received, announcing presence");
			announcePresence();
			return;
		}

		if (message == "clear") {
			Serial.println("Clearing EEPROM");
			clearEEPROM();
			initializeEEPROM();
			if (TEST) {
				client.publish("test/aquarium/response", "EEPROM cleared");
			} else {
				client.publish("aquarium/response", "EEPROM cleared");
			}
			return;
		}

		// Create JSON document for responses
		StaticJsonDocument<512> responses;
		responses["id"] = deviceId;
		responses["name"] = deviceName;
		JsonArray commands = responses.createNestedArray("responses");

		// Handle multiple commands separated by semicolon
		int startPos = 0;
		int endPos;
		int cmdIndex = 0;
		while ((endPos = message.indexOf(';', startPos)) != -1) {
			String response = processCommand(message.substring(startPos, endPos));
			if (response.length() > 0) {
				JsonObject cmd = commands.createNestedObject();
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
				JsonObject cmd = commands.createNestedObject();
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
				client.publish("test/aquarium/response", responseStr.c_str());
				Serial.println("Published to test/aquarium/response");
			} else {
				Serial.println("Publishing response to aquarium/response: " + responseStr);
				client.publish("aquarium/response", responseStr.c_str());
				Serial.println("Published to aquarium/response");
			}
		}
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

// Initialize time from NTP server
void initializeTime() {
    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("Initializing time via NTP");
        configTime(gmtOffset_sec, daylightOffset_sec, ntpServer);
        
        struct tm timeinfo;
        if (getLocalTime(&timeinfo)) {
            time_t now;
            time(&now);
            timeInfo.lastSyncTime = now;
            timeInfo.lastSavedTime = now;
            timeInfo.lastMillis = millis();
            timeInfo.timeInitialized = true;
            saveTimeInfo();
            Serial.println("Time initialized via NTP");
            Serial.print("Current time: ");
            Serial.println(&timeinfo, "%A, %B %d %Y %H:%M:%S");
        } else {
            Serial.println("Failed to obtain time from NTP");
        }
    } else {
        Serial.println("WiFi not connected, can't initialize time via NTP");
    }
}

// Save time information to EEPROM
void saveTimeInfo() {
    // Update lastSavedTime before saving
    if (timeInfo.timeInitialized) {
        // Calculate current time based on elapsed millis
        unsigned long elapsed = millis() - timeInfo.lastMillis;
        timeInfo.lastSavedTime = timeInfo.lastSavedTime + (elapsed / 1000);
        timeInfo.lastMillis = millis();
    }
    
    // Save to EEPROM
    EEPROM.put(TIME_INFO_ADDR, timeInfo);
    EEPROM.commit();
    Serial.println("Time info saved to EEPROM");
}

// Load time information from EEPROM
void loadTimeInfo() {
    EEPROM.get(TIME_INFO_ADDR, timeInfo);
    
    // Verify if the loaded data makes sense
    if (timeInfo.lastSavedTime < 1735689600) { // Jan 1, 2025 as a sanity check
        Serial.println("Invalid time data in EEPROM, resetting");
        timeInfo.timeInitialized = false;
        return;
    }
    
    // Update the time based on how long we've been powered off
    // The difference between current millis() (which is near 0 after reboot)
    // and lastMillis tells us how long the device was off
    time_t currentTime = timeInfo.lastSavedTime;
    timeInfo.lastMillis = millis();
    timeInfo.timeInitialized = true;
    
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

void setup() {
	Serial.begin(115200);
	Serial.println("\nStarting up...");
	
	// Initialize EEPROM with proper partition verification
	if (!EEPROM.begin(EEPROM_SIZE)) {
		Serial.println("Failed to initialize EEPROM!");
	}
	
	initializeEEPROM();
	loadTimeInfo(); // Load time info from EEPROM

    if (!SPIFFS.begin(true)) {
        Serial.println("SPIFFS initialization failed!");
    } else {
        Serial.println("SPIFFS initialized successfully");
    }

  	// Load saved schedule if it exists
	String savedSchedule = loadSchedule();
	if (savedSchedule.length() > 0) {
		processSchedule(savedSchedule);
	}
	
	setup_wifi();
	initializeTime();
	
	client.setServer(mqtt_server, mqtt_port);
	client.setKeepAlive(60);	// Set keepalive to 60 seconds
	client.setCallback(callback);
	
	Serial.println("Setup complete");
}

void loop() {
	if (!client.connected()) {
		unsigned long currentMillis = millis();
		if (currentMillis - lastReconnectAttempt >= reconnectInterval) {
			lastReconnectAttempt = currentMillis;
			Serial.println("MQTT disconnected, attempting to reconnect...");
			
			// Generate a random client ID
			String clientId = "ESP32Client-";
			clientId += String(random(0xffff), HEX);
			
			Serial.println("Attempting MQTT connection with client ID: " + clientId);
			Serial.println("Broker: " + String(mqtt_server));
			
			// Print WiFi status
			Serial.println("WiFi status - SSID: " + String(WiFi.SSID()) + 
										" Signal strength: " + String(WiFi.RSSI()) + "dBm");
			
			if (client.connect(clientId.c_str())) {
				Serial.println("MQTT connected");
				if (TEST) {
					client.subscribe("test/aquarium/command");
				} else {
					client.subscribe("aquarium/command");
				}
				announcePresence();
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

	// Check for chunked message timeout
	checkChunkTimeout();
	
	// Save time periodically (every hour)
	static unsigned long lastTimeSave = 0;
	if (timeInfo.timeInitialized && millis() - lastTimeSave > 3600000) { // 1 hour
		saveTimeInfo();
		lastTimeSave = millis();
	}

	// Process schedule if active
	if (currentSchedule.length() > 0) {
		unsigned long currentMillis = millis();
		
		// Only update if SCHEDULE_UPDATE_INTERVAL has passed
		if (currentMillis - lastScheduleUpdate >= SCHEDULE_UPDATE_INTERVAL) {
			lastScheduleUpdate = currentMillis;
			
			// Get current minute of day (0-1439)
			int currentMinute = getCurrentMinuteOfDay();
			
			if (currentMinute > 0 || timeInfo.timeInitialized) {
				StaticJsonDocument<4096> doc;
				deserializeJson(doc, currentSchedule);
				
				// Process each channel in the array
				JsonArray channels = doc["c"].as<JsonArray>();
				for (size_t i = 0; i < channels.size(); i++) {
					JsonVariant channel = channels[i];
					int pin = channel["o"].as<int>();
					JsonArray links = channel["l"].as<JsonArray>();
					// Get type as integer
					int8_t type = (int8_t)channel["t"].as<int>();
					
					// Find the matching channel in our active channels
					for (size_t j = 0; j < activeChannels.size(); j++) {
						if (activeChannels[j].pin == pin) {
							// Check if pin is currently overwritten
							auto pinStateIt = pinStates.find(pin);
							if (pinStateIt != pinStates.end() && pinStateIt->second.isOverwritten) {
								// Check if overwrite has expired
								if (currentMillis >= pinStateIt->second.overwriteExpiry) {
									pinStateIt->second.isOverwritten = false;
								} else {
									continue; // Skip schedule update for this pin
								}
							}
							
							int targetValue = getScheduledValue(links, currentMinute);
							
							// Only update if value has changed
							if (activeChannels[j].currentValue != targetValue) {
								int pwmValue = (targetValue * ((1 << resolution) - 1)) / 100;
								Serial.println("Schedule: Setting pin " + String(pin) + " to " + String(pwmValue) + 
											  " (" + String(targetValue) + "%) at minute " + String(currentMinute) +
											  " [Type: " + (type == 112 ? "pump" : "light") + "]");
								ledcWrite(pin, pwmValue);
								activeChannels[j].currentValue = targetValue;
							}
							break;
						}
					}
				}
			} else {
				Serial.println("Skipping schedule update: Time not initialized");
			}
		}
	}
 
	client.loop();
}

void handleChunkedMessage(String chunkData) {
    // Parse chunk data: format is "index:total:isLast:data"
    int firstColon = chunkData.indexOf(':');
    int secondColon = chunkData.indexOf(':', firstColon + 1);
    int thirdColon = chunkData.indexOf(':', secondColon + 1);
    
    if (firstColon == -1 || secondColon == -1 || thirdColon == -1) {
        Serial.println("Invalid chunk format: " + chunkData);
        return;
    }
    
    int chunkIndex = chunkData.substring(0, firstColon).toInt();
    int totalChunks = chunkData.substring(firstColon + 1, secondColon).toInt();
    bool isLast = chunkData.substring(secondColon + 1, thirdColon).toInt() == 1;
    String data = chunkData.substring(thirdColon + 1);
    
    Serial.println("Received chunk " + String(chunkIndex + 1) + " of " + String(totalChunks) + 
                  ", isLast: " + String(isLast) + ", size: " + String(data.length()) + " bytes");
    
    // Initialize or update chunked message
    if (chunkIndex == 0 || currentMessage.lastChunkTime == 0 || 
        millis() - currentMessage.lastChunkTime > CHUNK_TIMEOUT) {
        // Reset current message if this is the first chunk or if timeout occurred
        Serial.println("Initializing new chunked message with " + String(totalChunks) + " chunks");
        for (int i = 0; i < MAX_CHUNKS; i++) {
            currentMessage.chunks[i].data = "";
            currentMessage.chunks[i].received = false;
        }
        currentMessage.totalChunks = totalChunks;
        currentMessage.complete = false;
        currentMessage.lastChunkTime = millis();
    }
    
    // Store this chunk
    if (chunkIndex < MAX_CHUNKS) {
        currentMessage.chunks[chunkIndex].data = data;
        currentMessage.chunks[chunkIndex].received = true;
        currentMessage.lastChunkTime = millis();
        
        // Check if we have all chunks
        bool allReceived = true;
        int receivedCount = 0;
        for (int i = 0; i < totalChunks; i++) {
            if (currentMessage.chunks[i].received) {
                receivedCount++;
            } else {
                allReceived = false;
            }
        }
        
        Serial.println("Received " + String(receivedCount) + " of " + String(totalChunks) + " chunks");
        
        // If all chunks received, process the complete message
        if (allReceived) {
            Serial.println("All chunks received, assembling complete message");
            String completeMessage = "";
            for (int i = 0; i < totalChunks; i++) {
                completeMessage += currentMessage.chunks[i].data;
            }
            
            Serial.println("Complete message size: " + String(completeMessage.length()) + " bytes");
            Serial.println("Processing complete message: " + completeMessage);
            
            // Process the complete message
            processCompleteMessage(completeMessage);
            
            // Reset for next chunked message
            for (int i = 0; i < MAX_CHUNKS; i++) {
                currentMessage.chunks[i].data = "";
                currentMessage.chunks[i].received = false;
            }
            currentMessage.complete = true;
            currentMessage.lastChunkTime = 0;
            Serial.println("Chunked message processing complete");
        }
    } else {
        Serial.println("Error: Chunk index " + String(chunkIndex) + " exceeds maximum chunks " + String(MAX_CHUNKS));
    }
}

void processCompleteMessage(String message) {
    // Create JSON document for responses
    StaticJsonDocument<512> responses;
    responses["id"] = deviceId;
    responses["name"] = deviceName;
    JsonArray commands = responses.createNestedArray("responses");
    
    // Handle multiple commands separated by semicolon
    int startPos = 0;
    int endPos;
    int cmdIndex = 0;
    while ((endPos = message.indexOf(';', startPos)) != -1) {
        String response = processCommand(message.substring(startPos, endPos));
        if (response.length() > 0) {
            JsonObject cmd = commands.createNestedObject();
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
            JsonObject cmd = commands.createNestedObject();
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
            client.publish("test/aquarium/response", responseStr.c_str());
            Serial.println("Published to test/aquarium/response");
        } else {
            Serial.println("Publishing response to aquarium/response: " + responseStr);
            client.publish("aquarium/response", responseStr.c_str());
            Serial.println("Published to aquarium/response");
        }
    }
}

void checkChunkTimeout() {
    // Check if we have an incomplete chunked message that has timed out
    if (!currentMessage.complete && currentMessage.lastChunkTime > 0) {
        unsigned long currentTime = millis();
        if (currentTime - currentMessage.lastChunkTime > CHUNK_TIMEOUT) {
            Serial.println("Chunked message timed out, resetting");
            // Reset the chunked message
            for (int i = 0; i < MAX_CHUNKS; i++) {
                currentMessage.chunks[i].data = "";
                currentMessage.chunks[i].received = false;
            }
            currentMessage.complete = false;
            currentMessage.lastChunkTime = 0;
        }
    }
}
