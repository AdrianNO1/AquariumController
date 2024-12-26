import paho.mqtt.client as mqtt
import json
import time
import threading
from typing import Dict, List

class ESP32Manager:
    def __init__(self, slaves, logger):
        print("Initializing ESP32Manager...")
        self.client = mqtt.Client()
        self.client.on_connect = self.on_connect
        self.client.on_message = self.on_message
        print("Connecting to local MQTT broker...")
        self.client.connect("localhost", 1883, 60)
        
        self.slaves = slaves  # Reference to the global slaves list
        self.logger = logger
        self.responses: Dict[str, List] = {}  # Store command responses
        self.response_events: Dict[str, threading.Event] = {}
        
        self.client.loop_start()
        print("MQTT client loop started")
        
    def discover_devices(self):
        """Request all ESP32s to announce themselves"""
        print("Broadcasting device discovery message...")
        self.client.publish("aquarium/discover", "announce")

    def on_connect(self, client, userdata, flags, rc):
        print(f"Connected to MQTT broker with result code: {rc}")
        client.subscribe("aquarium/announce")
        client.subscribe("aquarium/response/#")
        client.subscribe("aquarium/discover")
        print("Subscribed to required topics")
        self.discover_devices()

    def on_message(self, client, userdata, msg):
        print(f"\nReceived message on topic: {msg.topic}")
        decoded = msg.payload.decode()
        print(f"Message payload: {decoded}")
        if decoded == "announce":
            print("Ignoring self-discovery message")
            return
        
        try:
            payload = json.loads(msg.payload.decode())
            
            if msg.topic == "aquarium/announce":
                device_id = payload["id"]
                device_name = payload["name"]
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
                        "wireless": True
                    })
                print("Current slaves list:", json.dumps([x for x in self.slaves if x.get("wireless")], indent=2))
            
            elif msg.topic.startswith("aquarium/response/"):
                device_name = msg.topic.split("/")[-1]
                command_id = f"{device_name}_{payload['command']}"
                print(f"Command response received from {device_name}")
                print(f"Command ID: {command_id}")
                
                if command_id in self.responses:
                    self.responses[command_id].append(payload)
                    if command_id in self.response_events:
                        print(f"Setting event for command: {command_id}")
                        self.response_events[command_id].set()
        
        except json.JSONDecodeError:
            print(f"Error: Invalid JSON received: {msg.payload}")

    def get_devices_by_name(self, name: str) -> List[str]:
        """Get all device IDs with the specified name from slaves list"""
        devices = [device["id"] for device in self.slaves 
                  if device.get("wireless") and device["name"] == name]
        print(f"Found devices for name '{name}': {devices}")
        return devices

    def run_command(self, device_name: str, command: str, args: str, timeout: float = 3) -> bool:
        try:
            print(f"\nRunning command '{command}' for device '{device_name}' with args: {args}")
            
            # Get expected device IDs
            expected_ids = self.get_devices_by_name(device_name)
            if not expected_ids:
                print(f"Error: No devices found with name: {device_name}")
                return False

            # Create unique command ID
            command_id = f"{device_name}_{command}"
            print(f"Command ID: {command_id}")
            
            # Initialize response storage and event
            self.responses[command_id] = []
            self.response_events[command_id] = threading.Event()
            
            # Publish command
            message = {
                "command": command,
                "args": args
            }
            print(f"Publishing command to topic: aquarium/command/{device_name}")
            print(f"Message: {json.dumps(message)}")
            self.client.publish(f"aquarium/command/{device_name}", json.dumps(message))
            
            # Wait for responses
            print(f"Waiting for responses (timeout: {timeout}s)...")
            success = self.response_events[command_id].wait(timeout)
            
            # Update all expected devices
            current_time = int(time.time())
            for device in self.slaves:
                if device.get("wireless") and device["name"] == device_name:
                    device["lastused"] = current_time
            
            if not success:
                print(f"Error: Timeout waiting for response from {device_name}")
                for device in self.slaves:
                    if device.get("wireless") and device["name"] == device_name:
                        device["status"] = "missing"
                return False
            
            # Process responses
            responses = self.responses[command_id]
            responding_ids = [r["id"] for r in responses]
            print(f"Received responses from devices: {responding_ids}")
            
            # Check for unexpected responses
            unexpected_ids = set(responding_ids) - set(expected_ids)
            if unexpected_ids:
                print(f"Warning: Received responses from unexpected devices: {unexpected_ids}")
                
            # Check for missing responses
            missing_ids = set(expected_ids) - set(responding_ids)
            if missing_ids:
                print(f"Warning: Missing responses from devices: {missing_ids}")
            
            # Update device statuses
            for device in self.slaves:
                if device.get("wireless") and device["name"] == device_name:
                    if device["id"] in responding_ids:
                        if command != "s" and device["id"] == args.split()[0]:
                            if command == "e":
                                echo_list = [x for x in responses if x["id"] == device["id"]][0]["echo"].split(" ")
                                if len(echo_list) != 3:
                                    err = "Invalid echo response from device: " + responses[responding_ids.index(device["id"])]["echo"]
                                    device["error"] = err
                                    print("Error:", err)
                                device["name"] = echo_list[0]
                                device["freq"] = int(echo_list[1])
                                device["res"] = int(echo_list[2])
                        device["status"] = "ok"
                        if responses[responding_ids.index(device["id"])].get("error"):
                            device["error"] = "Error from device: " + responses[responding_ids.index(device["id"])]["error"]
                        else:
                            device["error"] = ""
                        if device["id"] in unexpected_ids:
                            device["error"] = "Unexpected response from device"
                    elif device["id"] in missing_ids:
                        device["status"] = "missing"
            
            # Clean up
            del self.responses[command_id]
            del self.response_events[command_id]
            
            # Command is successful only if all expected devices responded correctly
            success = len(missing_ids) == 0 and len(unexpected_ids) == 0 and \
                    all(r.get("status") == "success" for r in responses)
            print(f"Command execution {'successful' if success else 'failed'}")
            return success
        except Exception as e:
            print(f"Error: {e}")
            return False

# To test the code:
if __name__ == "__main__":
    slaves = []  # Initialize empty slaves list
    esp_manager = ESP32Manager(slaves)
    
    # Keep the program running
    try:
        while True:
            inp = input("Enter command (device_name command [device_id] [args]): ")
            if inp == "exit":
                break
            
            parts = inp.split()
            if len(parts) < 2:
                print("Invalid input format")
                continue
                
            device_name = parts[0]
            command = parts[1]
            
            if command in ['p', 'e', 'w']:
                # These commands require device ID
                if len(parts) < 3:
                    print(f"Error: {command} command requires device ID")
                    continue
                device_id = parts[2]
                args = device_id + (" " + " ".join(parts[3:]) if len(parts) > 3 else "")
            else:
                # For 's' command and others
                args = " ".join(parts[2:])
            
            esp_manager.run_command(device_name, command, args)
    except KeyboardInterrupt:
        print("\nShutting down...")
        esp_manager.client.loop_stop()
        esp_manager.client.disconnect()
