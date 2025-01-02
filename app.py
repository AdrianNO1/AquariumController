import json, os, sys, re, time

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

from flask import Flask, request, jsonify, render_template, url_for, redirect, flash, session
from flask_login import LoginManager, login_user, logout_user, login_required, UserMixin, current_user
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from datetime import datetime, timedelta
from manager import main
from custom_syntax import parse_code
import threading
import queue, logging, glob, subprocess, signal#, vonage
from werkzeug.security import check_password_hash

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
code_path = os.path.join("data", "code.json")
throttle_path = os.path.join("data", "throttle.json")
switches_path = os.path.join("data", "switches.json")
channels_path = os.path.join("data", "channels.json")
temporaryoverwritesliders_path = os.path.join("data", "temporaryoverwritesliders.json")

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

@app.route('/lights')
@login_required
def lights():
    return render_template('lightpumps.html')

@app.route('/pumps')
@login_required
def pumps():
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
def test():
    app.logger.info("test request")
    return jsonify({"message": "Test Func"})

@app.route('/load', methods=['POST'])
@login_required
def load():
    app.logger.info("load request")
    data = request.json
    mode = data["type"]
    nodes = json.load(open(links_path, "r", encoding="utf-8"))
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

    code = json.load(open(code_path, "r", encoding="utf-8"))
    throttle = json.load(open(throttle_path, "r", encoding="utf-8"))[mode + "throttle"]
    outputs = json.load(open(channels_path, "r", encoding="utf-8"))
    
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


    return jsonify({"data": json.dumps(nodes), "code": json.dumps(code["code"]), "throttle": throttle, "error_lines": error_lines, "avaliable_channels": avaliable_channels, "outputs": json.dumps(outputs)})

@app.route('/loadarduinoinfo', methods=['POST'])
@login_required
def load_arduino_info():
    app.logger.info("loadarduinoinfo request")
    data = request.json
    
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
    
    links = json.load(open(links_path, "r", encoding="utf-8"))
    for key in data["links_data"]:
        links[key] = data["links_data"][key]
    with open(links_path, "w", encoding="utf-8") as f:
        json.dump(links, f, indent=4)

    throttle = json.load(open(throttle_path, "r", encoding="utf-8"))
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

@app.route('/verify', methods=['POST'])
@login_required
def verify():
    app.logger.info("verify request")
    data = request.json
    code = data["code"]
    arduinos = data["arduinos"]

    evaluation = parse_code(code, verify=True, arduinos=arduinos)

    #clear_res_queue()
    #task_queue.put(("func_name, args, kwargs",))
    #start = time.time()
    #while time.time() - start < 5:
    #    try:
    #        thing = response_queue.get(timeout=0.1)
    #    except queue.Empty:
    #        thing = None
    #
    #print(thing)
    if evaluation.startswith("Error"):
        response = {'error': evaluation}
    else:
        response = {'message': evaluation.strip()}
    return jsonify(response)

@app.route('/run once', methods=['POST'])
@login_required
def run_once():
    app.logger.info("run once request")
    data = request.json
    code = data["code"]
    arduinos = data["arduinos"]

    verify_evaluation = parse_code(code, verify=True, arduinos=arduinos)
    if verify_evaluation.startswith("Error"):
        response = {'error': verify_evaluation}
        return jsonify(response)
    
    evaluation = parse_code(code, verify=False, task_queue=task_queue, response_queue=response_queue, arduinos=arduinos)
    if evaluation.startswith("Error"):
        response = {'error': evaluation}
    else:
        response = {'message': evaluation.strip()}

    return jsonify(response)

@app.route('/uploadandrun', methods=['POST'])
@login_required
def upload_and_run():
    app.logger.info("upload and run request")
    data = request.json
    code = data["code"]
    arduinos = data["arduinos"]

    verify_evaluation = parse_code(code, verify=True, arduinos=arduinos)
    if verify_evaluation.startswith("Error"):
        response = {'error': verify_evaluation}
        return jsonify(response)
    
    evaluation = parse_code(code, verify=False, task_queue=task_queue, response_queue=response_queue, arduinos=arduinos)
    if evaluation.startswith("Error"):
        response = {'error': evaluation}
    else:
        response = {'message': evaluation.strip()}
        with open(code_path, "w", encoding="utf-8") as f:
            json.dump({"code": code}, f, indent=4)

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

@app.route('/preview', methods=['POST'])
@login_required
def preview():
    app.logger.info("preview request")
    data = request.json

    with open(links_path, "w", encoding="utf-8") as f:
        json.dump(data["links_data"], f, indent=4)

    clear_res_queue()
    task_queue.put("preview")
    try:
        response = {"data": response_queue.get(timeout=10)}
    except:
        response = {'error': "timeout when waiting for response from manager"}

    return jsonify(response)

@app.route('/cancelpreview', methods=['POST'])
@login_required
def cancelpreview():
    app.logger.info("cancelpreview request")

    clear_res_queue()
    task_queue.put("cancelpreview")
    try:
        response = {"data": response_queue.get(timeout=10)}
    except:
        response = {'error': "timeout when waiting for response from manager"}

    return jsonify(response)



#@app.route('/getlog', methods=['POST'])
#def getlog():
#    data = request.json
#    data["limit"]
#    return jsonify(response)




if __name__ == '__main__':
    # Create queues for communication
    task_queue = queue.Queue()
    response_queue = queue.Queue()


    def fakemain(task_queue, a, b):
        print("fake thing running")
        time.sleep(3)
        print("raising")
        raise ValueError("AAAAAAAAAAAAAAAAAAA")

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