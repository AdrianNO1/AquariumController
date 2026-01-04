from DSL import (
    ApexParser, InterpreterContext, evaluate, DeviceState, 
    DeviceStateMemory, verify_code
)
from datetime import datetime, timedelta

def run_test(name, code, steps):
    print(f"\n--- TEST: {name} ---")
    print("Code:")
    print(code.strip())
    
    # Verify Syntax
    valid, msg = verify_code(code)
    if not valid:
        print(f"SYNTAX ERROR: {msg}")
        return

    parser = ApexParser()
    instructions = parser.parse_block(code)
    memory = DeviceStateMemory()
    
    # Start time 12:00:00
    base_time = datetime(2023, 1, 1, 12, 0, 0)
    
    for i, step in enumerate(steps):
        time_offset = step.get("offset_sec", 0)
        current_time = base_time + timedelta(seconds=time_offset)
        
        sensors = step.get("sensors", {})
        switches = step.get("switches", {})
        
        context = InterpreterContext(sensors, switches, current_time)
        
        result = evaluate(instructions, context, memory)
        expected = step.get("expect")
        
        status = "PASS" if result.name == expected else f"FAIL (Got {result.name})"
        print(f"Step {i+1} [T+{time_offset}s]: {status}")


# Test 1: Defer ON
# Logic says ON, but Defer prevents it for 10s
code_defer = """
Set OFF
If Switch1 CLOSED Then ON
Defer 00:10 Then ON
"""
steps_defer = [
    {"offset_sec": 0,  "switches": {"Switch1": False}, "expect": "OFF"}, # Init
    {"offset_sec": 1,  "switches": {"Switch1": True},  "expect": "OFF"}, # Triggered, but deferred
    {"offset_sec": 5,  "switches": {"Switch1": True},  "expect": "OFF"}, # Still deferred
    {"offset_sec": 10, "switches": {"Switch1": True},  "expect": "OFF"}, # Exact boundary (check < vs <= logic, implementation uses < so 10.0 might be exact match or next tick. Let's assume next tick usually)
    {"offset_sec": 11, "switches": {"Switch1": True},  "expect": "ON"},  # Passes
    {"offset_sec": 15, "switches": {"Switch1": False}, "expect": "OFF"}, # Off sets immediately (no Defer OFF)
]
run_test("Defer ON", code_defer, steps_defer)


# Test 2: Min Time OFF
# Must stay OFF for 10s after turning OFF.
code_min = """
Set ON
If Switch1 CLOSED Then OFF
Min Time 00:10 Then OFF
"""
# Note: "Min Time ... Then OFF" means "If I am OFF, I must stay OFF for ...".
steps_min = [
    {"offset_sec": 0,  "switches": {"Switch1": False}, "expect": "ON"},  # Start ON
    {"offset_sec": 5,  "switches": {"Switch1": True},  "expect": "OFF"}, # Turn OFF triggers
    {"offset_sec": 10, "switches": {"Switch1": False}, "expect": "OFF"}, # Logic says ON (Set ON), but Min Time OFF holds it OFF
    {"offset_sec": 14, "switches": {"Switch1": False}, "expect": "OFF"}, # Still holding
    {"offset_sec": 16, "switches": {"Switch1": False}, "expect": "ON"},  # 11s > 10s difference -> Release
]
run_test("Min Time OFF", code_min, steps_min)


# Test 3: Complex Sensor Logic (with Set OFF)
code_sensor = """
Set OFF
If Temp < 24.5 Then ON
If Temp > 26.0 Then OFF
"""
steps_sensor = [
    {"offset_sec": 0, "sensors": {"Temp": 25.0}, "expect": "OFF"}, # Middle range, Set OFF applies
    {"offset_sec": 1, "sensors": {"Temp": 24.0}, "expect": "ON"},  # Too cold
    {"offset_sec": 2, "sensors": {"Temp": 25.0}, "expect": "OFF"}, # Hysteresis removed by Set OFF!
]
run_test("Sensor Simple (Set OFF)", code_sensor, steps_sensor)

# Test 4: Hysteresis Logic (NO Set OFF)
code_hyst = """
If Temp < 24.5 Then ON
If Temp > 26.0 Then OFF
"""
steps_hyst = [
    {"offset_sec": 0, "sensors": {"Temp": 25.0}, "expect": "OFF"}, # Init OFF (default memory)
    {"offset_sec": 1, "sensors": {"Temp": 24.0}, "expect": "ON"},  # Too cold -> ON
    {"offset_sec": 2, "sensors": {"Temp": 25.0}, "expect": "ON"},  # Middle range -> Stays ON! (Hysteresis)
    {"offset_sec": 3, "sensors": {"Temp": 26.1}, "expect": "OFF"}, # Too hot -> OFF
]
run_test("Hysteresis (No Set)", code_hyst, steps_hyst)

print("\n--- Syntax Verification Tests ---")
print(verify_code("Set ON")[1])
print(verify_code("Set INVALID")[1])
print(verify_code("If Time 10:00 to 11:00 Then ON")[1]) # Valid
print(verify_code("If Time 10:00 to 11:00 Then INVALID")[1]) # Invalid State
print(verify_code("Defer 00:10 Then ON")[1]) # Valid
print(verify_code("If Sensor > 25 then ON")[1]) # Invalid format
