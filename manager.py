import serial, time, threading, multiprocessing
from usb_listener import setup_usb_listener
from get_connected_arduinos import get_arduinos

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

try:
    while True:
        for serial_device in serial_devices:
            ser = serial_device["serial"]
            print("pinging")
            try:
                ser.write(bytes("ping\n", encoding="utf-8"))
                incoming = ser.readline().decode(encoding="utf-8").strip() 
            except serial.serialutil.SerialException:
                continue
            print("Received: ", incoming)
        time.sleep(update_frequency)

except Exception as e:
    print("error:", e)