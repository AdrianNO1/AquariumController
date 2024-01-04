import json
from flask import Flask, request, jsonify, render_template
app = Flask(__name__)


@app.route('/')
def index():
    return render_template('index.html')

@app.route('/message', methods=['POST'])
def message():
    data = request.json
    if "type" not in data:
        print("no message type:", data)
        return jsonify({'message': 'Error: no message type.'})
    
    if data["type"] == "upload":
        with open("data\\" + data["name"] + ".json", "w", encoding="utf-8") as f:
            json.dump(data["data"], f, indent=4)
        response = {'message': 'ok'}
        return jsonify(response)
    else:
        return jsonify({'message': 'Invalid type'})


    

if __name__ == '__main__':
    app.run(debug=True, port=2389)# host="0.0.0.0"


