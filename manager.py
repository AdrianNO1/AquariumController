import serial, time, threading, multiprocessing, os, json, logging, math
from usb_listener import setup_usb_listener
from get_connected_arduinos import get_arduinos
from datetime import datetime

# Create a custom logger
logger = logging.getLogger(__name__)

if not logger.handlers:
    # Set level of logger
    logger.setLevel(logging.INFO)

    # Create handlers
    handler = logging.FileHandler(os.path.join("logs", datetime.now().strftime("%d/%m/%Y %H:%M:%S")), encoding="utf-8")  # Log to a file
    handler.setLevel(logging.INFO)

    # Create formatters and add it to handlers
    formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    handler.setFormatter(formatter)

    # Add handlers to the logger
    logger.addHandler(handler)

    logger.info("started new session")

def initialize(serial_device):
    print("initializing")
    try:
        serial_device["serial"].write(bytes("whodis\n", encoding="utf-8"))
        serial_device["name"] = serial_device["serial"].readline().decode().strip()
    except serial.serialutil.SerialException:
        print("Device disconnected when initializing")
        return
    serial_devices.append(serial_device)
    print(f"USB device initialized: {serial_device['device']}")
    print(serial_device)

def start_initialization_timer(device):
    threading.Timer(2, initialize, args=({"device": device, "serial": serial.Serial(device, 9600), "name": None},)).start()

serial_devices = []

for device in get_arduinos():
    print(f"found already connected USB device: {device}")
    start_initialization_timer(device)

update_frequency = 2


def on_connect(device):
    print(f"USB device connected: {device.device_node}")
    start_initialization_timer(device.device_node)
    
def on_disconnect(device):
    for serial_device in serial_devices:
        if serial_device["device"] == device.device_node:
            serial_devices.remove(serial_device)
            print(f"USB device disconnected: {device.device_node}")
            break

if update_frequency <= 1:
    print("WARNING: LOW UPDATE FREQUENCY")

#usb_listener_process = multiprocessing.Process(target=setup_usb_listener, args=(on_connect, on_disconnect))

setup_usb_listener(on_connect, on_disconnect)

light_pins = {
    "1": [{"color": "White", "pin": 9}, {"color": "Blue", "pin": 10}]
}

def get_current_strength(color):
    with open(os.path.join("data", "links.json"), "r", encoding="utf-8") as f:
        links = json.load(f)
        if color in links:
            now = datetime.now()
            minutes_of_day = int((now - now.replace(hour=0, minute=0, second=0, microsecond=0)).total_seconds()/60)
            #print(minutes_of_day)
            for link in links[color]:
                if link["source"]["time"] <= minutes_of_day and link["target"]["time"] >= minutes_of_day:
                    total_duration = link["target"]["time"] - link["source"]["time"]
                    if total_duration == 0:
                        print("division by zero. Two nodes have the same time")
                    else:
                        #print(link["source"]["time"], link["target"]["time"])
                        #print(link["target"]["percentage"], link["source"]["percentage"])
                        #print((1 - (link["target"]["time"] - minutes_of_day) / total_duration))
                        percentage = link["source"]["percentage"] + (1 - (link["target"]["time"] - minutes_of_day) / total_duration) * (link["target"]["percentage"] - link["source"]["percentage"])
                        return percentage/100*256
                    
        else:
            print(f"Unable to find {color} in link")

while True:
    start = time.time()
    for serial_device in serial_devices:
        ser = serial_device["serial"]
        name = serial_device["name"]
        if name in light_pins:
            command = ""
            for v in light_pins[name]:
                command += f";s {v['pin']} {round(get_current_strength(v['color']))}"
            command = command.strip(";") + "\n"

            print("Sending:  " + command)
            #try:
            logger.info("Sending:  " + command)
            ser.write(bytes(command, encoding="utf-8"))
            recieved = ser.readline().decode(encoding="utf-8").strip() # add timeout
            #except serial.serialutil.SerialException:
            print("Received: " + recieved)
            logger.info("Received: " + recieved)

        #print("pinging")
        #try:
        #    ser.write(bytes("ping\n", encoding="utf-8"))
        #    incoming = ser.readline().decode(encoding="utf-8").strip() # add timeout
        #except serial.serialutil.SerialException:
        #    continue
        #print("Received: ", incoming)
    
    seconds = update_frequency-(time.time()-start)
    if seconds > 0:
        time.sleep(seconds)
    else:
        logger.warn(f"spent {-seconds} overtime on serial communication")