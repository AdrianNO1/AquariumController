from flask import Flask, request, jsonify, render_template
app = Flask(__name__)

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/message', methods=['POST'])
def message():
    data = request.json
    # Process the message from the website
    print(f"Received message: {data['message']}")
    # Send a response back to the website
    response = {'reply': 'Message received!'}
    return jsonify(response)

if __name__ == '__main__':
    app.run(debug=True, port=2389)


