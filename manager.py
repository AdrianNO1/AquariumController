def main(task_queue, response_queue, test=False):
    try:
        import serial, time, threading, multiprocessing, os, json, logging, math, queue, re
        from datetime import datetime
        from custom_syntax import parse_code

        if not test:
            from usb_listener import setup_usb_listener
            from get_connected_arduinos import get_arduinos

        # Create a custom logger
        logger = logging.getLogger(__name__)

        if not logger.handlers:
            # Set level of logger
            logger.setLevel(logging.INFO)

            # Create handlers
            current_log_path = os.path.join("logs\\manager", datetime.now().strftime("%d-%m-%Y %H-%M-%S") + ".log")
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

        def on_connect(device):
            logger.info(f"USB device connected: {device.device_node}")
            start_initialization_timer(device.device_node)
            
        def on_disconnect(device):
            for serial_device in serial_devices:
                if serial_device["device"] == device.device_node:
                    serial_devices.remove(serial_device)
                    logger.info(f"USB device disconnected: {device.device_node}")
                    break
        
        def run_command(device, cmd, *args):
            logger.info(f"Executing function {cmd} with args {args} on {device['name']}")
            if cmd == "isOn" or cmd == "isOff":
                command = "p"
                logger.info(f"Sending: {command}")
                try:
                    device["serial"].write(bytes(command, encoding="utf-8"))
                    recieved = device["serial"].readline().decode(encoding="utf-8").strip().strip(";")
                except serial.serialutil.SerialException:
                    logger.warn(f"usb device {device['name']} may have disconnected while running command {cmd}")
                    return cmd == "isOff"
                print("Received: " + recieved)
                if recieved != "o":
                    logger.warn(f"usb device {device['name']} did not respond with 'o', responded with '{recieved}' instead")
                    return cmd == "isOff"
                return cmd == "isOn"
            
            elif cmd == "analogWrite":
                if len(args) != 2:
                    logger.error(f"Length of args is {len(args)} not 2.")
                command = f"s {args[0]} {args[1]}"
                logger.info(f"Sending: {command}")
                try:
                    device["serial"].write(bytes(command, encoding="utf-8"))
                    recieved = device["serial"].readline().decode(encoding="utf-8").strip().strip(";") + "\n"
                except serial.serialutil.SerialException:
                    logger.warn(f"usb device {device['name']} may have disconnected while running command {cmd}")
                    return cmd == "isOff"
                print("Received: " + recieved)
                if recieved != command:
                    logger.error(f'{device["name"]} did not echo. got "{recieved}". Expected "{command}"')
                    return False
                return True
        
        def read_queue(timeout=1, task=None):
            manual_mode = False
            if not task:
                try:
                    task = task_queue.get(timeout=timeout)
                except queue.Empty:
                    pass
            else:
                manual_mode = True
            if task:
                response = "Error: unable to pass any tests. This must be some edgecase."
                logger.info(f"Recieved message from queue: {task}.")
                if len(task.split(".")) == 0:
                    response = "Error: unable to split task at '.'"
                elif len(task.split(".")) == 1:
                    response = str(task.split(".")[0] in [x["name"] for x in serial_devices])
                elif len(task.split(".")) == 2:
                    matches = [device for device in serial_devices if device["name"] == task.split(".")[0]]
                    if matches:
                        #if len(matches) > 1:
                        #    response = f"Error: found {len(matches)} arduino devices with the same name."
                        for device in matches:
                            pattern = r'\((.*?)\)'
                            func = re.sub(pattern, '', task.split(".")[1])
                            mtches = re.findall(pattern, task.split(".")[1])
                            if len(mtches) > 1:
                                response = f"Error: got {len(mtches)} matches when only 1 or 0 are expected."
                                break
                            parameters = [x.strip() for x in mtches[0].split(",")]
                            response = str(run_command(device, func, parameters))
                    else:
                        response = f"Error: '{task.split('.')[0]}' not found."
                else:
                    response = "Error: list length over 2 when splitting on '.'"
                if "error" in response.lower():
                    logger.warn(f"Responding with: {response}")
                else:
                    logger.info(f"Responding with: {response}")
                
                if manual_mode:
                    return str(response)
                else:
                    response_queue.put(str(response))

                task = None

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

        serial_devices = []

        if test:
            class fakeserial:
                def __init__(self):
                    self.written = ""

                def write(self, bytes):
                    self.written = bytes.decode("utf-8")

                def readline(self):
                    if self.written.split():
                        if self.written.split()[0] == "s":
                            return bytes(self.written, encoding="utf-8")
                        elif self.written[0] == "p":
                            return bytes("o", encoding="utf-8")
                    print(self.written)
                    return bytes(self.written, encoding="utf-8")

            serial_devices.append({"device": "idk", "serial": fakeserial(), "name": "Arduino1"})
        else:
            for device in get_arduinos():
                logger.info(f"found already connected USB device: {device}")
                start_initialization_timer(device)


        #usb_listener_process = multiprocessing.Process(target=setup_usb_listener, args=(on_connect, on_disconnect))

        if not test:
            setup_usb_listener(on_connect, on_disconnect)

        light_pins = {
            "ch1": [{"color": "White", "pin": 9}, {"color": "Blue", "pin": 10}]
        }


        update_frequency = 5

        task = None
        while True:
            start = time.time()

            if 0:
                with open(os.path.join("data", "code.json"), "r", encoding="utf-8") as f:
                    code = json.load(f)["code"]

                response = parse_code(code, verify=False, run_cmd_func=read_queue)
                if response.startswith("Error"):
                    logger.error(response)
                    print(response)
                else:
                    print(response)
                
                print("\n"*2)


            #for serial_device in serial_devices:
            #    ser = serial_device["serial"]
            #    name = serial_device["name"]
            #    if name in light_pins:
            #        command = ""
            #        for v in light_pins[name]:
            #            command += f";s {v['pin']} {round(get_current_strength(v['color']))}"
            #        command = command.strip(";") + "\n"
            #
            #        print("Sending:  " + command)
            #        logger.info("Sending:  " + command)
            #        try:
            #            ser.write(bytes(command, encoding="utf-8"))
            #            recieved = ser.readline().decode(encoding="utf-8").strip().strip(";") + "\n"
            #        except serial.serialutil.SerialException:
            #            logger.warn(f"usb device {device['name']} may have disconnected")
            #        print("Received: " + recieved)
            #        logger.info("Received: " + recieved)
            #        if recieved != command:
            #            logger.error(f'{device["name"]} did not echo. got "{recieved}". Expected "{command}"')
            #    else:
            #        print(f"{name} not found in light_pins dict")
            #        logger.error(f"{name} not found in light_pins dict")

            seconds = update_frequency-(time.time()-start)
            if seconds < 0:
                logger.warn(f"spent {-seconds} overtime on serial communication")
                read_queue(timeout=0.2)
            else:
                while update_frequency-(time.time()-start) > 0:
                    read_queue(timeout=0.2)


    except Exception as e:
        import sys, traceback
        exc_type, exc_obj, exc_tb = sys.exc_info()[:]
        fname = os.path.split(exc_tb.tb_frame.f_code.co_filename)[1]
        basic_err_info = f"\nException: {e}\nError: {exc_type}\nFile: {fname}\nLine: {exc_tb.tb_lineno}\Trace: {traceback.format_exc()}"
        print("FATAL ERROR:", basic_err_info)
        logger.fatal(basic_err_info)
        response_queue.put("\nFATAL INTERNAL ERROR. Arduino manager has crashed. Please contact the coder guy. The following information has been saved to the logs:\n" + basic_err_info)

if __name__ == "__main__":
    main(test=True)

