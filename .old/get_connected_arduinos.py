import serial.tools.list_ports

def get_arduinos():
    arduinos = []
    # List all the serial ports
    ports = list(serial.tools.list_ports.comports())
    for port in ports:
        # Check if 'Arduino' is in the description of the device
        if "Arduino" in port.description or "ttyACM" in port.device or "ttyUSB" in port.device:
            arduinos.append(port.device)
    return arduinos

if __name__ == "__main__":
    # Get a list of all connected Arduinos
    arduino_ports = get_arduinos()

    # Print the list of connected Arduino devices
    print("Connected Arduino devices:")
    for port in arduino_ports:
        print(port)
