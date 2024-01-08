import json, os, sys
from flask import Flask, request, jsonify, render_template, url_for
from multiprocessing import Process
from manager import main
app = Flask(__name__)


links_path = os.path.join("data", "links.json")

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/load', methods=['POST'])
def load():
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
    data = request.json
    
    with open(links_path, "w", encoding="utf-8") as f:
        json.dump(data["links_data"], f, indent=4)
    response = {'message': 'ok'}
    return jsonify(response)

#@app.route('/getlog', methods=['POST'])
#def getlog():
#    data = request.json
#    data["limit"]
#    return jsonify(response)



if __name__ == '__main__':
    p = Process(target=main, args=(True,))
    #p.start()
    app.run(debug=True, port=2389)#, host="0.0.0.0")
    p.join()