#include <Arduino.h>

const int MAX_INPUT_LENGTH = 64; // Maximum length for input command
const int PWM_PINS[] = {3, 5, 6, 9, 10, 11}; // PWM-capable pins on Arduino Nano
const int NUM_PWM_PINS = sizeof(PWM_PINS) / sizeof(PWM_PINS[0]);
const String whodis = "ch1";

bool isPWMPin(int pin) {
  for (int i = 0; i < NUM_PWM_PINS; i++) {
    if (PWM_PINS[i] == pin) return true;
  }
  return false;
}

String doStuff(String line) {
  String returned = "";
  int pin, value;
  char name;
  String args;
  
  int index = 0;
  while (index < line.length()) {
    int nextIndex = line.indexOf(';', index);
    if (nextIndex == -1) {
      nextIndex = line.length();
    }
    String cmd = line.substring(index, nextIndex);
    index = nextIndex + 1;
  
    if (cmd.length() > 0) {
      name = cmd.charAt(0);
      args = cmd.substring(1); // Get the arguments part of the command
      args.trim(); // Trim whitespace in place

      switch (name) {
        case 's':
          if (sscanf(args.c_str(), "%d %d", &pin, &value) == 2) {
            if (isPWMPin(pin)) {
              if (value >= 0 && value <= 255){
                analogWrite(pin, value);
                returned += cmd + ";"; // Echo the command back
              } else{
                returned += "Error: Invalid value;";
              }
            } else {
              returned += "Error: Invalid pin;";
            }
          } else {
            returned += "Error: Invalid arguments for 's' command;";
          }
          break;
        case 'p':
          returned += "o;";
          break;
        case 'w':
          returned += whodis + ";";
          break;
        default:
          returned += "Error: Unknown command;";
          break;
      }
    }
  }

  return returned;
}

void setup() {
  Serial.begin(9600);
}

void loop() {
  static char inputBuffer[MAX_INPUT_LENGTH];
  static int bufferPosition = 0;

  while (Serial.available() > 0 && bufferPosition < MAX_INPUT_LENGTH - 1) {
    char inChar = Serial.read();
    if (inChar == '\n') {
      inputBuffer[bufferPosition] = '\0'; // Null-terminate the string
      String output = doStuff(inputBuffer);
      Serial.println(output);
      bufferPosition = 0; // Reset buffer position
    } else if (inChar >= 32 && inChar <= 126) { // Readable ASCII characters
      inputBuffer[bufferPosition++] = inChar;
    }
    // Ignore other characters
  }
}
