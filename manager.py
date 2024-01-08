def main(test=False):
    try:
        import serial, time, threading, multiprocessing, os, json, logging, math
        from datetime import datetime
        if not test:
            from usb_listener import setup_usb_listener
            from get_connected_arduinos import get_arduinos

        # Create a custom logger
        logger = logging.getLogger(__name__)

        if not logger.handlers:
            # Set level of logger
            logger.setLevel(logging.INFO)

            # Create handlers
            current_log_path = os.path.join("logs", datetime.now().strftime("%d-%m-%Y %H-%M-%S") + ".log")
            open(current_log_path, "w")
            handler = logging.FileHandler(current_log_path, encoding="utf-8")  # Log to a file
            handler.setLevel(logging.INFO)

            # Create formatters and add it to handlers
            formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
            handler.setFormatter(formatter)

            # Add handlers to the logger
            logger.addHandler(handler)

            logger.info("started new session")

        def initialize(serial_device):
            logger.info("initializing", serial_device)
            try:
                serial_device["serial"].write(bytes("whodis\n", encoding="utf-8"))
                name = serial_device["serial"].readline().decode().strip().strip(";")
                if not name:
                    logger.error("serial_device did not recieve a name. Possible timeout")
                serial_device["name"] = name
            except serial.serialutil.SerialException:
                logger.warn("Device disconnected when initializing")
                return
            serial_devices.append(serial_device)
            logger.info(f"USB device initialized: {serial_device['name']}")

        def start_initialization_timer(device):
            threading.Timer(2, initialize, args=({"device": device, "serial": serial.Serial(device, 9600, timeout=1), "name": None},)).start()

        serial_devices = []

        if test:
            class fakeserial:
                def __init__(self):
                    self.written = ""

                def write(self, bytes):
                    self.written = bytes

                def readline(self):
                    return self.written

            serial_devices.append({"device": "idk", "serial": fakeserial(), "name": "ch1"})
        else:
            for device in get_arduinos():
                logger.info(f"found already connected USB device: {device}")
                start_initialization_timer(device)

        def on_connect(device):
            logger.info(f"USB device connected: {device.device_node}")
            start_initialization_timer(device.device_node)
            
        def on_disconnect(device):
            for serial_device in serial_devices:
                if serial_device["device"] == device.device_node:
                    serial_devices.remove(serial_device)
                    logger.info(f"USB device disconnected: {device.device_node}")
                    break

        #usb_listener_process = multiprocessing.Process(target=setup_usb_listener, args=(on_connect, on_disconnect))

        if not test:
            setup_usb_listener(on_connect, on_disconnect)

        light_pins = {
            "ch1": [{"color": "White", "pin": 9}, {"color": "Blue", "pin": 10}]
        }

        def get_current_strength(color):
            with open(os.path.join("data", "links.json"), "r", encoding="utf-8") as f:
                links = json.load(f)
                if color in links:
                    now = datetime.now()
                    minutes_of_day = int((now - now.replace(hour=0, minute=0, second=0, microsecond=0)).total_seconds()/60)

                    for link in links[color]:
                        if link["source"]["time"] <= minutes_of_day and link["target"]["time"] >= minutes_of_day:
                            total_duration = link["target"]["time"] - link["source"]["time"]
                            if total_duration == 0:
                                logger.warn("division by zero. Two nodes have the same time")
                            else:
                                percentage = link["source"]["percentage"] + (1 - (link["target"]["time"] - minutes_of_day) / total_duration) * (link["target"]["percentage"] - link["source"]["percentage"])
                                return percentage/100*255
                            
                else:
                    logger.warn(f"Unable to find {color} in link")


        update_frequency = 5


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
                    logger.info("Sending:  " + command)
                    try:
                        ser.write(bytes(command, encoding="utf-8"))
                        recieved = ser.readline().decode(encoding="utf-8").strip().strip(";") + "\n"
                    except serial.serialutil.SerialException:
                        logger.warn("usb device may have disconnected")
                    print("Received: " + recieved)
                    logger.info("Received: " + recieved)
                    if recieved != command:
                        logger.error(f'Arduino did not echo. got "{recieved}". Expected "{command}"')
                else:
                    print(f"{name} not found in light_pins dict")
                    logger.warn(f"{name} not found in light_pins dict")
            
            seconds = update_frequency-(time.time()-start)
            if seconds > 0:
                time.sleep(seconds)
            else:
                logger.warn(f"spent {-seconds} overtime on serial communication")

    except Exception as e:
        logger.fatal(e)

if __name__ == "__main__":
    main(test=True)