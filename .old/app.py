import io, json, os, sys, re, time, requests, dotenv, zipfile
dotenv.load_dotenv()

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
from utils import read_json_file
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
switches_path = os.path.join("data", "switches.json")
channels_path = os.path.join("data", "channels.json")
temporaryoverwritesliders_path = os.path.join("data", "temporaryoverwritesliders.json")
LOG_DIRECTORIES = {
    "app": os.path.join("logs", "app"),
    "manager": os.path.join("logs", "manager")
}
LOG_ENTRY_PATTERN = re.compile(r'^(?P<timestamp>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3}) - (?P<logger>.*?) - (?P<level>[A-Z]+) - (?P<message>.*)$')
MAX_LOG_DAYS = 30

def clamp_log_days(raw_days, default=7):
    try:
        days = int(raw_days)
    except (TypeError, ValueError):
        days = default
    return max(1, min(MAX_LOG_DAYS, days))

def normalize_log_level(level):
    normalized = str(level or "all").strip().lower()
    if normalized in ("warn", "warning"):
        return "WARNING"
    if normalized == "fatal":
        return "CRITICAL"
    if normalized == "all":
        return "ALL"
    return normalized.upper()

def format_file_timestamp(dt):
    return dt.strftime("%Y-%m-%d %H:%M:%S")

def list_recent_log_files(days=7, source="all"):
    cutoff = datetime.now() - timedelta(days=days)
    files = []

    for log_source, directory in LOG_DIRECTORIES.items():
        if source != "all" and log_source != source:
            continue

        if not os.path.isdir(directory):
            continue

        for path in glob.glob(os.path.join(directory, "*")):
            if not os.path.isfile(path):
                continue
            if not (path.endswith(".log") or path.endswith(".zip")):
                continue

            modified = datetime.fromtimestamp(os.path.getmtime(path))
            if modified < cutoff:
                continue

            files.append({
                "source": log_source,
                "path": path,
                "name": os.path.basename(path),
                "modified": modified,
                "kind": "zip" if path.endswith(".zip") else "log"
            })

    files.sort(key=lambda item: item["modified"], reverse=True)
    return files

def iter_log_sources(file_info):
    path = file_info["path"]
    if path.endswith(".zip"):
        try:
            with zipfile.ZipFile(path, "r") as archive:
                for member in archive.namelist():
                    if member.endswith("/"):
                        continue
                    with archive.open(member) as zipped_file:
                        content = zipped_file.read().decode("utf-8", errors="replace").splitlines()
                    yield member, content
        except zipfile.BadZipFile:
            yield os.path.basename(path), [f"Unreadable zip archive: {path}"]
        return

    with open(path, "r", encoding="utf-8", errors="replace") as log_file:
        yield os.path.basename(path), log_file.read().splitlines()

def parse_log_entries_from_lines(lines, file_info, member_name, cutoff):
    entries = []
    file_label = f"{file_info['name']}::{member_name}" if file_info["kind"] == "zip" else file_info["name"]
    current_entry = None

    def flush_current():
        nonlocal current_entry
        if current_entry and current_entry["timestamp_dt"] >= cutoff:
            entries.append(current_entry)
        current_entry = None

    for raw_line in lines:
        line = raw_line.rstrip("\r\n")
        match = LOG_ENTRY_PATTERN.match(line)

        if match:
            flush_current()
            try:
                timestamp_dt = datetime.strptime(match.group("timestamp"), "%Y-%m-%d %H:%M:%S,%f")
            except ValueError:
                timestamp_dt = file_info["modified"]

            current_entry = {
                "timestamp": match.group("timestamp"),
                "timestamp_dt": timestamp_dt,
                "logger": match.group("logger"),
                "level": normalize_log_level(match.group("level")),
                "message": match.group("message"),
                "source": file_info["source"],
                "file": file_label
            }
            continue

        if not line.strip():
            continue

        if current_entry is None:
            current_entry = {
                "timestamp": format_file_timestamp(file_info["modified"]),
                "timestamp_dt": file_info["modified"],
                "logger": file_info["source"],
                "level": "INFO",
                "message": line,
                "source": file_info["source"],
                "file": file_label
            }
        else:
            current_entry["message"] += "\n" + line

    flush_current()
    return entries

def collect_log_entries(days=7, source="all"):
    cutoff = datetime.now() - timedelta(days=days)
    files = list_recent_log_files(days=days, source=source)
    entries = []

    for file_info in files:
        for member_name, lines in iter_log_sources(file_info):
            entries.extend(parse_log_entries_from_lines(lines, file_info, member_name, cutoff))

    entries.sort(key=lambda entry: entry["timestamp_dt"], reverse=True)
    return entries, files

