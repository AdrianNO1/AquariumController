import json, os, sys, re, time, requests, dotenv
dotenv.load_dotenv()
from DSL import verify_code

if len(sys.argv) > 1 and sys.argv[1] == "restart":
    print("waiting 10")
    time.sleep(10)
    start = 0
else:
    start = time.time()

try:
    num = int(sys.argv[2])+1
except:
    num = 0

if num > 0:
    print(f"APP HAS CRASHED {num} TIMES THIS SESSION")

sys.path.append(os.path.dirname(os.path.realpath(__file__)))

from flask import Flask, request, jsonify, render_template, url_for, redirect, flash, session, send_file
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from datetime import datetime, timedelta
from manager import main
from custom_syntax import parse_code
import threading
import queue, logging, glob, subprocess, signal
from utils import read_json_file, write_json_file
from smsalert import sms_alert

# run on pi: pip install flask_login flask_limiter

app = Flask(__name__)
limiter = Limiter(
    app=app,
    key_func=lambda: "global"
)

os.makedirs("logs/app", exist_ok=True)
os.makedirs("logs/manager", exist_ok=True)

# Create handlers
current_log_path = os.path.join(os.path.join("logs", "app"), datetime.now().strftime("%d-%m-%Y %H-%M-%S") + ".log")
handler = logging.FileHandler(current_log_path, encoding="utf-8")  # Log to a file

# Create formatters and add it to handlers
formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
handler.setFormatter(formatter)

# Add handlers to the logger
app.logger.addHandler(handler)

app.logger.info("started new session")
app.logger.setLevel(logging.INFO)


links_path = os.path.join("data", "links.json")
throttle_path = os.path.join("data", "throttle.json")
channels_path = os.path.join("data", "channels.json")
temporaryoverwritesliders_path = os.path.join("data", "temporaryoverwritesliders.json")
homepagedata_path = os.path.join("data", "homepagedata.json")
espstatuses_path = os.path.join("data", "espstatuses.json")

if not os.path.exists(homepagedata_path):
    write_json_file(homepagedata_path, {"codegroups": {}, "switches": {}, "timers": {}})

if not os.path.exists(espstatuses_path):
    write_json_file(espstatuses_path, {"codegroups": {}, "switches": {}, "timers": {}})

def clear_res_queue():
    while not response_queue.empty():
        response_queue.get()

@app.errorhandler(500)
def handle_internal_server_error(e):
    app.logger.error('Internal Server Error: %s', e)
    return "Internal Server Error", 500

@app.errorhandler(404)
def handle_internal_server_error(e):
    app.logger.error('Not found: %s', e)
    return "No", 404

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/control/<device_type>')
def control(device_type):
    return render_template('lightpumps.html')

@app.route('/kill')
def kill():
    app.logger.info("kill request")
    os.kill(os.getpid(), signal.SIGINT)
    return jsonify({"message": "Killed"}) # won't send lol

@app.route('/shutdown')
def shutdown():
    app.logger.info("shutdown request")
    os.system("sudo shutdown now")
    return jsonify({"message": "Shutting down"})

@app.route('/restart')
def restart():
    app.logger.info("restart request")
    os.system("sudo reboot")
    return jsonify({"message": "Restarting"})

@app.route('/pull')
def pull():
    # run git pull in the current directory without restarting the application
    app.logger.info("pull request")
    import subprocess
    import os

    try:
        # Get the current directory where app.py is located
        current_dir = os.path.dirname(os.path.abspath(__file__))
        
        # Create a shell script that will run after we exit
        update_script = """#!/bin/bash
cd {}
git pull
""".format(current_dir)
        
        # Write the update script
        with open('/tmp/update.sh', 'w') as f:
            f.write(update_script)

        # Make the script executable
        subprocess.call(['chmod', '+x', '/tmp/update.sh'])

        # Execute the update script in the background
        subprocess.Popen(['/bin/bash', '/tmp/update.sh'])

        return jsonify({'status': 'success', 'message': 'Update initiated'})
    
    except Exception as e:
        app.logger.error(f"Error in pull: {str(e)}")
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/pullrestart')
def pullrestart():
    app.logger.info("pullrestart request")
    import subprocess
    import os
    
    try:
        # Get the current directory where app.py is located
        current_dir = os.path.dirname(os.path.abspath(__file__))
        
        # Create a shell script that will run after we exit
        update_script = """#!/bin/bash
cd {}
git pull
sleep 2
python3 app.py &
""".format(current_dir)

        # Write the update script
        with open('/tmp/update_and_restart.sh', 'w') as f:
            f.write(update_script)
        
        # Make the script executable
        subprocess.call(['chmod', '+x', '/tmp/update_and_restart.sh'])
        
        # Execute the update script in the background
        subprocess.Popen(['/bin/bash', '/tmp/update_and_restart.sh'])
        
        # Return success message before shutting down
        response = {'status': 'success', 'message': 'Update and restart initiated'}
        
        # Shutdown the Flask application
        func = request.environ.get('werkzeug.server.shutdown')
        if func is None:
            raise RuntimeError('Not running with the Werkzeug Server')
        func()
        
        return jsonify(response)
        
    except Exception as e:
        app.logger.error(f"Error in pullrestart: {str(e)}")
        return jsonify({'status': 'error', 'message': str(e)}), 500
    

