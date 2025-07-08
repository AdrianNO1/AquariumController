import json, os, sys, re, time
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
from flask_login import LoginManager, login_user, logout_user, login_required, UserMixin, current_user
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from datetime import datetime, timedelta
from manager import main
from custom_syntax import parse_code
import threading
import queue, logging, glob, subprocess, signal#, vonage
from werkzeug.security import check_password_hash
from utils import read_json_file

# run on pi: pip install flask_login flask_limiter


try:
    with open('secret.json', 'r') as f:
        config = json.load(f)
except FileNotFoundError:
    raise FileNotFoundError("Secret file not found. Please run generate_secret.py first.")

app = Flask(__name__)
limiter = Limiter(
    app=app,
    key_func=lambda: "global"
)
app.secret_key = config['secret_key']
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=3650)  # 10 years
app.config['SESSION_PERMANENT'] = True


users = {
    'pjot': {
        'password_hash': config['password_hash']
    }
}

class User(UserMixin):
    def __init__(self, id):
        self.id = id
        self.username = id
        self.password_hash = users[id]['password_hash']

login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = 'login'

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
    with open(homepagedata_path, "w", encoding="utf-8") as f:
        json.dump({"codegroups": {}, "switches": {}, "timers": {}}, f, indent=4)

if not os.path.exists(espstatuses_path):
    with open(espstatuses_path, "w", encoding="utf-8") as f:
        json.dump({"codegroups": {}, "switches": {}, "timers": {}}, f, indent=4)

def clear_res_queue():
    while not response_queue.empty():
        response_queue.get()

@app.errorhandler(500)
@login_required
def handle_internal_server_error(e):
    app.logger.error('Internal Server Error: %s', e)
    return "Internal Server Error", 500

@app.errorhandler(404)
@login_required
def handle_internal_server_error(e):
    app.logger.error('Not found: %s', e)
    return "No", 404

@login_manager.user_loader
def load_user(user_id):
    if user_id not in users:
        return None
    return User(user_id)

@app.route('/')
@login_required
def index():
    return render_template('index.html')

@app.route('/login', methods=['GET', 'POST'])
@limiter.limit("10 per minute")
def login():
    if request.method == 'POST':
        username = request.form['username']
        password = request.form['password']
        if username in users and check_password_hash(users[username]['password_hash'], password):
            user = User(username)
            session.permanent = True
            login_user(user)
            app.logger.info(f"User {username} logged in.")
            return redirect(url_for('index'))
        else:
            flash('Invalid username or password')
            app.logger.warning(f"Failed login attempt for user {username} from {request.remote_addr}.")
            return render_template('login.html')
    else:
        return render_template('login.html')

@app.route('/control/<device_type>')
@login_required
def control(device_type):
    return render_template('lightpumps.html')

@app.route('/kill')
@login_required
def kill():
    app.logger.info("kill request")
    os.kill(os.getpid(), signal.SIGINT)
    return jsonify({"message": "Killed"}) # won't send lol

@app.route('/shutdown')
@login_required
def shutdown():
    app.logger.info("shutdown request")
    os.system("sudo shutdown now")
    return jsonify({"message": "Shutting down"})

@app.route('/restart')
@login_required
def restart():
    app.logger.info("restart request")
    os.system("sudo reboot")
    return jsonify({"message": "Restarting"})

@app.route('/pull')
@login_required
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
@login_required
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
@login_required
def test_func():
    app.logger.info("test request")
    return jsonify({"message": "Test Func"})

@app.route('/load', methods=['POST'])
@login_required
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
        with open(links_path, "w", encoding="utf-8") as f:
            json.dump(nodes, f, indent=4)
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

@app.route('/loadarduinoinfo', methods=['POST'])
@login_required
def load_arduino_info():
    app.logger.info("loadarduinoinfo request")
    
    clear_res_queue()
    task_queue.put("get_arduinos")
    try:
        response = response_queue.get(timeout=30)
    except queue.Empty:
        return jsonify({"error": "Unable to fetch arduino data. The manager is not responding. It may have crashed and may not be updating the arduinos."})


    return jsonify({"data": json.dumps(response)}) # , "arduinoConstants": json.dumps(code["arduinoConstants"])

@app.route('/upload', methods=['POST'])
@login_required
def upload():
    app.logger.info("upload request")
    data = request.json
    mode = data["type"]
    
    links = read_json_file(links_path)
    for key in data["links_data"]:
        links[key] = data["links_data"][key]
    with open(links_path, "w", encoding="utf-8") as f:
        json.dump(links, f, indent=4)

    throttle = read_json_file(throttle_path)
    throttle[mode + "throttle"] = data["throttle"]
    with open(throttle_path, "w", encoding="utf-8") as f:
        json.dump(throttle, f, indent=4)

    response = {'message': 'ok'}

    clear_res_queue()
    task_queue.put("update")
    try:
        response_queue.get(timeout=5)
    except:
        response = {'message': 'file updated. But no response from manager'}

    
    return jsonify(response)


@app.route('/update-slider-values', methods=['POST'])
@login_required
def update_slider_values():
    app.logger.info("update-slider-values request")
    data = request.json

    with open(temporaryoverwritesliders_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=4)
    
    response = {'message': 'ok'}

    clear_res_queue()
    task_queue.put("temporaryoverwrite")
    try:
        response_queue.get(timeout=5)
    except:
        response = {'message': 'file updated. But no response from manager'}

    
    return jsonify(response)