def filter_log_entries(entries, level="all", search=""):
    normalized_level = normalize_log_level(level)
    search_term = (search or "").strip().lower()
    filtered_entries = []

    for entry in entries:
        if normalized_level != "ALL" and entry["level"] != normalized_level:
            continue

        if search_term:
            haystack = "\n".join([
                entry["message"],
                entry["logger"],
                entry["file"],
                entry["source"],
                entry["level"]
            ]).lower()
            if search_term not in haystack:
                continue

        filtered_entries.append(entry)

    return filtered_entries

def serialize_log_entry(entry):
    return {
        "timestamp": entry["timestamp"],
        "logger": entry["logger"],
        "level": entry["level"],
        "message": entry["message"],
        "source": entry["source"],
        "file": entry["file"]
    }

def serialize_log_file(file_info):
    return {
        "name": file_info["name"],
        "source": file_info["source"],
        "modified": format_file_timestamp(file_info["modified"]),
        "kind": file_info["kind"]
    }

def format_log_entry_text(entry):
    header = f"{entry['timestamp']} - {entry['logger']} - {entry['level']} - {entry['message']}"
    return f"[{entry['source']}] {entry['file']}\n{header}\n"

def build_log_summary(days, source, level, search, entry_count, file_count):
    source_label = "app and manager" if source == "all" else source
    level_label = "all levels" if normalize_log_level(level) == "ALL" else normalize_log_level(level)
    search_label = search if search else "none"
    return (
        "Aquarium log export\n"
        f"Days: {days}\n"
        f"Source: {source_label}\n"
        f"Level: {level_label}\n"
        f"Search: {search_label}\n"
        f"Matching entries: {entry_count}\n"
        f"Files included: {file_count}\n"
    )

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

@app.route('/logs')
def logs_page():
    return render_template('logs.html', default_days=7)

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
def getlog():
    return redirect(url_for('download_logs', mode='raw', days=7, source='all'))

@app.route('/api/logs')
def get_logs_api():
    days = clamp_log_days(request.args.get("days", 7))
    source = request.args.get("source", "all").strip().lower()
    level = request.args.get("level", "all")
    search = request.args.get("search", "")

    if source not in ("all", "app", "manager"):
        return jsonify({"error": "invalid source"}), 400

    entries, files = collect_log_entries(days=days, source=source)
    filtered_entries = filter_log_entries(entries, level=level, search=search)

    response = {
        "entries": [serialize_log_entry(entry) for entry in filtered_entries],
        "files": [serialize_log_file(file_info) for file_info in files],
        "summary": {
            "days": days,
            "source": source,
            "source_label": "app + manager" if source == "all" else source,
            "level": normalize_log_level(level),
            "entry_count": len(filtered_entries),
            "file_count": len(files),
            "error_count": sum(1 for entry in filtered_entries if entry["level"] == "ERROR"),
            "warning_count": sum(1 for entry in filtered_entries if entry["level"] == "WARNING")
        }
    }
    return jsonify(response)

@app.route('/logs/download')
def download_logs():
    app.logger.info("logs download request")
    days = clamp_log_days(request.args.get("days", 7))
    source = request.args.get("source", "all").strip().lower()
    level = request.args.get("level", "all")
    search = request.args.get("search", "")
    mode = request.args.get("mode", "filtered").strip().lower()

    if source not in ("all", "app", "manager"):
        return jsonify({"error": "invalid source"}), 400
    if mode not in ("filtered", "raw"):
        return jsonify({"error": "invalid download mode"}), 400

    entries, files = collect_log_entries(days=days, source=source)
    filtered_entries = filter_log_entries(entries, level=level, search=search)
    timestamp = datetime.now().strftime("%d-%m-%Y_%H-%M-%S")

    archive_buffer = io.BytesIO()
    with zipfile.ZipFile(archive_buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        summary = build_log_summary(days, source, level, search, len(filtered_entries), len(files))
        archive.writestr("README.txt", summary)

        if mode == "filtered":
            if filtered_entries:
                filtered_text = "\n".join(format_log_entry_text(entry) for entry in filtered_entries)
            else:
                filtered_text = "No log entries matched the selected filter.\n"

            archive.writestr("filtered_logs.txt", filtered_text)
            archive.writestr("filtered_logs.json", json.dumps([serialize_log_entry(entry) for entry in filtered_entries], indent=2))
        else:
            if not files:
                archive.writestr("no_logs_found.txt", "No log files were found for the selected range.\n")

            for file_info in files:
                archive_path = os.path.join(file_info["source"], file_info["name"]).replace("\\", "/")
                archive.write(file_info["path"], arcname=archive_path)

            if filtered_entries and (normalize_log_level(level) != "ALL" or search):
                archive.writestr(
                    "filtered_logs.txt",
                    "\n".join(format_log_entry_text(entry) for entry in filtered_entries)
                )

    archive_buffer.seek(0)
    return send_file(
        archive_buffer,
        mimetype="application/zip",
        as_attachment=True,
        download_name=f"aquarium_logs_{mode}_{timestamp}.zip"
    )


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
