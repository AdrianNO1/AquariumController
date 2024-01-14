import re

def recursively_get_inner_function(original_text):
    def replace_innermost_functions(text, depth, arg_dict):
        # Regular expression to find innermost function calls
        inner_func_pattern = re.compile(r'([a-zA-Z0-9_.]+)\(([^()]+)\)')
        
        # Find all innermost function calls
        matches = inner_func_pattern.findall(text)
        
        # If there are no more innermost function calls, we are done
        if not matches:
            return text, depth
        
        # Replace each innermost function call with a placeholder
        for match in matches:
            func_name, params = match
            param_list = params.split(',')
            param_placeholders = []
            
            # Replace each parameter with a placeholder, if it's not already one
            for param in param_list:
                param = param.strip()
                if param and not re.match(r'ARG\d+', param):
                    placeholder = f"ARG{depth}"
                    arg_dict[placeholder] = param
                    param_placeholders.append(placeholder)
                    depth += 1
                else:
                    param_placeholders.append(param)
            
            # Replace the function call with a placeholder
            func_call = f"{func_name}({', '.join(param_placeholders)})"
            func_placeholder = f"ARG{depth}"
            arg_dict[func_placeholder] = func_call
            text = text.replace(f"{func_name}({params})", func_placeholder)
            depth += 1
        
        # Recursively process the updated text
        return replace_innermost_functions(text, depth, arg_dict)

    # Example usage
    #original_text = 'ch1.analogWrite(9, ch1.analogWrite2(5, 6))'
    arg_dict = {}
    depth = 1

    # Process the original text
    final_text, final_depth = replace_innermost_functions(original_text, depth, arg_dict)

    # Add the final text to the dictionary with the last placeholder
    # Only if the final text is not already a placeholder
    if not re.match(r'ARG\d+', final_text):
        final_placeholder = f"ARG{final_depth}"
        arg_dict[final_placeholder] = final_text

    return arg_dict, final_depth