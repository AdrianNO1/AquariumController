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
const int DEFAULT_RES = 8;     // Default resolution in bits

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
    data += ch;
    addr++;
  }
  Serial.println("Read from EEPROM at address " + String(startAddr) + ": " + data);
  return data;
}

// Write string to EEPROM
void writeToEEPROM(int startAddr, String data) {
  for (int i = 0; i < data.length(); i++) {
    EEPROM.write(startAddr + i, data[i]);
  }
  EEPROM.write(startAddr + data.length(), '\0');
  EEPROM.commit();
  Serial.println("Wrote to EEPROM at address " + String(startAddr) + ": " + data);
}

void initializeEEPROM() {
  String storedName = readFromEEPROM(NAME_ADDR);
  if (storedName.length() == 0 || storedName[0] == 0xFF) {  // Check if EEPROM is empty or corrupted
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
  if (freq <= 0 || freq > 40000) {  // Validate frequency
    freq = DEFAULT_FREQ;
    EEPROM.put(FREQ_ADDR, freq);
    EEPROM.commit();
  }

  // Read resolution from EEPROM
  EEPROM.get(RES_ADDR, resolution);
  if (resolution < 1 || resolution > 16) {  // Validate resolution
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
  
  String message;
  serializeJson(doc, message);
  client.publish("aquarium/announce", message.c_str());
  Serial.println("Announced presence: " + message);
}

void handleCommand(String command, String args) {
  Serial.println("Handling command: " + command + " with args: " + args);
  
  StaticJsonDocument<200> response;
  response["id"] = deviceId;
  response["command"] = command;
  
  if (command == "s") {
    int pin, value;
    if (sscanf(args.c_str(), "%d %d", &pin, &value) == 2) {
        if (value >= 0 && value <= 255) {
            if (!attachedPins[pin]) {
                if (ledcAttach(pin, freq, resolution)) {
                    attachedPins[pin] = true;
                    ledcWrite(pin, value);
                    lastPinValues[pin] = value;  // Store the value
                    
                    response["status"] = "success";
                    response["echo"] = "s " + String(pin) + " " + String(value);
                } else {
                    response["status"] = "error";
                    response["error"] = "LEDC attach failed";
                }
            } else {
                ledcWrite(pin, value);
                lastPinValues[pin] = value;  // Store the value
                response["status"] = "success";
                response["echo"] = "s " + String(pin) + " " + String(value);
            }
        } else {
            response["status"] = "error";
            response["error"] = "Invalid value";
        }
    } else {
        response["status"] = "error";
        response["error"] = "Invalid arguments";
    }

    String responseStr;
    serializeJson(response, responseStr);
    client.publish(("aquarium/response/" + deviceName).c_str(), responseStr.c_str());
    Serial.println("Published response: " + responseStr);
  }
  
  else if (command == "p" || command == "e") {
    // Extract target device ID from args
    int spacePos = args.indexOf(' ');
    String targetId = spacePos == -1 ? args : args.substring(0, spacePos);
    String cmdArgs = spacePos == -1 ? "" : args.substring(spacePos + 1);
    String oldDeviceName = deviceName;
    
    // Only process if the command is meant for this device
    if (targetId == deviceId) {
      if (command == "p") {
        response["status"] = "success";
        response["echo"] = "o";
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
      
          // Now args_array[0] is the ID
          // args_array[1] is the new name
          // args_array[2] is the new frequency
          // args_array[3] is the new resolution
          
          String targetId = args_array[0];
          String newName = args_array[1];
          int newFreq = args_array[2].toInt();
          int newRes = args_array[3].toInt();
          
          if (true) {
              bool needReattach = false;
              
              // Check and update name if different
              if (newName != deviceName) {
                  writeToEEPROM(NAME_ADDR, newName);
                  deviceName = readFromEEPROM(NAME_ADDR);
                  client.unsubscribe(("aquarium/command/" + oldDeviceName).c_str());
                  client.subscribe(("aquarium/command/" + deviceName).c_str());
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
              
              response["status"] = "success";
              response["echo"] = deviceName + " " + String(freq) + " " + String(resolution);
          } else {
              response["status"] = "error";
              response["error"] = "Invalid arguments format";
          }
      }
      
      String responseStr;
      serializeJson(response, responseStr);
      client.publish(("aquarium/response/" + oldDeviceName).c_str(), responseStr.c_str());
      Serial.println("Published response: " + responseStr);
    } else {
      Serial.println("Command not for this device. Target ID: " + targetId + ", This device ID: " + deviceId);
    }
  } else {
    response["status"] = "error";
    response["error"] = "Invalid command";
    
    String responseStr;
    serializeJson(response, responseStr);
    client.publish(("aquarium/response/" + deviceName).c_str(), responseStr.c_str());
    Serial.println("Published response: " + responseStr);
  }
}

void callback(char* topic, byte* payload, unsigned int length) {
  Serial.println("Message received on topic: " + String(topic));
  
  String message;
  for (int i = 0; i < length; i++) {
    message += (char)payload[i];
  }
  Serial.println("Message content: " + message);

  if (String(topic) == "aquarium/discover") {
      if (message == "announce") {
          Serial.println("Discover message received, announcing presence");
          announcePresence();
          return;
      }
  }
  
  StaticJsonDocument<200> doc;
  DeserializationError error = deserializeJson(doc, message);
  
  if (error) {
    Serial.println("JSON parsing failed: " + String(error.c_str()));
    return;
  }
  
  String command = doc["command"];
  String args = doc["args"];
  
  handleCommand(command, args);
}

void setup() {
  Serial.begin(115200);
  Serial.println("\nStarting up...");
  
  EEPROM.begin(EEPROM_SIZE);
  initializeEEPROM();
  
  setup_wifi();
  
  client.setServer(mqtt_server, mqtt_port);
  client.setKeepAlive(60);  // Set keepalive to 60 seconds
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
        client.subscribe(("aquarium/command/" + deviceName).c_str());
        client.subscribe("aquarium/discover");
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
