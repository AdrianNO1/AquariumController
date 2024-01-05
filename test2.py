import time, queue

def run(task_queue, response_queue):
    while True:
        try:
            # Check for a new task
            task = task_queue.get_nowait()
        except queue.Empty:
            # No task, continue running the script
            pass
        else:
            # If a task is received, execute it
            func_name, args, kwargs = task
            if func_name in globals():
                result = globals()[func_name](*args, **kwargs)
                response_queue.put(result)
            else:
                print(f"Function {func_name} not found in other_script.")

        # Other script's main loop continues...
        print("Other script is running...")
        time.sleep(1)

def example_function(a, b, key=None):
    print(f"example_function called with arguments: {a}, {b}, {key}")
    return f"Result from example_function: {a + b}"
