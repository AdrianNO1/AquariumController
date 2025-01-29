import paho.mqtt.client as mqtt
import json
import time
import threading
from typing import Dict, List
import traceback
import sys

class ESP32Manager:
    def __init__(self, slaves, test, logger=None):
        print("Initializing ESP32Manager...")
        self.client = mqtt.Client()
        self.client.on_connect = self.on_connect
        self.client.on_message = self.on_message
        print("Connecting to local MQTT broker...")
        self.client.connect("192.168.1.73", 1883, 60)  # Replace with your MQTT broker address if different
        
        self.slaves = slaves  # Reference to the global slaves list
        if logger is None:
            # create dummy logger object with empty functions
            logger = type("Logger", (), {"info": lambda self, msg: None, "error": lambda self, msg: None})()
        self.logger = logger
        self.responses: Dict[str, List] = {}  # Store command responses
        self.response_events: Dict[str, threading.Event] = {}
        self.TEST = test
        if test:
            print("IS TESTING MODE---------------------------------")
        
        self.client.loop_start()
        print("MQTT client loop started")
        
    def discover_devices(self):
        """Request all ESP32s to announce themselves"""
        print("Broadcasting device discovery message...")
        if self.TEST:
            self.client.publish("test/aquarium/command", "discover")
        else:
            self.client.publish("aquarium/command", "discover")
        
    def on_connect(self, client, userdata, flags, rc):
        print(f"Connected to MQTT broker with result code: {rc}")
        if self.TEST:
            client.subscribe("test/aquarium/announce")
            client.subscribe("test/aquarium/response")
        else:
            client.subscribe("aquarium/announce")
            client.subscribe("aquarium/response")
        print("Subscribed to required topics")
        self.discover_devices()
        
    def on_message(self, client, userdata, msg):
        print(f"\nReceived message on topic: {msg.topic}")
        decoded = msg.payload.decode()
        print(f"Message payload: {decoded}") # {"id":"58B55856","name":"ESP32_Device","commands":[{"index":2,"response":"o"}]}
        if decoded == "announce":
            print("Ignoring self-discovery message")
            return
        
        try:
            payload = json.loads(decoded)
            
            if not self.TEST and msg.topic == "aquarium/announce" or self.TEST and msg.topic == "test/aquarium/announce":
                device_id = payload["id"]
                device_name = payload["name"]
                if "version" in payload:
                    version = payload["version"]
                else:
                    version = "0"
                print(f"Device announcement received - ID: {device_id}, Name: {device_name}")
                
                # Check if device already exists in slaves list
                existing_device = None
                for device in self.slaves:
                    if device.get("wireless") and device.get("id") == device_id:
                        existing_device = device
                        break
                
                if existing_device:
                    print(f"Updating existing device: {device_id}")
                    existing_device["name"] = device_name
                    existing_device["freq"] = payload["freq"]
                    existing_device["res"] = payload["res"]
                    existing_device["status"] = "ok"
                    existing_device["lastused"] = int(time.time())
                    existing_device["error"] = ""
                    existing_device["version"] = version
                else:
                    print(f"Adding new device: {device_id}")
                    self.slaves.append({
                        "id": device_id,
                        "name": device_name,
                        "freq": payload["freq"],
                        "res": payload["res"],
                        "status": "ok",
                        "error": "",
                        "lastused": int(time.time()),
                        "wireless": True,
                        "version": version
                    })
                print("Current slaves list:", json.dumps([x for x in self.slaves if x.get("wireless")], indent=2))
            
            elif not self.TEST and msg.topic == "aquarium/response" or self.TEST and msg.topic == "test/aquarium/response":
                device_id = payload.get("id")
                device_name = payload.get("name", "unknown")
                responses = payload.get("responses")
                
                print(f"Command response received from {device_name} (ID: {device_id}), Responses: {responses}")

                self.responses[device_id] = payload
                if device_id in self.response_events:
                    self.response_events[device_id].set()
        
        except json.JSONDecodeError:
            print(f"Error: Invalid JSON received: {decoded}")

    def run_command(self, command_str: str, timeout: float = 3):
        try:
            print(f"\nRunning commands: {command_str}")
            
            # Split the command string on semicolons
            commands = [cmd.strip() for cmd in command_str.split(';') if cmd.strip()]
            if not commands:
                print("No commands to run.")
                return []

            expected_responses = {}
            for slave in self.slaves:
                if not slave.get("wireless"):
                    continue
                i = 0
                for cmd in command_str.split(";"):
                    parts = cmd.strip().split()
                    if len(parts) < 2:
                        print(f"Invalid command: {cmd}")
                        return
                    target = parts[0]
                    command = parts[1]
                    args = ' '.join(parts[2:])
                    print(slave)
                    if target == slave["name"] or target == slave["id"]:
                        if command == "s":
                            res = f"s {args}"
                        elif command == "e":
                            res = args
                        elif command == "p":
                            res = "o"
                        elif command == "clear":
                            res = "EEPROM cleared"
                        else:
                            print(f"Invalid command: {cmd}")
                            return
                        expected_responses[i] = {
                            "id": slave["id"],
                            "response": res
                        }
                        self.response_events[slave["id"]] = threading.Event()

                    i += 1

    
            # Publish the combined command string
            print(f"Publishing commands to topic: aquarium/command")
            print(f"Message: {command_str}")
            if self.TEST:
                self.client.publish("test/aquarium/command", command_str)
            else:
                self.client.publish("aquarium/command", command_str)
    
            # Wait for responses
            print(f"Waiting for responses (timeout: {timeout}s)...")
            start_time = time.time()
            while time.time() - start_time < timeout:
                all_events_set = all(self.response_events[expected_responses[key]["id"]].is_set() for key in expected_responses)
                if all_events_set:
                    break
                time.sleep(0.1)


            real_responses = {}

            print(expected_responses)
            
            for index in expected_responses.keys():
                expected = expected_responses[index]
                actual = self.responses.get(expected["id"])

                def do_error_stuff(error):
                    print(error)
                    for slave in self.slaves:
                        if not slave.get("wireless"):
                            continue
                        if slave["id"] == expected["id"]:
                            slave["status"] = "error"
                            slave["error"] = error
                            slave["lastused"] = int(time.time())
                            break
                    else:
                        print(f"Error: Could not update status for device {expected['id']}. It is missing from the slaves list.")

                if actual is None:
                    error = f"Command {index} failed: No response received"
                    do_error_stuff(error)
                    real_responses[index] = {"message": error, "status": False}
                    continue

                if "responses" not in actual:
                    error = f"Command {index} failed: Invalid response received", actual
                    do_error_stuff(error)
                    real_responses[index] = {"message": error, "status": False}
                    continue

                actual_actual = [x for x in actual["responses"] if x["index"] == index]
                if not actual_actual:
                    error = f"Command {index} failed: No response received for that specific index"
                    do_error_stuff(error)
                    real_responses[index] = {"message": error, "status": False}
                    continue

                actual_actual = actual_actual[0]
                if "response" not in actual_actual:
                    error = f"Command {index} failed: Invalid response received", actual
                    do_error_stuff(error)
                    real_responses[index] = {"message": error, "status": False}
                    continue

                if actual_actual["response"] == expected["response"]:
                    print(f"Command {index} succeeded")
                    try:
                        command = command_str.split(";")[index].split()
                        if command[1] == "e":
                            for slave in self.slaves:
                                if not slave.get("wireless"):
                                    continue
                                if slave["id"] == expected["id"]:
                                    slave["name"] = command[2]
                                    slave["freq"] = int(command[3])
                                    slave["res"] = int(command[4])
                                    break
                    except Exception as e:
                        print(f"Error occurred while updating device name: {e}")
                        
                    real_responses[index] = {"message": actual_actual["response"], "status": True}
                    notok = False
                    for index2 in expected_responses.keys():
                        expected2 = expected_responses[index2]
                        if expected2["id"] == expected["id"] and real_responses.get(index2) is not None and real_responses[index2]["status"] is not True:
                            notok = True
                            break

                    if not notok:
                        for slave in self.slaves:
                            if not slave.get("wireless"):
                                continue
                            if slave["id"] == expected["id"]:
                                slave["status"] = "ok"
                                slave["error"] = ""
                                slave["lastused"] = int(time.time())
                                break
                        else:
                            print(f"Error: Could not update status for device {expected['id']}. It is missing from the slaves list.")

                else:
                    error = f"Command {index} failed: Expected {expected['response']}, got {actual_actual['response']}"
                    do_error_stuff(error)
                    real_responses[index] = {"message": error, "status": False}
                    continue
            
            # cleanup
            self.responses = {}
            self.response_events = {}

            return real_responses
    
        except Exception as e:
            exc_type, exc_value, exc_traceback = sys.exc_info()
            tb_str = ''.join(traceback.format_exception(exc_type, exc_value, exc_traceback))
            print(f"Error occurred:\n{tb_str}")
            self.logger.error(f"Command execution failed:\n{tb_str}")
            return None

# To test the code:
if __name__ == "__main__":
    slaves = []  # Initialize empty slaves list
    esp_manager = ESP32Manager(slaves, True)
    
    # Keep the program running
    try:
        while True:
            inp = input("Enter commands (e.g., 'esp32_1 s 15 128; esp32_2 e new_name 5000 12'): ")
            if inp.lower() == "exit":
                break
            print("RES:", esp_manager.run_command(inp))
    except KeyboardInterrupt:
        print("\nShutting down...")
        esp_manager.client.loop_stop()
        esp_manager.client.disconnect()