@app.route('/test')
def test_func():
    app.logger.info("test request")
    return jsonify({"message": "Test Func"})

@app.route('/load', methods=['POST'])
def load():
    app.logger.info("load request")
    data = request.json
    mode = data["type"]
    expected_channels = data["expected_channels"]
    nodes = read_json_file(links_path)
    did_something = False
    for expected_channel in expected_channels:
        if expected_channel not in nodes:
            nodes[expected_channel] = {}
            nodes[expected_channel]["type"] = mode
            nodes[expected_channel]["links"] = [
            {
                "source": {
                    "time": 0,
                    "percentage": 0,
                    "x": 0,
                    "y": 250
                },
                "target": {
                    "time": 43,
                    "percentage": 0,
                    "x": 28,
                    "y": 250
                }
            },
            {
                "source": {
                    "time": 43,
                    "percentage": 0,
                    "x": 28,
                    "y": 250
                },
                "target": {
                    "time": 274,
                    "percentage": 0,
                    "x": 177,
                    "y": 250
                }
            }]

            did_something = True
    if did_something:
        write_json_file(links_path, nodes)
    avaliable_channels = []
    for key in nodes.keys():
        avaliable_channels.append(key)
        if nodes[key]["type"] != mode:
            continue
        nodes[key] = nodes[key]["links"]
        i = 0
        for link in nodes[key]:
            nodes[key][i] = link["source"]
            i += 1
        nodes[key] = nodes[key][1:]

    try:
        throttle = read_json_file(throttle_path)[mode + "throttle"]
    except KeyError:
        app.logger.info("throttle not found. using default. Mode: " + str(mode))
        throttle = 100
    outputs = read_json_file(channels_path)
    
    limit = 10
    x = 0
    error_lines = ""
    #with open(max(glob.glob(os.path.join("logs", "manager")), key=os.path.getctime), "r") as f:
    #    lines = f.readlines()
    #    for line in reversed(lines):
    #        record = logging.makeLogRecord(eval(line))
    #        if record.levelname != "INFO":
    #            error_lines += line + "\n"
    #            x += 1
    #            if x >= limit:
    #                break


    return jsonify({"data": json.dumps(nodes), "throttle": throttle, "error_lines": error_lines, "avaliable_channels": avaliable_channels, "outputs": json.dumps(outputs)})

@app.route('/loadespinfo', methods=['POST'])
def load_esp_info():
    app.logger.info("load ESP info request")
    
    clear_res_queue()
    task_queue.put("get_esps")
    try:
        response = response_queue.get(timeout=30)
    except queue.Empty:
        return jsonify({"error": "Unable to fetch esp data. The manager is not responding. It may have crashed and may not be updating the esps."})


    return jsonify({"data": json.dumps(response)}) # , "arduinoConstants": json.dumps(code["arduinoConstants"])

@app.route('/upload', methods=['POST'])
def upload():
    app.logger.info("upload request")
    data = request.json
    mode = data["type"]
    
    links = read_json_file(links_path)
    for key in data["links_data"]:
        links[key] = data["links_data"][key]
    write_json_file(links_path, links)

    throttle = read_json_file(throttle_path)
    throttle[mode + "throttle"] = data["throttle"]
    write_json_file(throttle_path, throttle)

    response = {'message': 'ok'}

    clear_res_queue()
    task_queue.put("update")
    try:
        response_queue.get(timeout=5)
    except:
        response = {'message': 'file updated. But no response from manager'}

    
    return jsonify(response)


@app.route('/update-slider-values', methods=['POST'])
def update_slider_values():
    app.logger.info("update-slider-values request")
    data = request.json

    write_json_file(temporaryoverwritesliders_path, data)
    
    response = {'message': 'ok'}

    clear_res_queue()
    task_queue.put("temporaryoverwrite")
    try:
        response_queue.get(timeout=5)
    except:
        response = {'message': 'file updated. But no response from manager'}

    
    return jsonify(response)


