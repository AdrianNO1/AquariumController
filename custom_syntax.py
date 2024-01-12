import re, os, sys, queue
from datetime import datetime, timedelta

def checkTime(time1, time2):
    current_time = datetime.utcnow().time()
    start_time = datetime.strptime(time1, "%H:%M").time()
    end_time = datetime.strptime(time2, "%H:%M").time()
    
    # If the start time is less than the end time, it's the same day
    if start_time < end_time:
        return start_time <= current_time <= end_time
    else:
        # If the current time is greater than or equal to the start time, 
        # we're checking the same day from start time to midnight
        if current_time >= start_time:
            return True
        # If the current time is less than the end time, 
        # we're checking from midnight to the end time on the following day
        elif current_time <= end_time:
            return True
        else:
            # The current time is not within the range
            return False


def replace_time_with_function(input_string):
    # Define the regex pattern to match "Time "HH:MM" to "HH:MM""
    time_pattern = r'Time "(\d{1,2}:\d{2})" to "(\d{1,2}:\d{2})"'

    # Define a function to use as a replacement. It captures the matched groups and formats them.
    def replacement(match):
        start_time, end_time = match.groups()
        for time in [start_time, end_time]:
            try:
                datetime.strptime(time, '%H:%M')
            except ValueError:
                return "anErrorHasOccured"
        return f'checkTime("{start_time}", "{end_time}")'

    # Use re.sub() to replace all occurrences of the pattern with the output of the replacement function
    result = re.sub(time_pattern, replacement, input_string)

    # Replace the time conditions with a placeholder that is unlikely to occur in the input
    placeholder = "TIME_CONDITION_PLACEHOLDER_THINGY91rkdfmin3inasdj"
    placeholderresult = re.sub(time_pattern, placeholder, input_string)

    # Split the result string by logical operators "and" and "or", and strip whitespace
    parts = re.split(r'\s+(and|or)\s+', placeholderresult)

    # Filter out the placeholders and empty strings
    non_time_conditions = [part for part in parts if placeholder not in part and part.strip()]

    # Remove any remaining parentheses and negations
    non_time_conditions = [re.sub(r'^(not\s+)?(.+)$', r'\2', cond).strip() for cond in non_time_conditions]

    # Remove duplicates and logical operators
    non_time_conditions = [x for x in list(set(non_time_conditions)) if x not in ['and', 'or', 'not']]

    # Sort the list to ensure consistent order
    non_time_conditions.sort()

    return result, non_time_conditions

def checkFunctionParameterValidity(func, parameters):
    if func == "isOn":
        if len(parameters) == 0:
            return False
        else:
            return f"Unpexpected amount . Got of parameters: {parameters}. Expected {0}. Got {len(parameters)}"
    
    elif func == "isOff":
        if len(parameters) == 0:
            return False
        else:
            return f"Unpexpected amount . Got of parameters: {parameters}. Expected {0}. Got {len(parameters)}"
    
    elif func == "analogWrite":
        if len(parameters) == 2:
            pin = parameters[0]
            value = parameters[1]
            try:
                pin = int(pin)
            except:
                return f"pin: {pin} is not a valid number"
            try:
                value = int(value)
            except:
                return f"value: {value} is not a valid number"
            
            if pin not in [3, 5, 6, 9, 10, 11]:
                return f"Pin: {pin} is not a valid PWM pin. PWM capable pins are: 3, 5, 6, 9, 10, and 11"
            
            if value > 100 or value < 0:
                return f"Value: {value} is not a number between 0 and 100"

            return False
        else:
            return f"Unpexpected amount . Got of parameters: {parameters}. Expected {2}. Got {len(parameters)}"
    else:
        return f"Invalid function: {func}"
    
    #elif func == "analogRead":
    #    if len(parameters) == 1:
    #        pin = parameters[0]
    #        try:
    #            pin = int(pin)
    #        except:
    #            return f"pin: {pin} is not a valid number"
    #        
    #        if pin not in [3, 5, 6, 9, 10, 11]:
    #            return f"Pin: {pin} is not a valid PWM pin. PWM capable pins are: 3, 5, 6, 9, 10, and 11"
#
    #        return False
    #    else:
    #        return f"Unpexpected amount . Got of parameters: {parameters}. Expected {1}. Got {len(parameters)}"

