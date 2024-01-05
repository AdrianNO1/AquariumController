import threading
import queue
import time
import test2

# Create queues for communication
task_queue = queue.Queue()
response_queue = queue.Queue()

# Function to run in the thread
def thread_function():
    test2.run(task_queue, response_queue)

# Start the thread
thread = threading.Thread(target=thread_function)
thread.start()

# Function to call a function in the other script
def call_function_in_other_script(func_name, *args, **kwargs):
    task_queue.put((func_name, args, kwargs))

# Function to get responses from the other script
def get_response():
    try:
        return response_queue.get_nowait()
    except queue.Empty:
        return None

# Example usage
call_function_in_other_script('example_function', 1, 2, key='value')

# Main script continues running...
for _ in range(10):
    print("Main script is running...")
    response = get_response()
    if response:
        print(f"Received response: {response}")
    time.sleep(1)

# Optionally, wait for the thread to finish
thread.join()