@app.route('/rename', methods=['POST'])
@login_required
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
@login_required
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
@login_required
def update_channels():
    app.logger.info("update-channels request")
    data = request.json
    if "outputs" not in data:
        return jsonify({'error': "no outputs in data"}), 400
    
    try:
        json.dump(data["outputs"], open(channels_path, "w", encoding="utf-8"), indent=4)
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
@login_required
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
@login_required
def savecoderow():
    app.logger.info("save code row request")
    data = request.json # {'action': 'verify', 'groupTitle': 'Main 2', 'switchName': 'Ventilasjn', 'pin': 4, 'code': 'coeeee'}
    
    if data["action"] == "save":
        existing_json = json.load(open(homepagedata_path, "r", encoding="utf-8"))
        if not data["groupTitle"] in existing_json["codegroups"]:
            existing_json["codegroups"][data["groupTitle"]] = {"rows": {}}
        existing_json["codegroups"][data["groupTitle"]]["rows"][data["switchName"]] = {
            "pin": data["pin"],
            "code": data["code"],
            "updated_at": datetime.now().isoformat()
        }
        with open(homepagedata_path, "w", encoding="utf-8") as f:
            json.dump(existing_json, f, indent=4)

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
@login_required
def saveswitch():
    app.logger.info("saveswitch request")
    data = request.json # {'originalName': 'Sump High', 'name': 'Sump High', 'device': 'Device 1', 'pin': 33, 'alarm_when_closed': False, 'alarm_delay': 30}

    existing_json = json.load(open(homepagedata_path, "r", encoding="utf-8"))
    if data["originalName"] != data["name"]:
        if data["originalName"] in existing_json["switches"]:
            del existing_json["switches"][data["originalName"]]
    existing_json["switches"][data["name"]] = {
        "pin": data["pin"],
        "alarm_when_closed": data["alarm_when_closed"],
        "alarm_delay": data["alarm_delay"],
        "device": data["device"]
    }
    with open(homepagedata_path, "w", encoding="utf-8") as f:
        json.dump(existing_json, f, indent=4)
    return jsonify({"message": "ok"})

@app.route("/setswitchoverwrite", methods=['POST'])
@login_required
def setswitchoverwrite():
    app.logger.info("setswitchoverwrite request")
    data = request.json
    print(data) # {'groupTitle': 'Main 2', 'switchName': 'Ventilasjn', 'action': 'on'}
    existing_json = json.load(open(homepagedata_path, "r", encoding="utf-8"))
    if not data["groupTitle"] in existing_json["codegroups"]:
        existing_json["codegroups"][data["groupTitle"]] = {"rows": {}}
    if not data["switchName"] in existing_json["codegroups"][data["groupTitle"]]["rows"]:
        existing_json["codegroups"][data["groupTitle"]]["rows"][data["switchName"]] = {
            "pin": None,
            "code": "",
            "updated_at": datetime.now().isoformat()
        }
    existing_json["codegroups"][data["groupTitle"]]["rows"][data["switchName"]]["mode"] = data["action"]

    with open(homepagedata_path, "w", encoding="utf-8") as f:
        json.dump(existing_json, f, indent=4)

    return jsonify({"message": "ok"})

@app.route("/loadmainpageinfo")
@login_required
def loadmainpageinfo():
    app.logger.info("load main page info request")
    existing_json = json.load(open(homepagedata_path, "r", encoding="utf-8"))
    espstatuses = json.load(open(espstatuses_path, "r", encoding="utf-8"))
    return jsonify({"main": existing_json, "espstatuses": espstatuses})

if __name__ == '__main__':
    # Create queues for communication
    task_queue = queue.Queue()
    response_queue = queue.Queue()


    def fakemain(task_queue, a, b):
        print("fake thing running")
        time.sleep(3)
        print("raising")
        raise ValueError("AAAAAAAAAAAAAAAAAAA")

    if len(sys.argv) > 1:
        if sys.argv[0] == "test":
            test = True
        elif sys.argv[0] in ["notest", "no-test"]:
            test = False
        else:
            raise ValueError("Invalid argument. Use 'test' or 'notest'")
        
    if os.path.exists("test.json"):
        test = json.load(open("test.json", "r", encoding="utf-8"))["test"]
    else:
        test = True
        with open("test.json", "w", encoding="utf-8") as f:
            json.dump({"test": True}, f, indent=4)

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
                time.sleep(10)
                now = datetime.now()
                minutes = now.hour*60+now.minute
                # if 0:#if minutes < 900 or minutes > 1080 and time.time()-start > 15:
                #     print("sending sms")
                #     client = vonage.Client(key="8a5d61ed", secret="Ylf6nHiJ9VJkPj5E")
                #     sms = vonage.Sms(client)

                #     responseData = sms.send_message(
                #         {
                #             "from": "Vonage APIs",
                #             "to": "4798035320",
                #             "text": "abnormal crash time\n",
                #         }
                #     )

                #     if responseData["messages"][0]["status"] == "0":
                #         print("Message sent successfully.")
                #         app.logger.info("Message sent successfully.")
                #     else:
                #         print(f"Message failed with error: {responseData['messages'][0]['error-text']}")
                #         app.logger.warning(f"Message failed with error: {responseData['messages'][0]['error-text']}")

                #     print("waiting 2 hours")
                #     time.sleep(2*60*60)
                #else:
                #    print("waiting untill 20:30")
                #    time.sleep(max((1230-minutes)*60, 2*60*60))
                

                
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