def process_command(c, verify=False, task_queue=None, response_queue=None, run_cmd_func=None):
    global fixed_string, i
    obj = c.split(".")[0]
    if obj and obj[0] == '"' and obj[-1] == '"':
        pass
    elif obj and obj in globals():
        if len(c.split(".")) == 2:
            pattern = r'\((.*?)\)'
            func = re.sub(pattern, '', c.split(".")[1])
            parameters = re.findall(pattern, c.split(".")[1])
            #if hasattr(globals()[obj], func):
            if len(parameters) > 1:
                return f"Error on line {i+1}: Unexpected amount of parenthesis when parsing {c.split('.')[0]}"
            elif len(parameters) == 0:
                return f"Error on line {i+1}: No parenthesis while parsing function {obj}.{c.split('.')[0]}"
            
            response = checkFunctionParameterValidity(func, [x.strip() for x in parameters[0].split(",") if x])
            if response:
                return f"Error on line {i+1} while testing function {obj}.{c.split('.')[1]}: {response}"
            
            if verify:
                fixed_string = fixed_string.replace(c, "True")
            else:
                try:
                    task = None
                    if (not task_queue or not response_queue) and not run_cmd_func:
                        raise ValueError("Internal error: queue is of type None and no function provided. This should not happen")
                    if run_cmd_func:
                        task = run_cmd_func(task=c)
                    else:
                        task_queue.put(c)
                        try:
                            task = response_queue.get(timeout=30)
                        except queue.Empty:
                            return f"Error on line {i+1}: Internal error. Arduino manager did not respond within 30 seconds. It may be off."

                    print("GOT RESPONSE FROM MANAGER:", str(task))
                    if "error" in str(task).lower():
                        raise ValueError("See response from manager")
                    
                    fixed_string = fixed_string.replace(c, str(task))
                    print(fixed_string)
                except Exception as e:
                    return f"Error while evaluating on line {i+1}: {e}. Response from manager:" + (str(task) if task else "")
            
            #elif len(c.split(".")) != 0:
            #    #print(non_time_conditions)
            #    return f"Error on line {i+1}: {obj} has no attribute {func}"
        elif len(c.split(".")) == 1:
            fixed_string = fixed_string.replace(c, "True")

        else:
            return f"Error on line {i+1}: something something too many dots"
    else:
        return f"Error on line {i+1}: {obj} does not exist"

class Arduino1:
    def isOn(self):
        pass

fixed_string = ""
i = 0

def parse_code(code, verify=True, task_queue=None, response_queue=None, run_cmd_func=None):
    global fixed_string, i
    returned = ""
    evaluation = False
    increase_indent = False
    expected_indent = 0
    i = 0
    for line in code.split("\n"):
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip())
        if indent <= expected_indent or increase_indent or verify:
            increase_indent = False
            expected_indent = int(indent)/4
            if line.lstrip().startswith("if ") or (not evaluation and line.lstrip().startswith("elif ") or (line.lstrip().startswith("elif ") and verify)):
                #print("evaluating if")
                if line.endswith(":"):
                    if line.lstrip().startswith("if "):
                        args = line[3:-1]
                    else:
                        args = line[5:-1]
                    #print(args)
                    fixed_string, non_time_conditions = replace_time_with_function(args)
                    fixed_string = fixed_string.replace("==", "=").replace("=", "==")
                    
                    if "anErrorHasOccured" in fixed_string:
                        return f"Error on line {i+1}: Invalid time"
                    
                    for c in non_time_conditions:
                        response = process_command(c, verify=verify, task_queue=task_queue, response_queue=response_queue, run_cmd_func=run_cmd_func)
                        if response:
                            return response
                            
                    try:
                        #print("EVALUATING:", fixed_string)
                        evaluation = eval(fixed_string)
                    except Exception as e:
                        return f"Error while evaluating on line {i+1}: {e}"
                    #print(evaluation)
                    if evaluation:
                        increase_indent = True
                else:
                    return f"Error on line {i+1}: colon expected at end of if statement '{line}'"
            elif line.lstrip().startswith("else:"):
                #print("else")
                if not evaluation:
                    #print("going into else")
                    increase_indent = True
                #else:
                #    print("not going into else")
            elif line.lstrip().startswith("print"):
                inside = line.lstrip()[6:-1]

                fixed_string, non_time_conditions = replace_time_with_function(inside)
                fixed_string = fixed_string.replace("==", "=").replace("=", "==")

                print("FIEXEDASSETINGR:", fixed_string)
                print("NONTIMEOCNRFNIENFITNIA:", non_time_conditions)

                for c in non_time_conditions:
                    response = process_command(c, verify=verify, task_queue=task_queue, response_queue=response_queue, run_cmd_func=run_cmd_func)
                    if response:
                        return response

                try:
                    returned += str(eval(fixed_string)) + "\n"
                except Exception as e:
                    return f"Error while evaluating on line {i+1}: {e}"
                

            elif not line.lstrip().startswith("elif "):
                response = process_command(line, verify=verify, task_queue=task_queue, response_queue=response_queue, run_cmd_func=run_cmd_func)
                if response:
                    return response
                
            # TODO add variable assignment and reading from pins. Can be managed with a dictionary.

        #print()
        i += 1
    return returned

if __name__ == "__main__":
    code = """

    
if Time "17:00" to "18:00" or Arduino1.isOn():
    print("yess")
elif Time "19:00" to "14:00":
    print("here")
else:
    print("no")"""
    print("RETURNED:", parse_code(code))