@app.route('/rename', methods=['POST'])
def rename():
    app.logger.info("rename request")
    data = request.json

    clear_res_queue()
    task_queue.put(("rename", data["device"], data["newname"]))
    try:
        response = {"data": response_queue.get(timeout=10)}
    except:
        response = {'error': "timeout when waiting for response from manager"}

    return jsonify(response)

@app.route('/editesp', methods=['POST'])
def editesp():
    app.logger.info("edit esp request")
    data = request.json

    clear_res_queue()
    task_queue.put(("editesp", data))
    try:
        response = {"data": response_queue.get(timeout=10)}
    except:
        response = {'error': "timeout when waiting for response from manager"}

    return jsonify(response)

@app.route('/update-channels', methods=['POST'])
def update_channels():
    app.logger.info("update-channels request")
    data = request.json
    if "outputs" not in data:
        return jsonify({'error': "no outputs in data"}), 400
    
    try:
        write_json_file(channels_path, data["outputs"])
    except Exception as e:
        return jsonify({'error': f"error when writing to file: {str(e)}"}), 400,

    clear_res_queue()
    task_queue.put("update-channels")
    try:
        response = {"data": response_queue.get(timeout=10)}
        return jsonify(response)
    except queue.Empty:
        app.logger.error("Timeout waiting for manager response")
        return jsonify({'error': "timeout when waiting for response from manager"}), 504



@app.route('/getlog')
def getlog():
    app.logger.info("getlog request")
    
    try:
        # Get latest log files from both directories
        app_logs = glob.glob(os.path.join("logs", "app", "*.log"))
        manager_logs = glob.glob(os.path.join("logs", "manager", "*.log"))
        
        latest_app_log = max(app_logs, key=os.path.getctime) if app_logs else None
        latest_manager_log = max(manager_logs, key=os.path.getctime) if manager_logs else None
        
        # Combine logs into a single file
        timestamp = datetime.now().strftime("%d-%m-%Y_%H-%M-%S")
        combined_log_path = os.path.join("logs", f"combined_logs_{timestamp}.txt")
        
        with open(combined_log_path, 'w', encoding='utf-8') as outfile:
            outfile.write("=== APPLICATION LOGS ===\n\n")
            if latest_app_log:
                with open(latest_app_log, 'r', encoding='utf-8') as infile:
                    outfile.write(infile.read())
            
            outfile.write("\n\n=== MANAGER LOGS ===\n\n")
            if latest_manager_log:
                with open(latest_manager_log, 'r', encoding='utf-8') as infile:
                    outfile.write(infile.read())
        
        # Send the combined file
        response = send_file(
            combined_log_path,
            mimetype='text/plain',
            as_attachment=True,
            download_name=f'aquarium_logs_{timestamp}.txt'
        )
        
        # Clean up the combined file after sending
        @response.call_on_close
        def cleanup():
            if os.path.exists(combined_log_path):
                os.remove(combined_log_path)
        
        return response
        
    except Exception as e:
        app.logger.error(f"Error in getlog: {str(e)}")
        return jsonify({"error": str(e)}), 500






# home page routes

@app.route("/savecoderow", methods=['POST'])
def savecoderow():
    app.logger.info("save code row request")
    data = request.json # {'action': 'verify', 'groupTitle': 'Main 2', 'switchName': 'Ventilasjon', 'pin': 4, 'code': 'coeeee'}
    
    if data["action"] == "save":
        existing_json = read_json_file(homepagedata_path)
        if not data["groupTitle"] in existing_json["codegroups"]:
            existing_json["codegroups"][data["groupTitle"]] = {"rows": {}}
            
        current_rows = existing_json["codegroups"][data["groupTitle"]]["rows"]
        current_row_data = current_rows[data["switchName"]]
        mode = current_row_data["mode"]
        
        updated_at = datetime.now().isoformat()
        existing_json["codegroups"][data["groupTitle"]]["rows"][data["switchName"]] = {
            "pin": data["pin"],
            "code": data["code"],
            "mode": mode,
            "updated_at": updated_at
        }
        write_json_file(homepagedata_path, existing_json)
        return jsonify({"message": "ok", "updated_at": updated_at})
        

    elif data["action"] == "verify":
        is_valid, code_error = verify_code(data["code"])
        return jsonify({"verify_status": is_valid, "code_error": code_error})
    
    elif data["action"] == "run":
        is_valid, code_error = verify_code(data["code"])
        if not is_valid:
            return jsonify({"verify_status": is_valid, "code_error": code_error})
        
        
        return jsonify({"message": "ok"})
    else:
        return jsonify({"error": "invalid action"})

