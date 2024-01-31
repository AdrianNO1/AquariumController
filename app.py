import json, os, sys, re

sys.path.append(os.path.dirname(os.path.realpath(__file__)))

from flask import Flask, request, jsonify, render_template, url_for
from multiprocessing import Process
from datetime import datetime
from manager import main
from custom_syntax import parse_code
import threading
import queue, time, logging, glob

app = Flask(__name__)


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

@app.errorhandler(500)
def handle_internal_server_error(e):
    app.logger.error('Internal Server Error: %s', e)
    return "Internal Server Error", 500

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/load', methods=['POST'])
def load():
    app.logger.info("load request")
    data = request.json
    nodes = json.load(open(links_path, "r", encoding="utf-8"))
    for key in nodes.keys():
        i = 0
        for link in nodes[key]:
            nodes[key][i] = link["source"]
            i += 1
        nodes[key] = nodes[key][1:]

    code = json.load(open(code_path, "r", encoding="utf-8"))
    throttle = json.load(open(throttle_path, "r", encoding="utf-8"))["throttle"]
    
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


    return jsonify({"data": json.dumps(nodes), "code": json.dumps(code["code"]), "throttle": throttle, "error_lines": error_lines})

@app.route('/load arduino info', methods=['POST'])
def load_arduino_info():
    app.logger.info("load_arduino_info request")
    data = request.json
    
    task_queue.put("get_arduinos")
    try:
        response = response_queue.get(timeout=30)
    except queue.Empty:
        return jsonify({"error": "Unable to fetch arduino data. The manager is not responding. It may have crashed and may not be updating the arduinos."})


    return jsonify({"data": json.dumps(response)}) # , "arduinoConstants": json.dumps(code["arduinoConstants"])

@app.route('/upload', methods=['POST'])
def upload():
    app.logger.info("upload request")
    data = request.json
    
    with open(links_path, "w", encoding="utf-8") as f:
        json.dump(data["links_data"], f, indent=4)

    with open(throttle_path, "w", encoding="utf-8") as f:
        json.dump({"throttle": data["throttle"]}, f, indent=4)

    response = {'message': 'ok'}
    return jsonify(response)

@app.route('/verify', methods=['POST'])
def verify():
    app.logger.info("verify request")
    data = request.json
    code = data["code"]
    arduinos = data["arduinos"]

    evaluation = parse_code(code, verify=True, arduinos=arduinos)

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
def rename():
    app.logger.info("upload and run request")
    data = request.json

    task_queue.put(("rename", data["device"], data["newname"]))
    try:
        response = {"data": response_queue.get(timeout=10)}
    except:
        response = {'error': "timeout when waiting for response from manager"}

    return jsonify(response)

@app.route('/preview', methods=['POST'])
def preview():
    app.logger.info("preview request")
    data = request.json

    with open(links_path, "w", encoding="utf-8") as f:
        json.dump(data["links_data"], f, indent=4)

    task_queue.put("preview")
    try:
        response = {"data": response_queue.get(timeout=10)}
    except:
        response = {'error': "timeout when waiting for response from manager"}

    return jsonify(response)

@app.route('/cancelpreview', methods=['POST'])
def cancelpreview():
    app.logger.info("cancelpreview request")

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


    # Function to run in the thread
    def thread_function():
        main(task_queue, response_queue, test=False)

    # Start the thread
    thread = threading.Thread(target=thread_function)
    thread.start()

    app.logger.info("starting app")
    app.run(debug=False, port=2389, host="0.0.0.0")