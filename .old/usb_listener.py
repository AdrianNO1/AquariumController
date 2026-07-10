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