@app.route("/saveswitch", methods=['POST'])
def saveswitch():
    app.logger.info("saveswitch request")
    data = request.json # {'originalName': 'Sump High', 'name': 'Sump High', 'device': 'Device 1', 'pin': 33, 'alarm_when_closed': False, 'alarm_delay': 30}

    existing_json = read_json_file(homepagedata_path)
    if data["originalName"] != data["name"]:
        if data["originalName"] in existing_json["switches"]:
            del existing_json["switches"][data["originalName"]]
    existing_json["switches"][data["name"]] = {
        "pin": data["pin"],
        "alarm_when_closed": data.get("alarm_when_closed", True),
        "alarm_when_open": data.get("alarm_when_open", True),
        "alarm_delay": data["alarm_delay"],
        "device": data["device"]
    }
    write_json_file(homepagedata_path, existing_json)
    return jsonify({"message": "ok"})

@app.route("/setswitchoverwrite", methods=['POST'])
def setswitchoverwrite():
    app.logger.info("setswitchoverwrite request")
    data = request.json
    print(data) # {'groupTitle': 'Main 2', 'switchName': 'Ventilasjon', 'action': 'on'}
    existing_json = read_json_file(homepagedata_path)
    if not data["groupTitle"] in existing_json["codegroups"]:
        existing_json["codegroups"][data["groupTitle"]] = {"rows": {}}
    if not data["switchName"] in existing_json["codegroups"][data["groupTitle"]]["rows"]:
        existing_json["codegroups"][data["groupTitle"]]["rows"][data["switchName"]] = {
            "pin": None,
            "code": "",
            "updated_at": datetime.now().isoformat()
        }
    existing_json["codegroups"][data["groupTitle"]]["rows"][data["switchName"]]["mode"] = data["action"]
    existing_json["codegroups"][data["groupTitle"]]["rows"][data["switchName"]]["updated_at"] = datetime.now().isoformat()

    write_json_file(homepagedata_path, existing_json)

    return jsonify({"message": "ok"})

@app.route("/savegroup", methods=['POST'])
def savegroup():
    app.logger.info("savegroup request")
    data = request.json # { 'originalTitle': '...', 'newTitle': '...', 'switches': [{ 'name': '...', 'status': '...' }, ...] }

    existing_json = read_json_file(homepagedata_path)
    
    # Handle renaming
    if data["originalTitle"] != data["newTitle"]:
        if data["originalTitle"] in existing_json["codegroups"]:
            existing_json["codegroups"][data["newTitle"]] = existing_json["codegroups"].pop(data["originalTitle"])
    
    group_title = data["newTitle"]
    if group_title not in existing_json["codegroups"]:
        existing_json["codegroups"][group_title] = {"rows": {}}
    
    current_rows = existing_json["codegroups"][group_title]["rows"]
    new_rows_data = {}

    for sw in data["switches"]:
        name = sw["name"]
        
        # Check if we have an original name to link to existing data
        original_name = sw.get("originalName")
        
        if original_name and original_name in current_rows:
            # renamed or same name
            new_rows_data[name] = current_rows[original_name]
            if original_name != name:
                new_rows_data[name]["updated_at"] = datetime.now().isoformat()
        elif name in current_rows:
             # Just in case originalName wasn't sent but name matches (unlikely if logic is correct but good fallback)
            new_rows_data[name] = current_rows[name]
        else:
            # Create new
            new_rows_data[name] = {
                "pin": None,
                "code": "",
                "updated_at": datetime.now().isoformat(),
                "mode": "auto"
            }
            
    existing_json["codegroups"][group_title]["rows"] = new_rows_data
    
    write_json_file(homepagedata_path, existing_json)
    
    response_switches = []
    for sw in data["switches"]:
        name = sw["name"]
        row_data = new_rows_data.get(name)
        if row_data:
            mode = row_data.get("mode", "auto")
            response_switches.append({
                "name": name,
                "status": mode, 
                "mode": mode,
                "code": row_data.get("code", ""),
                "pin": row_data.get("pin"),
                "updated_at": row_data.get("updated_at")
            })
    
    return jsonify({
        "newTitle": group_title,
        "newSwitches": response_switches
    })

