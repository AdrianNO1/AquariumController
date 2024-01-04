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









    import serial.tools.list_ports

def get_arduinos():
    arduinos = []
    # List all the serial ports
    ports = list(serial.tools.list_ports.comports())
    for port in ports:
        # Check if 'Arduino' is in the description of the device
        if "Arduino" in port.description or "ttyACM" in port.device:
            arduinos.append(port.device)
    return arduinos

if __name__ == "__main__":
    # Get a list of all connected Arduinos
    arduino_ports = get_arduinos()

    # Print the list of connected Arduino devices
    print("Connected Arduino devices:")
    for port in arduino_ports:
        print(port)





import pyudev
import threading, time

# Global list to keep track of connected devices
connected_devices = []

# Function to run when a new USB tty device is connected
def on_device_connected(device):
    global connected_devices
    connected_devices.append(device.device_node)
    print(f"USB device connected: {device.device_node}")

# Function to run when a USB tty device is disconnected
def on_device_disconnected(device):
    global connected_devices
    if device.device_node in connected_devices:
        connected_devices.remove(device.device_node)
    print(f"USB device disconnected: {device.device_node}")

def monitor_devices(on_connect, on_disconnect):
    # Set up a context and monitor for tty devices
    context = pyudev.Context()
    monitor = pyudev.Monitor.from_netlink(context)
    monitor.filter_by(subsystem='tty')

    # Start monitoring
    monitor.start()

    # This loop will check for device events
    for device in iter(monitor.poll, None):
        # Check if a ttyUSB or ttyACM device is connected
        if device.subsystem == 'tty' and (device.device_node.startswith('/dev/ttyUSB') or device.device_node.startswith('/dev/ttyACM')):
            if device.action == 'add':
                on_connect(device)
            elif device.action == 'remove':
                on_disconnect(device)

def setup_usb_listener(on_connect, on_disconnect):
    # Run the monitor_devices function in a separate thread
    thread = threading.Thread(target=monitor_devices, args=(on_connect, on_disconnect))
    thread.daemon = True  # Daemonize thread
    thread.start()

if __name__ == "__main__":
    setup_usb_listener(on_device_connected, on_device_disconnected)
    # The main thread can continue doing other things here
    # ...
    # Wait for the monitoring thread to finish (it won't, since it's an infinite loop)
    print("here")
    while True:
        print(connected_devices)
        time.sleep(1)