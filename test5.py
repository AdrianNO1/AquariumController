import re, os, sys
from datetime import datetime

def checkTime(time1, time2):
    current_time = datetime.utcnow().time()

    start_time = datetime.strptime(time1, "%H:%M").time()
    end_time = datetime.strptime(time2, "%H:%M").time()
    
    return start_time <= current_time <= end_time


def replace_time_with_function(input_string):
    # Define the regex pattern to match "Time "HH:MM" to "HH:MM""
    time_pattern = r'Time "(\d{1,2}:\d{2})" to "(\d{1,2}:\d{2})"'

    # Define a function to use as a replacement. It captures the matched groups and formats them.
    def replacement(match):
        start_time, end_time = match.groups()
        return f'checkTime("{start_time}", "{end_time}")'

    # Use re.sub() to replace all occurrences of the pattern with the output of the replacement function
    result = re.sub(time_pattern, replacement, input_string)

    # Replace the time conditions with a placeholder that is unlikely to occur in the input
    #placeholder = "TIME_CONDITION_PLACEHOLDER"
    #placeholderresult = re.sub(time_pattern, placeholder, input_string)
#
#
    ## Split the result string by logical operators "and" and "or", and strip whitespace
    #parts = re.split(r'\s+(and|or)\s+', placeholderresult)
#
    ## Filter out the placeholders and empty strings
    #non_time_conditions = [part for part in parts if placeholder not in part and part.strip()]
#
    ## Remove any remaining parentheses
    #non_time_conditions = list(set([x for x in [re.sub(r'^\(|\)$', '', cond) for cond in non_time_conditions] if x not in ["and", "or"]]))

    return result#, non_time_conditions



a = """if Time "19:00" to "18:00" or Arduino1.set:
    print("yes")
elif Time "19:00" to "14:00":
	print("here")
else:
	print("no")"""

fixed_string = replace_time_with_function(a).replace("==", "=").replace("=", "==")

print(exec(fixed_string))