@app.route("/timer", methods=['POST'])
def timer_action():
    app.logger.info("timer request")
    data = request.json 
    
    existing_json = read_json_file(homepagedata_path)
    if "timers" not in existing_json:
        existing_json["timers"] = {"flowKills": [], "feeds": []}
        
    target_list = None
    if data["type"] == "flowkill":
        target_list = existing_json["timers"]["flowKills"]
        search_key = "name"
    elif data["type"] == "feed":
        target_list = existing_json["timers"]["feeds"]
        search_key = "type"
    else:
        return jsonify({"error": "invalid type"}), 400
        
    # Find item
    item = next((i for i in target_list if i[search_key] == data["name"]), None)
    if not item:
         return jsonify({"error": "item not found"}), 404
         
    if data["action"] == "start":
        duration = data.get("duration", 30) 
        # Check if item allows custom duration configuration
        if "duration" in item:
            duration = item["duration"]
             
        end_time = datetime.now() + timedelta(minutes=duration)
        item["countDownEnd"] = end_time.isoformat()
        
    elif data["action"] == "stop":
        item["countDownEnd"] = None
        
    elif data["action"] == "configure":
        item["duration"] = data["duration"]
        
    else:
        return jsonify({"error": "invalid action"}), 400
        
    write_json_file(homepagedata_path, existing_json)
    return jsonify({"message": "ok"})

@app.route("/loadmainpageinfo")
def loadmainpageinfo():
    app.logger.info("load main page info request")
    existing_json = read_json_file(homepagedata_path)
    espstatuses = read_json_file(espstatuses_path)
    
    # Construct dummy codegroups status
    espstatuses["codegroups"] = {}
    if "codegroups" in existing_json:
        for group_name, group_data in existing_json["codegroups"].items():
            espstatuses["codegroups"][group_name] = {}
            if "rows" in group_data:
                for row_name in group_data["rows"]:
                    # Always return False for now as per instructions
                    espstatuses["codegroups"][group_name][row_name] = {"is_open": False}

    return jsonify({"main": existing_json, "espstatuses": espstatuses})

@app.route("/savesensor", methods=['POST'])
def savesensor():
    app.logger.info("savesensor request")
    data = request.json 
    # {'name': 'SensorName', 'device': 'DeviceName', 'pin': 123, 'metadata': '...'}

    existing_json = read_json_file(homepagedata_path)
    if "sensors" not in existing_json:
        existing_json["sensors"] = {}
    
    existing_json["sensors"][data["name"]] = {
        "device": data["device"],
        "pin": data["pin"],
        "readType": data["readType"]
    }
    
    write_json_file(homepagedata_path, existing_json)
    return jsonify({"message": "ok"})

if __name__ == '__main__':
    # Create queues for communication
    task_queue = queue.Queue()
    response_queue = queue.Queue()


    def fakemain(task_queue, a, b):
        print("fake thing running")
        time.sleep(3)
        print("raising")
        raise ValueError("AAAAAAAAAAAAAAAAAAA")

    # if len(sys.argv) > 1:
    #     if sys.argv[0] == "test":
    #         test = True
    #     elif sys.argv[0] in ["notest", "no-test"]:
    #         test = False
    #     else:
    #         raise ValueError("Invalid argument. Use 'test' or 'notest'")
        
    if os.path.exists("test.json"):
        test = read_json_file("test.json")["test"]
    else:
        test = True
        write_json_file("test.json", {"test": True})

    # Function to run in the thread
    def thread_function():
        def start_thread():
            thread = threading.Thread(target=main, args=(task_queue, response_queue, test))
            thread.start()
            return thread
        thread = start_thread()
        while True:
            if not thread.is_alive():
                app.logger.warning("It seems the manager has taken an unexpected coffee break... R.I.P.")
                print("MANAGER IS DEAD!!!!")
                if test:
                    break
                
                if num < 3:
                    sms_alert("MANAGER HAS DIED!!!! :(")

                time.sleep(10)
                
                subprocess.Popen(f"lxterminal -e python3 /home/adrian/Desktop/Coding/AquariumController/app.py restart {num}", shell=True)
                print("restarting in 60")
                time.sleep(60)
                os.kill(os.getpid(), signal.SIGINT) 
                break


            time.sleep(5)
        
        

    # Start the thread
    thread = threading.Thread(target=thread_function)
    thread.start()

    app.logger.info("starting app with SSL")
    app.run(debug=True, port=2389, host="0.0.0.0", use_reloader=False, 
            ssl_context=('cert.pem', 'key.pem'))