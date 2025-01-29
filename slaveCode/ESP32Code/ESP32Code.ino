#include <WiFi.h>
#include <PubSubClient.h>
#include <EEPROM.h>
#include <ArduinoJson.h>
unsigned long lastReconnectAttempt = 0;
const unsigned long reconnectInterval = 5000; // 5 seconds
const char* ssid = "ASUS+";
const char* password = "nemo1234";
const char* mqtt_server = "192.168.1.73";
const int mqtt_port = 1883;
const char* DEFAULT_DEVICE_NAME = "ESP32_Device"; // Default name

const int DEFAULT_FREQ = 5000; // Default frequency in Hz
const int DEFAULT_RES = 8;		 // Default resolution in bits

const char* VERSION = "2w";
const bool TEST = false;

// EEPROM configuration
#define EEPROM_SIZE 512
#define NAME_ADDR 0
#define ID_ADDR 64
#define FREQ_ADDR 128
#define RES_ADDR 132

WiFiClient espClient;
PubSubClient client(espClient);

bool attachedPins[64] = {false};
int lastPinValues[64] = {0};

String deviceName;
String deviceId;
int freq;
int resolution;

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
    
    for (int i = 0; i < sanitized.length(); i++) {
        EEPROM.write(startAddr + i, sanitized[i]);
    }
    EEPROM.write(startAddr + sanitized.length(), '\0');
    EEPROM.commit();
    Serial.println("Wrote to EEPROM at address " + String(startAddr) + ": " + sanitized);
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

void announcePresence() {
	StaticJsonDocument<200> doc;
	doc["name"] = deviceName;
	doc["freq"] = freq;
	doc["res"] = resolution;
	doc["id"] = deviceId;
	doc["status"] = "online";
  doc["version"] = VERSION;
	
	String message;
	serializeJson(doc, message);
	if (TEST) {
		client.publish("test/aquarium/announce", message.c_str());
	} else {
		client.publish("aquarium/announce", message.c_str());
	}
	Serial.println("Announced presence: " + message);
}

String handleCommand(String command, String args) {
	Serial.println("Handling command: " + command + " with args: " + args);
	String response = "E: Invalid command";
	if (command == "s") {
		int pin, value;
		if (sscanf(args.c_str(), "%d %d", &pin, &value) == 2) {
				Serial.println("Pin: " + String(pin));
				Serial.println("Value: " + String(value));
				if (value >= 0 && value <= 255) {
						if (!attachedPins[pin]) {
								if (ledcAttach(pin, freq, resolution)) {
										attachedPins[pin] = true;
										ledcWrite(pin, value);
										lastPinValues[pin] = value;
										
										response = "s " + String(pin) + " " + String(value);
								} else {
										response = "E: LEDC attach failed";
								}
						} else {
								ledcWrite(pin, value);
								lastPinValues[pin] = value;
								response = "s " + String(pin) + " " + String(value);
						}
				} else {
						response = "E: Invalid value";
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
				client.publish("test/aquarium/response", responseStr.c_str());
			} else {
				client.publish("aquarium/response", responseStr.c_str());
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

void setup() {
	Serial.begin(115200);
	Serial.println("\nStarting up...");
	
	EEPROM.begin(EEPROM_SIZE);
	initializeEEPROM();
	
	setup_wifi();
	
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
	client.loop();
}
