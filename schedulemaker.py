import json
import time
from utils import read_json_file

# TODO: remember sync time. overwriting.

def retry_read_json(file_path, max_retries=3, initial_delay=1):
    for attempt in range(max_retries):
        try:
            with open(file_path, 'r', encoding="utf-8") as file:
                return json.load(file)
        except (FileNotFoundError, json.JSONDecodeError, PermissionError) as e:
            if attempt == max_retries - 1:  # Last attempt
                raise
            delay = initial_delay * (2 ** attempt)
            time.sleep(delay)

def create_esp32_schedule(device_name):
    # Read the channel configuration with retries
    try:
        channels_data = read_json_file('data/channels.json')
            
        # Create pin mapping for the specified device
        local_device_name = None
        for key in channels_data:
            if device_name.startswith(key):
                local_device_name = key
                break
        if local_device_name is None:
            raise ValueError(f"Device '{device_name}' not found in channels.json")
            
        pin_mapping = {
            channel_info["channel"]: channel_info["pin"] 
            for channel_info in channels_data[local_device_name]
        }
    except FileNotFoundError:
        raise FileNotFoundError("channels.json not found in data directory")
    except json.JSONDecodeError:
        raise ValueError("channels.json contains invalid JSON data")

    # Read the links configuration with retries
    try:
        links_data = read_json_file('data/links.json')
    except FileNotFoundError:
        raise FileNotFoundError("links.json not found in data directory")
    except json.JSONDecodeError:
        raise ValueError("links.json contains invalid JSON data")

    # Create the schedule structure - only include channels as a list, no syncTime
    schedule = {
        "c": []  # Changed from dictionary to list
    }

    # Process each channel
    for channel_name, channel_data in links_data.items():
        if channel_name in pin_mapping:
            # Determine channel type based on name - store as ASCII value (112 for 'p', 108 for 'l')
            channel_type = 112 if channel_name.lower().startswith("pump") else 108  # ASCII values for 'p' and 'l'
            
            channel_schedule = {
                "o": pin_mapping[channel_name],  # Pin number
                "t": channel_type,               # Channel type as integer (112 for pump, 108 for light)
                "l": []                          # Links array
            }

            # Process each link
            for link in channel_data["links"]:
                simplified_link = {
                    "s": {  # Source
                        "t": link["source"]["time"],
                        "p": link["source"]["percentage"]
                    },
                    "d": {  # Destination (target)
                        "t": link["target"]["time"],
                        "p": link["target"]["percentage"]
                    }
                }
                channel_schedule["l"].append(simplified_link)

            # Add channel to the list (without using channel name as key)
            schedule["c"].append(channel_schedule)

    # Convert to JSON string
    schedule_json = json.dumps(schedule, separators=(',', ':'))
    
    return schedule_json

# Usage
if __name__ == "__main__":
    try:
        # Example usage with device name
        device_name = "mainTest"  # or any other device name from channels.json
        command = create_esp32_schedule(device_name)
        print("ESP32 Command:")
        print(command)
    except Exception as e:
        print(f"Error: {e}")