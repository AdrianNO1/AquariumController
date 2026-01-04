import paho.mqtt.client as mqtt
import json
import time
import random
import sys

BROKER = "192.168.1.73"
PORT = 1883
TEST = True

class MockESP32:
    def __init__(self, client, device_id, device_name, custom_sensor_handler=None, freq=5000, res=8, version="3.1mock"):
        self.client = client
        self.device_id = device_id
        self.device_name = device_name
        self.freq = freq
        self.res = res
        self.version = version
        self.pin_states = {}
        self.schedule = ""
        self.custom_sensor_handler = custom_sensor_handler

    def calculate_hash(self, schedule_str):
        hash_val = 5381
        for c in schedule_str:
            hash_val = ((hash_val << 5) + hash_val) + ord(c)
            hash_val = hash_val & 0xFFFFFFFF
        return str(hash_val)

    def announce(self):
        doc = {
            "name": self.device_name,
            "freq": self.freq,
            "res": self.res,
            "id": self.device_id,
            "status": "online",
            "version": self.version,
            "scheduleHash": self.calculate_hash(self.schedule) if self.schedule else "0"
        }
        print(f"[{self.device_id}] Announcing: {doc}")
        prefix = "test/" if TEST else ""
        self.client.publish(f"{prefix}aquarium/announce", json.dumps(doc))

    def get_sensor_data(self, pin, metadata=None):
        if self.custom_sensor_handler:
            return self.custom_sensor_handler(self, pin, metadata)
        
        # Default behavior: Simulate reading sensors
        val = random.randint(0, 4095) # Simulate 12-bit ADC
        return f"r {pin} {val}"

    def handle_command(self, cmd_str):
        parts = cmd_str.strip().split(" ")
        if len(parts) < 2: 
            return ""
        
        target = parts[0]
        # Double check target matching (redundant if called from process_message but safe)
        if target != self.device_name and target != self.device_id:
            return ""
        
        command = parts[1]
        args = parts[2:] if len(parts) > 2 else []
        
        print(f"[{self.device_id}] Processing command: {command} with args: {args}")

        if command == "s": # Set pin
            if len(args) >= 2:
                try:
                    pin = int(args[0])
                    val = int(args[1])
                    self.pin_states[pin] = val
                    output = f"s {pin} {val}"
                    if len(args) >= 3:
                        output += f" {args[2]}"
                    return output
                except ValueError:
                    return "E: Invalid int args"
            return "E: Invalid args"
        
        elif command == "p": # Ping
            return "o"
        
        elif command == "e": # Edit settings
            # args: new_name freq res
            if len(args) >= 3:
                self.device_name = args[0]
                self.freq = int(args[1])
                self.res = int(args[2])
                self.announce()
                return f"{self.device_name} {self.freq} {self.res}"
            return "E: Invalid args"

        elif command == "sync":
            return args[0] if args else "E: No time"

        elif command == "sc": # Schedule
            if len(args) > 0:
                self.schedule = " ".join(args)
            return "schedule_ok"

        elif command == "r": # Read sensors
            if len(args) >= 1:
                try:
                    pin = int(args[0])
                    # handle types
                    type_arg = args[1] if len(args) > 1 else ""
                    
                    if type_arg == "":
                        return self.get_sensor_data(pin)
                    
                    if type_arg == "switch":
                        random.seed(pin)
                        val = random.randint(0, 1)
                        random.seed()

                        return f"r {pin} {val}"
                    elif type_arg in ["temp", "ph", "redox"]:
                        if type_arg == "temp":
                            val = round(random.uniform(20.0, 30.0), 1)
                        elif type_arg == "ph":
                            val = round(random.uniform(7.5, 8.5), 2)
                        elif type_arg == "redox":
                            val = random.randint(200, 450)
                        else:
                            raise ValueError("Invalid type")
                        return f"r {pin} {val}"
                        
                    return f"E: Invalid type {type_arg}"
                except ValueError:
                    return "E: Invalid pin"
            return "E: Invalid args"
        
        elif command == "clear":
            return "EEPROM cleared"

        return "E: Unknown command"

    def process_message(self, payload):
        if payload == "discover":
            self.announce()
            return

        if payload.startswith("chunk:"):
            # print("Chunk received (ignored in mock)")
            return

        responses_doc = {
            "id": self.device_id,
            "name": self.device_name,
            "responses": []
        }
        
        commands = payload.split(";")
        cmd_index = 0
        did_process = False

        for cmd in commands:
            if not cmd.strip():
                continue
                
            parts = cmd.strip().split(" ", 1)
            if len(parts) < 1:
                cmd_index += 1
                continue
                
            target = parts[0]
            if target == self.device_name or target == self.device_id:
                response = self.handle_command(cmd.strip())
                if response:
                    responses_doc["responses"].append({
                        "index": cmd_index,
                        "response": response
                    })
                    did_process = True
            
            cmd_index += 1

        if did_process:
            print(f"[{self.device_id}] Sending response: {responses_doc}")
            prefix = "test/" if TEST else ""
            self.client.publish(f"{prefix}aquarium/response", json.dumps(responses_doc))

devices = []

def on_connect(client, userdata, flags, rc):
    print(f"Connected with result code {rc}")
    prefix = "test/" if TEST else ""
    client.subscribe(f"{prefix}aquarium/command")
    
    print(f"Announcing {len(devices)} devices...")
    for device in devices:
        device.announce()

def on_message(client, userdata, msg):
    try:
        payload = msg.payload.decode()
        print(f"Received: {payload}")
        
        for device in devices:
            device.process_message(payload)
    except Exception as e:
        print(f"Error handling message: {e}")

client = mqtt.Client()
client.on_connect = on_connect
client.on_message = on_message

if __name__ == "__main__":
    print(f"Mock ESP32 Manager starting...")
    print(f"Connecting to {BROKER}:{PORT}")


    def custom_sensor_read(device, pin, metadata=None):
        return f"r {pin} 67"

    esp1 = MockESP32(client, "MOCK001", "MockESP32_1", custom_sensor_read)
    esp2 = MockESP32(client, "MOCK002", "MockESP32_2")

    devices.append(esp1)
    devices.append(esp2)

    try:
        client.connect(BROKER, PORT, 60)
        client.loop_forever()
    except Exception as e:
        print(f"Connection failed: {e}")
