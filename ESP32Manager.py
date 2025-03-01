import paho.mqtt.client as mqtt
import json
import time
import threading
from typing import Dict, List
import traceback
import sys
from schedulemaker import create_esp32_schedule
from utils import read_json_file
import math

class ESP32Manager:
    def __init__(self, slaves, test, logger=None):
        print("Initializing ESP32Manager...")
        self.client = mqtt.Client(client_id="", clean_session=True, userdata=None, protocol=mqtt.MQTTv311, transport="tcp")
        self.client.max_packet_size = 262144  # Set to 256KB
        self.client.on_connect = self.on_connect
        self.client.on_message = self.on_message
        print("Connecting to local MQTT broker...")
        self.client.connect("192.168.1.73", 1883, 60)  # Connect to local MQTT broker
        
        self.slaves = slaves  # Reference to the global slaves list
        if logger is None:
            # create dummy logger object with empty functions
            logger = type("Logger", (), {"info": lambda self, msg: None, "error": lambda self, msg: None})()
        self.logger = logger
        self.responses: Dict[str, List] = {}  # Store command responses
        self.response_events: Dict[str, threading.Event] = {}
        self.command_lock = threading.Lock()  # Add lock for command execution
        self.TEST = test
        # Chunking configuration
        self.MAX_CHUNK_SIZE = 200
        if test:
            print("IS TESTING MODE---------------------------------")
        self.client.loop_start()
        print("MQTT client loop started")

    def calculate_hash(self, schedule_str):
        """Calculate a hash from a schedule string, matching the ESP32's hash function."""
        hash_val = 5381
        for c in schedule_str:
            hash_val = ((hash_val << 5) + hash_val) + ord(c)  # hash * 33 + c
            hash_val = hash_val & 0xFFFFFFFF  # Keep it as a 32-bit unsigned integer
        return str(hash_val)

    def update_schedules(self):
        print("updating schedules")
        channels = read_json_file('data/channels.json')
        command_builder = ""
        for channel in channels:
            schedule = create_esp32_schedule(channel)
            schedule_hash = self.calculate_hash(schedule)
            print(f"Channel: {channel}, Schedule hash: {schedule_hash}")
            for slave in self.slaves:
                if slave.get("wireless") and slave["name"].startswith(channel):
                    # Compare schedule hashes instead of full schedules
                    current_hash = slave.get("scheduleHash", "0")
                    if slave["version"] in ["0", "1", "2w"]:
                        print(f"Skipping schedule update for {slave['name']} (ID: {slave['id']})")
                    if current_hash == schedule_hash:
                        print(f"Schedule for {slave['name']} (ID: {slave['id']}) is already up to date")
                    if current_hash != schedule_hash and slave["version"] not in ["0", "1", "2w"]:
                        print(f"Updating schedule for {slave['name']} (ID: {slave['id']})")
                        print(f"Current hash: {current_hash}, New hash: {schedule_hash}")
                        
                        # Parse the schedule to add syncTime before sending
                        schedule_obj = json.loads(schedule)
                        schedule_obj["syncTime"] = int(time.time())
                        final_schedule = json.dumps(schedule_obj, separators=(',', ':'))
                        
                        result = self.run_command(f"{slave['id']} sc {final_schedule}")
                        if result:
                            print(f"Schedule update result: {result}")
                            # Update the schedule hash after successful update
                            slave["scheduleHash"] = schedule_hash
                        else:
                            print(f"Failed to update schedule for {slave['name']}")
        
        # Run any other non-schedule commands together
        if command_builder:
            self.run_command(command_builder)
        
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
                
                # Get schedule hash if available
                schedule_hash = payload.get("scheduleHash", "0")
                
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
                    existing_device["scheduleHash"] = schedule_hash
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
                        "scheduleHash": schedule_hash,
                        "status": "ok",
                        "error": "",
                        "lastused": int(time.time()),
                        "wireless": True,
                        "version": version
                    })

                print("Current slaves list:", json.dumps([x for x in self.slaves if x.get("wireless")], indent=2))
                threading.Thread(target=self.sync_device, args=(device_id,)).start()
                
                # Run in a thread because then things magically work.
                threading.Thread(target=self.update_schedules).start()
            
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

    def sync_device(self, device_id): # TODO sync all devices at 5am
        current_time = int(time.time())
        return self.run_command(f"{device_id} sync {current_time}")

    def sync_time(self):
        """Sync time across all ESP32 devices"""
        print("Syncing time across all devices...")
        current_time = int(time.time())
        command_builder = ""
        
        for slave in self.slaves:
            if slave.get("wireless"):
                command_builder += f"{slave['id']} sync {current_time};"
                
        if command_builder:
            return self.run_command(command_builder)
        return None

    def run_command(self, command_str: str, timeout: float = 5):
        print("run_command", command_str[:10])
        with self.command_lock:
            print("actually running run_command", command_str[:10])
            try:
                command_str = command_str.strip(";")
                print(len(command_str))
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
                            elif command == "sc":
                                res = "schedule_ok"  # Updated to match the new response from ESP32
                            elif command == "sync":
                                res = args
                            else:
                                print(f"Invalid command: {cmd}")
                                return
                            expected_responses[i] = {
                                "id": slave["id"],
                                "response": res
                            }
                            self.response_events[slave["id"]] = threading.Event()

                        i += 1

                # Determine if we need to use chunking
                message_size = len(command_str.encode('utf-8'))
                use_chunking = message_size > 256  # Use chunking for messages larger than 256 bytes
                
                if use_chunking:
                    print(f"Message size ({message_size} bytes) exceeds limit, using chunking")
                    # Use a longer timeout when chunking
                    timeout = 5
                    
                    # Send the chunked message
                    if self.TEST:
                        self.send_chunked_message(command_str, "test/aquarium/command")
                    else:
                        self.send_chunked_message(command_str, "aquarium/command")
                else:
                    # Publish the combined command string directly
                    print(f"Publishing commands to topic: aquarium/command")
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
                            elif command[1] == "sc":
                                for slave in self.slaves:
                                    if not slave.get("wireless"):
                                        continue
                                    if slave["id"] == expected["id"]:
                                        # Parse the schedule JSON from the command
                                        schedule_json = ' '.join(command[2:])
                                        try:
                                            # Parse the full schedule with syncTime
                                            full_schedule = json.loads(schedule_json)
                                            # Remove syncTime to calculate hash consistently
                                            if "syncTime" in full_schedule:
                                                del full_schedule["syncTime"]
                                            # Calculate hash from the schedule without syncTime
                                            channels_only = json.dumps(full_schedule, separators=(',', ':'))
                                            slave["scheduleHash"] = self.calculate_hash(channels_only)
                                        except json.JSONDecodeError:
                                            print(f"Error: Failed to parse schedule JSON for hash calculation")
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

                print("manager run_command returning", real_responses)
                return real_responses
        
            except Exception as e:
                exc_type, exc_value, exc_traceback = sys.exc_info()
                tb_str = ''.join(traceback.format_exception(exc_type, exc_value, exc_traceback))
                print(f"Error occurred:\n{tb_str}")
                self.logger.error(f"Command execution failed:\n{tb_str}")
                return None

    def send_chunked_message(self, message, topic):
        """Split a message into chunks and send them to the specified topic."""
        print(f"Sending chunked message of size {len(message)} bytes")
        
        # Calculate number of chunks needed
        total_chunks = math.ceil(len(message) / self.MAX_CHUNK_SIZE)
        print(f"Splitting into {total_chunks} chunks")
        
        # Send each chunk
        for i in range(total_chunks):
            start_pos = i * self.MAX_CHUNK_SIZE
            end_pos = min(start_pos + self.MAX_CHUNK_SIZE, len(message))
            chunk_data = message[start_pos:end_pos]
            
            # Format: chunk:index:total:isLast:data
            is_last = 1 if i == total_chunks - 1 else 0
            chunk_message = f"chunk:{i}:{total_chunks}:{is_last}:{chunk_data}"
            
            print(f"Sending chunk {i+1}/{total_chunks}, size: {len(chunk_data)} bytes")
            self.client.publish(topic, chunk_message)
            
            # Small delay between chunks to avoid overwhelming the ESP32
            time.sleep(0.05)
        
        print("All chunks sent")

# To test the code:
if __name__ == "__main__":
    slaves = []  # Initialize empty slaves list
    esp_manager = ESP32Manager(slaves, True)
    
    x = 1
    # Keep the program running
    try:
        while True:
            # inp = input("Enter commands (e.g., 'esp32_1 s 15 128; esp32_2 e new_name 5000 12'): ")
            inp = input("Enter")
            e = "4FCB45ED p;"*x
            def thread_func():
                print("RES:", esp_manager.update_schedules())
            thread = threading.Thread(target=thread_func)
            thread.start()
            thread.join()
            x += 1
    except KeyboardInterrupt:
        print("\nShutting down...")
        esp_manager.client.loop_stop()
        esp_manager.client.disconnect()
