#!/bin/bash
#!/bin/bash
# Log file path
LOG_FILE="/home/adrian/webserver_startup.log"

# Redirect all output to the log file
exec > "$LOG_FILE" 2>&1

# Print the current date and time
date

# Print the current user
echo "Running as user: $(whoami)"

# Print current directory
echo "Current directory: $(pwd)"

# Change to the script directory
cd /home/adrian/AquariumController
echo "Changed to directory: $(pwd)"

# Print Python version
echo "Python version:"
python --version

# Run the Python script
echo "Starting Python script..."
python app.py
