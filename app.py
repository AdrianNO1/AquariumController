import json, os, sys, re
from flask import Flask, request, jsonify, render_template, url_for
from multiprocessing import Process
from datetime import datetime
from manager import main
from custom_syntax import parse_code
import threading
import queue, time, logging

app = Flask(__name__)


# Create handlers
current_log_path = os.path.join("logs\\app", datetime.now().strftime("%d-%m-%Y %H-%M-%S") + ".log")
handler = logging.FileHandler(current_log_path, encoding="utf-8")  # Log to a file

# Create formatters and add it to handlers
formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
handler.setFormatter(formatter)

# Add handlers to the logger
app.logger.addHandler(handler)

app.logger.info("started new session")
app.logger.setLevel(logging.INFO)


links_path = os.path.join("data", "links.json")

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
    return jsonify({"data": json.dumps(nodes)})

@app.route('/upload', methods=['POST'])
def upload():
    app.logger.info("upload request")
    data = request.json
    
    with open(links_path, "w", encoding="utf-8") as f:
        json.dump(data["links_data"], f, indent=4)
    response = {'message': 'ok'}
    return jsonify(response)

@app.route('/verify', methods=['POST'])
def verify():
    app.logger.info("verify request")
    data = request.json
    code = data["code"]
    evaluation = parse_code(code, verify=True)

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
    evaluation = parse_code(code, verify=False)

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
        main(task_queue, response_queue, test=True)

    # Start the thread
    thread = threading.Thread(target=thread_function)
    thread.start()


    #p = Process(target=main, args=(True,))
    #p.start()
    app.logger.info("starting app")
    app.run(debug=False, port=2389)#, host="0.0.0.0")
    #p.join()