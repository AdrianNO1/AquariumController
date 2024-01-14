import re

def recursively_get_inner_function(text, depth, arg_dict):
    depth += 1
    if text.find(".") != -1 and text.find(".") < text.find("("):
        full_func = ".".join(text.split(".")[1:])
    else:
        full_func = text

    pattern = r'\((.*)\)'
    func = re.sub(pattern, '', full_func)
    matches = re.findall(pattern, full_func)

    parameters = re.split(r',\s*(?![^()]*\))', matches[0]) if matches else []
    if parameters:
        for i, param in enumerate(parameters):
            new, depth, arg_dict, _ = recursively_get_inner_function(param, depth, arg_dict)
            arg_key = f"ARG{depth}"
            arg_dict[arg_key] = param
            parameters[i] = arg_key
            depth += 1

    # Replace the parameters in the original text with their ARG placeholders
    for arg_key, param in arg_dict.items():
        text = text.replace(param, arg_key)

    return parameters, depth, arg_dict, text

arr = ['ch1.analogWrite(9, ch1.analogWrite2(5, 6))']

d = {
    "ARG1": "ch1.analogWrite(ARG2, ARG3)",
    "ARG2": "9",
    "ARG3": "ch1.analogWrite2(ARG4, ARG5)",
    "ARG4": "5",
    "ARG5": "6"
}

arg_dict = {}
depth = 0
for condition in arr[:]:
    new, depth, arg_dict, new_condition = recursively_get_inner_function(condition, depth, arg_dict)
    arr += new
    arr[arr.index(condition)] = new_condition

print(arr)
print(arg_dict)
