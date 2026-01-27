def main(task_queue, response_queue, test=False):
    try:
        import time, threading, multiprocessing, os, json, logging, math, queue, re, sys, os, zipfile
        
        sys.path.append(os.path.dirname(os.path.realpath(__file__)))

        from datetime import datetime
        from logging.handlers import TimedRotatingFileHandler
        from utils import read_json_file, write_json_file, get_current_strength
        from DSL import ApexParser, InterpreterContext, evaluate, DeviceState, DeviceStateMemory, FallbackInstruction, build_interpreter_context

        slaves = []
        logger = logging.getLogger(__name__)

        from ESP32Manager import ESP32Manager
        esp_controller = ESP32Manager(slaves, test, logger)

        preview_start = 0
        last_updated = 0
        device_outputs = {}
        channels_path = os.path.join("data", "channels.json")

        class CompressingTimedRotatingFileHandler(TimedRotatingFileHandler):
            def doRollover(self):
                super().doRollover()

                log_files = self.getFilesToDelete()
                if log_files:
                    oldest_log = log_files[-1]

                    zip_filename = f"{oldest_log}.zip"
                    with zipfile.ZipFile(zip_filename, 'w', zipfile.ZIP_DEFLATED) as zipf:
                        zipf.write(oldest_log, os.path.basename(oldest_log))

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
                if task == "get_esps":
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
                elif isinstance(task, tuple) and task[0] == "run_command":
                    # Run a single command for "Run Once" functionality
                    command = task[1]
                    try:
                        result = esp_controller.run_command(command)
                        if result:
                            response_queue.put("ok")
                        else:
                            response_queue.put("Error: No response from ESP")
                    except Exception as e:
                        logger.error(f"Error running command: {e}")
                        response_queue.put(f"Error: {e}")
                    return

                if "error" in response.lower():
                    logger.warn(f"Responding with: {response}")
                else:
                    logger.info(f"Responding with: {response}")
                
                if manual_mode:
                    return str(response)
                else:
                    response_queue.put(str(response))

                task = None

        def update_device_outputs(temporaryoverwrite=False, overwrite_schedule=False):
            nonlocal last_updated
            if temporaryoverwrite:
                last_updated = time.time() + 120 # also change in lightpumps.js and ESP32Code.ino. ctrl + f "120000"
            else:
                last_updated = time.time()
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
                                        wireless_cmd_builder += f"{device['id']} s {info['pin']} {strength} {1 if temporaryoverwrite or overwrite_schedule else 0};"
                                        wireless_cmd_devices.append(device)
                                    else:
                                        logger.warning(f"Device {device['name']} is not wireless and cannot be controlled by manager")
                            
                            time.sleep(0.05)
            if wireless_cmd_builder:
                print("built wireless cmd:", wireless_cmd_builder)
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

        def read_device_sensors():
            # Read sensors and switches
            try:
                homepagedata_path = os.path.join("data", "homepagedata.json")
                espstatuses_path = os.path.join("data", "espstatuses.json")
                
                homepagedata = read_json_file(homepagedata_path)
                
                commands = []
                # Map index to (type, key, extra_info)
                # For switches: ("switch", switch_name, None)
                # For sensors: ("sensor", sensor_key/name, sensor_type)
                map_index_to_item = {} 
                
                command_str = ""
                cmd_idx = 0

                # Process switches
                if "switches" in homepagedata:
                    for name, data in homepagedata["switches"].items():
                        if data.get("device") and data.get("pin") is not None:
                            cmd = f"{data['device']} r {data['pin']} switch"
                            command_str += cmd + ";"
                            map_index_to_item[cmd_idx] = ("switch", name, None)
                            cmd_idx += 1

                # Process sensors
                if "sensors" in homepagedata:
                    for name, data in homepagedata["sensors"].items():
                        if data.get("device") and data.get("pin") is not None:
                            read_type = data.get("readType", "raw")
                            cmd = f"{data['device']} r {data['pin']} {read_type}"
                            command_str += cmd + ";"
                            map_index_to_item[cmd_idx] = ("sensor", name, read_type)
                            cmd_idx += 1
                
                if command_str:
                    responses = esp_controller.run_command(command_str.strip(";"))
                    
                    if responses:
                        espstatuses = read_json_file(espstatuses_path)
                        current_time_iso = datetime.now().isoformat()
                        
                        # Ensure structures depend on existing file or init if needed
                        if "switches" not in espstatuses:
                            espstatuses["switches"] = {}
                        # Handle sensors list -> dict for easy update, then back to list if needed
                        # But wait, sensors is a list in espstatuses.
                        # Let's map it by name
                        sensor_map = {}
                        if "sensors" in espstatuses and isinstance(espstatuses["sensors"], list):
                            for s in espstatuses["sensors"]:
                                if "name" in s:
                                    sensor_map[s["name"]] = s
                        
                        for idx_str, result in responses.items():
                            idx = int(idx_str)
                            if idx in map_index_to_item and result["status"]:
                                item_type, item_name, extra_info = map_index_to_item[idx]
                                
                                # Parse response: "r {pin} {val}"
                                msg = result["message"]
                                parts = msg.split()
                                if len(parts) >= 3:
                                    val_str = parts[2]
                                    
                                    if item_type == "switch":
                                        # val should be 0 or 1
                                        try:
                                            is_open = (int(val_str) == 1) # Assuming 1 is true
                                            espstatuses["switches"][item_name] = {
                                                "is_open": is_open,
                                                "updated_at": current_time_iso
                                            }
                                        except ValueError:
                                            logger.warn(f"Invalid switch value for {item_name}: {val_str}")
                                            
                                    elif item_type == "sensor":
                                        # val could be float
                                        try:
                                            val = float(val_str)
                                            # Update or create sensor entry
                                            if item_name in sensor_map:
                                                sensor_map[item_name]["value"] = val
                                                sensor_map[item_name]["updated_at"] = current_time_iso
                                                sensor_map[item_name]["type"] = extra_info
                                            else:
                                                sensor_map[item_name] = {
                                                    "name": item_name,
                                                    "type": extra_info,
                                                    "value": val,
                                                    "updated_at": current_time_iso
                                                }
                                        except ValueError:
                                            logger.warn(f"Invalid sensor value for {item_name}: {val_str}")
                                            
                        # Convert sensor map back to list
                        espstatuses["sensors"] = list(sensor_map.values())
                        
                        write_json_file(espstatuses_path, espstatuses)
                        
            except Exception as e:
                logger.error(f"Error reading sensors/switches: {e}")

        # Device state memory for DSL Defer/MinTime logic
        device_memory_path = os.path.join("data", "device_memory.json")
        device_state_memories = {}  # Key: "groupTitle/switchName" -> DeviceStateMemory
        
        # Load persisted device memory
        def load_device_memory():
            nonlocal device_state_memories
            try:
                if os.path.exists(device_memory_path):
                    saved = read_json_file(device_memory_path)
                    for key, mem_data in saved.items():
                        mem = DeviceStateMemory()
                        mem.current_state = DeviceState.ON if mem_data.get("current_state") == "ON" else DeviceState.OFF
                        mem.last_transition_time = mem_data.get("last_transition_time", 0)
                        mem.pending_state = DeviceState.ON if mem_data.get("pending_state") == "ON" else (DeviceState.OFF if mem_data.get("pending_state") == "OFF" else None)
                        mem.pending_start_time = mem_data.get("pending_start_time", 0)
                        device_state_memories[key] = mem
                    logger.info(f"Loaded device memory with {len(device_state_memories)} entries")
            except Exception as e:
                logger.warning(f"Could not load device memory: {e}")
        
        def save_device_memory():
            try:
                to_save = {}
                for key, mem in device_state_memories.items():
                    to_save[key] = {
                        "current_state": mem.current_state.name,
                        "last_transition_time": mem.last_transition_time,
                        "pending_state": mem.pending_state.name if mem.pending_state else None,
                        "pending_start_time": mem.pending_start_time
                    }
                write_json_file(device_memory_path, to_save)
            except Exception as e:
                logger.error(f"Failed to save device memory: {e}")

        load_device_memory()

        def execute_codegroup_logic():
            """
            Execute DSL code for all codegroup switches.
            - "auto" mode: runs DSL code to determine state
            - "on"/"off" mode: forces that state
            Sends commands to ESPs and tracks state in espstatuses.json
            """
            try:
                homepagedata_path = os.path.join("data", "homepagedata.json")
                espstatuses_path = os.path.join("data", "espstatuses.json")
                
                homepagedata = read_json_file(homepagedata_path)
                espstatuses = read_json_file(espstatuses_path)
                
                if "codegroups" not in espstatuses:
                    espstatuses["codegroups"] = {}
                
                if "codegroups" not in homepagedata:
                    return
                
                # Build interpreter context from current sensor/switch data
                try:
                    context = build_interpreter_context(os.path.join("data"))
                except Exception as e:
                    logger.error(f"Failed to build interpreter context: {e}")
                    return
                
                parser = ApexParser()
                commands_to_send = []  # List of (device_name, pin, state, fallback_state)
                current_time_iso = datetime.now().isoformat()
                
                # Collect all DSL errors for frontend display
                all_errors = []
                
                for group_name, group_data in homepagedata["codegroups"].items():
                    if "rows" not in group_data:
                        continue
                    
                    if group_name not in espstatuses["codegroups"]:
                        espstatuses["codegroups"][group_name] = {}
                    
                    for row_name, row_data in group_data["rows"].items():
                        pin = row_data.get("pin")
                        code = row_data.get("code", "")
                        mode = row_data.get("mode", "auto")
                        
                        if not pin:
                            continue  # No pin configured
                        
                        memory_key = f"{group_name}/{row_name}"
                        
                        # Get or create DeviceStateMemory for this switch
                        if memory_key not in device_state_memories:
                            device_state_memories[memory_key] = DeviceStateMemory()
                        memory = device_state_memories[memory_key]
                        
                        target_state = None
                        fallback_state = None
                        
                        if mode == "on":
                            target_state = DeviceState.ON
                        elif mode == "off":
                            target_state = DeviceState.OFF
                        elif mode == "auto":
                            if not code.strip():
                                # No code, skip
                                continue
                            
                            try:
                                instructions = parser.parse_block(code)
                                
                                # Extract fallback state if present
                                for inst in instructions:
                                    if isinstance(inst, FallbackInstruction):
                                        fallback_state = inst.state
                                        break
                                
                                # Collect errors from evaluation
                                row_errors = []
                                target_state = evaluate(instructions, context, memory, errors=row_errors)
                                
                                # Add context to errors and collect them
                                for err in row_errors:
                                    all_errors.append(f"[{group_name}/{row_name}] {err}")
                            except Exception as e:
                                logger.error(f"Error evaluating code for {group_name}/{row_name}: {e}")
                                all_errors.append(f"[{group_name}/{row_name}] Parse error: {e}")
                                # Use fallback if available
                                if fallback_state:
                                    target_state = fallback_state
                                else:
                                    continue
                        else:
                            continue  # Unknown mode
                        
                        # Record the output value in espstatuses
                        # For on/off, store as string. Future: could be numeric for dosing duration, etc.
                        output_value = "on" if (target_state == DeviceState.ON) else "off"
                        prev_status = espstatuses["codegroups"][group_name].get(row_name, {})
                        prev_output = prev_status.get("output_value")
                        
                        # Only update/send if state changed or first time
                        state_changed = (prev_output is None) or (output_value != prev_output)
                        
                        # Only update the timestamp if the state actually changed
                        if state_changed:
                            espstatuses["codegroups"][group_name][row_name] = {
                                "output_value": output_value,
                                "updated_at": current_time_iso
                            }
                        else:
                            # Keep existing entry (preserves original updated_at)
                            espstatuses["codegroups"][group_name][row_name] = {
                                "output_value": output_value,
                                "updated_at": prev_status.get("updated_at", current_time_iso)
                            }
                        
                        # Queue command to send to ESP
                        # Use group_name as device name (matches ESP naming convention)
                        # PWM value: 255 = full on, 0 = off (8-bit resolution per ESP32Code.ino)
                        pwm_value = 255 if output_value == "on" else 0
                        commands_to_send.append({
                            "device": group_name,
                            "pin": pin,
                            "state": pwm_value,
                            "fallback": (255 if fallback_state == DeviceState.ON else 0) if fallback_state else None,
                            "changed": state_changed
                        })
                
                # Store errors in espstatuses for frontend display
                # Only keep unique errors and limit to recent ones
                espstatuses["dsl_errors"] = list(set(all_errors))[:20]  # Max 20 unique errors
                espstatuses["dsl_errors_updated_at"] = current_time_iso
                
                # Send commands to ESPs
                if commands_to_send:
                    command_str = ""
                    for cmd in commands_to_send:
                        # Format: "DeviceName s pin value fallback"
                        if cmd["fallback"] is not None:
                            command_str += f"{cmd['device']} s {cmd['pin']} {cmd['state']} {cmd['fallback']};"
                        else:
                            command_str += f"{cmd['device']} s {cmd['pin']} {cmd['state']};"
                    
                    if command_str:
                        logger.debug(f"Sending codegroup commands: {command_str}")
                        try:
                            responses = esp_controller.run_command(command_str.strip(";"))
                            if responses:
                                for idx_str, result in responses.items():
                                    if not result.get("status"):
                                        logger.warning(f"Codegroup command failed: {result.get('message')}")
                        except Exception as e:
                            logger.error(f"Error sending codegroup commands: {e}")
                
                # Save updated espstatuses
                write_json_file(espstatuses_path, espstatuses)
                
                # Save device memory for Defer/MinTime persistence
                save_device_memory()
                
            except Exception as e:
                print(f"Error: {e}")
                logger.error(f"Error in execute_codegroup_logic: {e}")

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
        last_codegroup_updated = 0  # Separate tracking for codegroup updates (independent of temporary overwrite)
        
        time.sleep(3.5)
        while True:
            start = time.time()

            # Check if it's time for daily sync (5am UTC)
            current_time = time.time()
            current_hour_utc = datetime.utcfromtimestamp(current_time).hour
            
            if current_hour_utc == 5 and (current_time - last_sync) > 3600:
                logger.info("Performing daily time sync at 5am UTC")
                thread = threading.Thread(target=esp_controller.sync_time)
                thread.start()
                thread.join()
                last_sync = current_time

            human_readable_last_updated = datetime.fromtimestamp(last_updated).strftime("%H:%M:%S")
            if (last_updated + update_frequency) < time.time():
                last_updated = time.time()
                update_device_outputs(overwrite_schedule=True)

            # Execute codegroup logic on same frequency but separate from temporary overwrite timing
            if (last_codegroup_updated + default_update_frequency) < time.time():
                last_codegroup_updated = time.time()
                read_device_sensors()
                execute_codegroup_logic()

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

