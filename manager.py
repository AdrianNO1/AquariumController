def main(task_queue, response_queue, test=False):
    try:
        import serial, time, threading, multiprocessing, os, json, logging, math, queue, re, sys, os, zipfile#, dropbox
        
        sys.path.append(os.path.dirname(os.path.realpath(__file__)))

        from datetime import datetime
        from custom_syntax import parse_code, get_current_strength
        from logging.handlers import TimedRotatingFileHandler
        from utils import read_json_file

        slaves = []
        logger = logging.getLogger(__name__)

        if not test:
            pass
            # from usb_listener import setup_usb_listener
            # from get_connected_arduinos import get_arduinos
        
        from ESP32Manager import ESP32Manager
        esp_controller = ESP32Manager(slaves, test, logger)

        preview_start = 0
        last_updated = 0
        device_outputs = {}
        channels_path = os.path.join("data", "channels.json")

        #refresh_token = os.getenv("DROPBOX_API_KEY")

        # def refresh_access_token(refresh_token):
        #     dbx = dropbox.DropboxOAuth2FlowNoRedirect(os.getenv("DROPBOX_APP_KEY"), os.getenv("DROPBOX_APP_SECRET"))
        #     oauth_result = dbx.refresh_access_token(refresh_token)
        #     return oauth_result.access_token

        # def upload_file_to_dropbox(local_path):
        #     access_token = refresh_access_token(refresh_token)
        #     dbx = dropbox.Dropbox(access_token)
        #     dropbox_path = "/AquariumControllerLogs/" + os.path.basename(local_path)
        #     with open(local_path, 'rb') as f:
        #         dbx.files_upload(f.read(), dropbox_path, mode=dropbox.files.WriteMode.overwrite)


        class CompressingTimedRotatingFileHandler(TimedRotatingFileHandler):
            def doRollover(self):
                super().doRollover()

                log_files = self.getFilesToDelete()
                if log_files:
                    oldest_log = log_files[-1]

                    zip_filename = f"{oldest_log}.zip"
                    with zipfile.ZipFile(zip_filename, 'w', zipfile.ZIP_DEFLATED) as zipf:
                        zipf.write(oldest_log, os.path.basename(oldest_log))
                    #upload_file_to_dropbox(zip_filename)
                    os.remove(oldest_log)
                    return zip_filename

        if not logger.handlers:
            # Set level of logger
            logger.setLevel(logging.INFO)

            # Create handlers
            current_log_path = os.path.join(os.path.join("logs", "manager"), datetime.now().strftime("%d-%m-%Y %H-%M-%S") + ".log")
            open(current_log_path, "w")
            #handler = logging.FileHandler(current_log_path, encoding="utf-8")  # Log to a file
            handler = CompressingTimedRotatingFileHandler(
                current_log_path,              # Base file name
                when='H',              # Rotate the logs every Hour
                interval=2,            # Interval is 2 (combined with 'when' this means every hour)
                #backupCount=24,        # Keep 24 backup files (24 hours)
                encoding='utf-8',      # Use utf-8 encoding for the log files
                delay=False,           # Do not delay the creation of the file
                utc=False              # Use local time for the timestamp in the file name
            )
            handler.setLevel(logging.INFO)
            handler.namer = lambda name: name.replace(".log", "") + ".log"

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
                time.sleep(0.05)
                name = serial_device["serial"].readline().decode('utf-8').strip().strip(";")
                if not name:
                    logger.error("serial_device did not recieve a name. Possible timeout")
                    name = "Not responding"
                    serial_device["status"] = "No response"
                    serial_device["error"] = "Error: Device is not responding"
                else:
                    serial_device["status"] = "Responded"
                    serial_device["error"] = ""
                
                serial_device["lastused"] = int(time.time())
                serial_device["name"] = name
            except serial.serialutil.SerialException:
                logger.warn("Device disconnected when initializing")
                return
            slaves.append(serial_device)
            logger.info(f"USB device initialized: {serial_device['name']}")

        def start_initialization_timer(device):
            ser = serial.Serial(device, 9600, timeout=1)#, dsrdtr=True)
           # ser.setDTR(False)
            threading.Timer(2, initialize, args=({"device": device, "serial": ser, "name": None},)).start()

        def on_connect(device):
            logger.info(f"USB device connected: {device.device_node}")
            start_initialization_timer(device.device_node)
            
        def on_disconnect(device):
            for serial_device in slaves:
                if serial_device["device"] == device.device_node:
                    slaves.remove(serial_device)
                    logger.info(f"USB device disconnected: {device.device_node}")
                    return
            logger.info(f"unknown USB device disconnected: {device.device_node}")
        
        def run_command(device, cmd, args=None): # legacy
            if device.get("wireless"):
                return False
            logger.info(f"Executing function {cmd} with args {args} on {device['name']} ({device['device']})")
            if cmd == "isOn" or cmd == "isOff":
                command = "p\n"
                logger.info(f"Sending: {command}")
                try:
                    device["serial"].write(bytes(command, encoding="utf-8"))
                    recieved = device["serial"].readline().decode(encoding="utf-8").strip().strip(";")
                except serial.serialutil.SerialException:
                    logger.warn(f"usb device {device['name']} may have disconnected while running command {cmd}")
                    return cmd == "isOff"
                
                #print("Received: " + recieved)
                device["lastused"] = int(time.time())

                if recieved != "o":
                    wrn = f"usb device {device['name']} did not respond with 'o', responded with '{recieved}' instead"
                    logger.warn(wrn)
                    device["error"] = "Error: " + wrn
                    device["status"] = "Unexpected response"
                    if not recieved:
                        logger.warn(f"usb device {device['name']} did not respond")
                        device["error"] = "Error: Device is not responding"
                        device["status"] = "No response"
                    return cmd == "isOff"

                device["status"] = "Responded"
                device["error"] = ""
                return cmd == "isOn"
            
            elif cmd == "analogWrite":
                if len(args) != 2:
                    logger.error(f"Length of args is {len(args)} not 2.")
                command = f"s {args[0]} {args[1]}\n"
                logger.info(f"Sending: {command}")
                try:
                    device["serial"].write(bytes(command, encoding="utf-8"))
                    time.sleep(0.05)
                    # recieved = device["serial"].readline().decode(encoding="utf-8").strip().strip(";") + "\n"
                except serial.serialutil.SerialException:
                    logger.warn(f"usb device {device['name']} may have disconnected while running command {cmd}")
                    return False
                
                
                
                device["lastused"] = int(time.time())

                #if recieved != command:
                #    wrn = f'{device["name"]} did not echo. got "{recieved}". Expected "{command}"'
                #    logger.warning(wrn)
                #    if device["error"]:
                #        raise RuntimeError(f"magic stuff happened to arduino {device['name']} ({device['device']})")
                #        print("magic")
                #       return
                #    device["error"] = "Error: " + wrn
                #    logger.warning(f"usb device {device['name']} did not respond.")
                #    device["error"] = "Error: Device is not responding"
                #    device["status"] = "No response"
                #    return False
                #else:
                device["status"] = "idk"
                device["error"] = ""
                return True
            
            elif cmd == "rename":
                if len(args) != 1:
                    logger.error(f"Length of args is {len(args)} not 1.")
                command = f"e {args[0]}\n"
                logger.info(f"Sending: {command}")
                try:
                    old_name = device["name"]
                    device["serial"].write(bytes(command, encoding="utf-8"))
                    recieved = device["serial"].readline().decode(encoding="utf-8").strip().strip(";")
                except serial.serialutil.SerialException:
                    logger.warn(f"usb device {device['name']} may have disconnected while running command {cmd}")
                    return False
                
                #print("Received: " + recieved)
                device["lastused"] = int(time.time())

                if recieved != args[0]:
                    wrn = f'{device["name"]} did not respond as expected. got "{recieved}". Expected "{args[0]}"'
                    logger.warn(wrn)
                    device["error"] = "Error: " + wrn
                    device["status"] = "Unexpected response"
                    if not recieved:
                        logger.warn(f"usb device {device['name']} did not respond")
                        device["error"] = "Error: Device is not responding"
                        device["status"] = "No response"
                    return False
                

                device["name"] = recieved
                device["status"] = "Responded"
                device["error"] = ""
                return True
        
        def preview():
            nonlocal preview_start, update_frequency
            update_frequency = 0.5
            preview_start = time.time()
            response_queue.put("ok")
            
        def cancelpreview():
            nonlocal preview_start, update_frequency
            preview_start = 0
            update_frequency = default_update_frequency
            response_queue.put("ok")

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
                logger.info(f"Recieved message from queue: {task}.")
                response = "Error: no error info given"
                if task == "get_arduinos":
                    response_queue.put([{x: device[x] for x in device if x not in "serial"} for device in slaves])
                    return
                elif task == "preview":
                    preview()
                    return
                elif task == "cancelpreview":
                    cancelpreview()
                    return
                elif task == "update":
                    thread = threading.Thread(target=esp_controller.update_schedules)
                    thread.start()
                    thread.join()
                    response_queue.put("ok")
                    return
                elif task == "temporaryoverwrite":
                    update_device_outputs(temporaryoverwrite=True)
                    response_queue.put("ok")
                    return
                elif task == "update-channels":
                    response_queue.put("ok")
                    load_device_outputs()
                    thread = threading.Thread(target=esp_controller.update_schedules)
                    thread.start()
                    thread.join()
                    return
                
                elif type(task) == tuple and len(task) == 3 and task[0] == "rename":
                    matches = [device for device in slaves if device["device"] == task[1]]
                    if matches:
                        for device in matches:
                            run_command(device, "rename", [task[2]])

                elif type(task) == tuple and len(task) == 2 and task[0] == "editesp":
                    data = task[1]
                    print("GOT:", data)
                    matches = [device for device in slaves if device.get("id") == data["id"]]
                    if matches:
                        if matches[0].get("wireless"):
                            device = matches[0]
                            thread = threading.Thread(target=lambda: esp_controller.run_command(f"{data['id']} e {data['name']} {data['freq']} {data['res']}"))
                            thread.start()
                            thread.join()
                            
                            thread = threading.Thread(target=esp_controller.update_schedules)
                            thread.start()
                            thread.join()
                        else:
                            res = run_command(matches[0], "editesp", [data["id"], data["name"], data["freq"], data["res"]])
                            if res:
                                response = "ok"
                            else:
                                logger.error(f"Error: not good. editesp something went wrong")
                                response = "Error: something went wrong"

                if "error" in response.lower():
                    logger.warn(f"Responding with: {response}")
                else:
                    logger.info(f"Responding with: {response}")
                
                if manual_mode:
                    return str(response)
                else:
                    response_queue.put(str(response))

                task = None

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
                    #print(self.written)
                    return bytes(self.written, encoding="utf-8")

            # slaves.append({"device": "idk", "serial": fakeserial(), "name": "mainLysTest", "status": "Responded", "lastused": int(time.time()), "error": ""})
            # slaves.append({"device": "idk", "serial": fakeserial(), "name": "mainPump", "status": "Responded", "lastused": int(time.time()), "error": ""})
        # else:
        #     for device in get_arduinos():
        #         logger.info(f"found already connected USB device: {device}")
        #         start_initialization_timer(device)
        #     usb_listener_process = multiprocessing.Process(target=setup_usb_listener, args=(on_connect, on_disconnect))



        def update_device_outputs(temporaryoverwrite=False):
            nonlocal last_updated
            if temporaryoverwrite:
                last_updated = time.time() + 120 # also change in lightpumps.js and ESP32Code.ino. ctrl + f "120000"
            else:
                last_updated = time.time()
                return
            nonlocal preview_start

            wireless_cmd_builder = ""
            wireless_cmd_devices = []
            for name in device_outputs:
                matches = list(filter(lambda x: x["name"].startswith(name), slaves))
                
                if matches:
                    for device in matches:
                        for info in device_outputs[name]:
                            if preview_start != 0:
                                if time.time() - preview_start >= preview_duration:
                                    preview_start = 0
                                    update_frequency = default_update_frequency
                                    minutes_of_day = None
                                else:
                                    minutes_of_day = max(int((time.time() - preview_start)*60*(24/preview_duration)), 0)
                            else:
                                minutes_of_day = None
                            if name == "mainLys70":
                                mult = 0.7
                            else:
                                mult = 1
                            if "channel" in info:
                                strength = get_current_strength(info["channel"], mult=mult, minutes_of_day=minutes_of_day, temporaryoverwrite=temporaryoverwrite)
                                if type(strength) == str and "Error" in strength:
                                    logger.error(strength)
                                else:
                                    if device.get("wireless"):
                                        wireless_cmd_builder += f"{device['id']} s {info['pin']} {strength} {1 if temporaryoverwrite else 0};"
                                        wireless_cmd_devices.append(device)
                                    else:
                                        run_command(device, "analogWrite", [info["pin"], strength])
                            
                            time.sleep(0.05)
            if wireless_cmd_builder:
                thread = threading.Thread(target=lambda: esp_controller.run_command(wireless_cmd_builder.strip(";")))
                thread.start()
                responses = thread.join()
                if responses:
                    for key in responses:
                        r = responses[key]

                        if not r["status"]:
                            wireless_cmd_devices[key]["status"] = "Error"
                            wireless_cmd_devices[key]["error"] = r["message"]
                else:
                    logger.error("Error: esp_controller returned: " + str(responses))

        # if not test:
        #     setup_usb_listener(on_connect, on_disconnect)


        def load_device_outputs(retries=4):
            nonlocal device_outputs
            try:
                device_outputs = read_json_file(channels_path)
            except Exception as e:
                if retries > 0:
                    logger.warning(f"Failed to load device outputs, retrying... ({retries} attempts left)")
                    time.sleep(0.5)
                    return load_device_outputs(retries - 1)
                else:
                    logger.error(f"Failed to load device outputs after all retries: {e}")
                    raise e
                
        load_device_outputs()
                
        # also change in script.js
        preview_duration = 60 # seconds

        default_update_frequency = 5
        update_frequency = default_update_frequency
        
        last_sync = 0
        
        time.sleep(3.5)
        while True:
            start = time.time()

            # Check if it's time for daily sync (5am UTC)
            current_time = time.time()
            current_hour_utc = datetime.utcfromtimestamp(current_time).hour
            
            if current_hour_utc == 5 and (current_time - last_sync) > 3600:  # Only sync once per hour
                logger.info("Performing daily time sync at 5am UTC")
                thread = threading.Thread(target=esp_controller.sync_time)
                thread.start()
                thread.join()
                last_sync = current_time

            human_readable_last_updated = datetime.fromtimestamp(last_updated).strftime("%H:%M:%S")
            if (last_updated + update_frequency) < time.time():
                last_updated = time.time()
                update_device_outputs()




            seconds = last_updated + update_frequency - time.time()
            if seconds < 0:
                logger.warn(f"spent {-seconds} overtime on serial communication")
                read_queue(timeout=0.2)
                #handler.flush()
            else:
                while update_frequency-(time.time()-start) > 0:
                    read_queue(timeout=0.2)
                #handler.flush()


    except Exception as e:
        import sys, traceback, os
        exc_type, exc_obj, exc_tb = sys.exc_info()[:]
        fname = os.path.split(exc_tb.tb_frame.f_code.co_filename)[1]
        basic_err_info = f"\nException: {e}\nError: {exc_type}\nFile: {fname}\nLine: {exc_tb.tb_lineno}\Trace: {traceback.format_exc()}"
        print("FATAL ERROR:", basic_err_info)
        logger.fatal(basic_err_info)
        response_queue.put("\nFATAL INTERNAL ERROR. Arduino manager has crashed. Please contact the coder guy. The following information has been saved to the logs:\n" + basic_err_info)
        #for ser in serial_devices:
        #    ser.close()
if __name__ == "__main__":
    main(test=True)

