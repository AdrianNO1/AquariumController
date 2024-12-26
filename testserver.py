from flask import Flask

app = Flask(__name__)

@app.route('/')
def home():
    return 'Hello'

@app.route('/test')
def test():
    return 'Test endpoint is working!'

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)