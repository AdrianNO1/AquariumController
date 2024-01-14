import re, regex
from datetime import datetime

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

    def recursively_get_inner_function(text, depth):
        depth += 1
        print("INP:", text)
        if text.find(".") != -1 and text.find(".") < text.find("("):
            full_func = ".".join(text.split(".")[1:])
        else:
            full_func = text

        pattern = r'\((.*)\)'
        func = regex.sub(pattern, '', full_func)
        matches = regex.findall(pattern, full_func)

        print("MATCHES:", matches)

        parameters = re.split(r',\s*(?![^()]*\))', matches[0]) if matches else []
        print("FOUND:", parameters)
        if parameters:
            for param in parameters:
                new, depth = recursively_get_inner_function(param, depth)
                parameters += new
        return parameters, depth
    
    depth = 0
    for condition in non_time_conditions[:]:
        new, depth = recursively_get_inner_function(condition, depth)
        non_time_conditions += new

    return result, non_time_conditions

# Test the function
input_string = 'Time "12:00" to "18:00" and ch1.analogWrite(9, ch1.analogWrite2(ch1.analogWrite3(11, Red)) or (ch1.testing() and ch1.isPinOn(99)))'

input_string = 'Time "12:00" to "18:00" and ch1.analogWrite(9, ch1.analogWrite2(5, 6))'
result, non_time_conditions = replace_time_with_function(input_string)
print(result)
print()
print(non_time_conditions)
print()
print()