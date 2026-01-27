from DSL import (
    ApexParser, InterpreterContext, evaluate, DeviceState, 
    DeviceStateMemory, verify_code, build_interpreter_context
)
from datetime import datetime, timedelta
import tempfile
import shutil
import os
import json
import logging

# Configure logging for test (to see warnings)
logging.basicConfig(level=logging.INFO)

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

def test_context_loading_and_expiry():
    print("\n--- TEST: Context Loading & Expiry ---")
    
    # 1. Create Temp Directory
    temp_dir = tempfile.mkdtemp()
    print(f"Created temp dir: {temp_dir}")
    
    try:
        # 2. Create espstatuses.json
        # "TempFresh": Updated recently
        # "TempStale": Updated > 5 mins ago
        
        now = datetime.now()
        fresh_ts = now.isoformat()
        stale_ts = (now - timedelta(minutes=10)).isoformat()
        
        data = {
            "sensors": [
                {"name": "TempFresh", "value": 25.0, "updated_at": fresh_ts},
                {"name": "TempStale", "value": 25.0, "updated_at": stale_ts}
            ],
            "switches": {}
        }
        
        with open(os.path.join(temp_dir, "espstatuses.json"), "w") as f:
            json.dump(data, f)
            
        # 3. Build Context
        context = build_interpreter_context(temp_dir)
        print("Context built.")
        
        # 4. Test Fresh Sensor (Should be Normal)
        code_fresh = """
        Set OFF
        If TempFresh > 24.0 Then ON
        Fallback OFF
        """
        parser = ApexParser()
        instructions = parser.parse_block(code_fresh)
        memory = DeviceStateMemory()
        
        res = evaluate(instructions, context, memory)
        print(f"Fresh Sensor Test: {'PASS' if res == DeviceState.ON else 'FAIL'} (Expected ON, got {res})")

        # 5. Test Stale Sensor (Should use Fallback)
        code_stale = """
        Set OFF
        If TempStale > 24.0 Then ON
        Fallback OFF
        """
        instructions = parser.parse_block(code_stale)
        memory = DeviceStateMemory()
        
        # Note: We rely on the context's current_time being 'now' (set in build_interpreter_context)
        # which matches the timestamps we generated. 
        # However, evaluate uses context.current_time_dt vs the sensor timestamp.
        # context.current_time_dt is set to datetime.now() in build_interpreter_context.
        
        res = evaluate(instructions, context, memory)
        print(f"Stale Sensor Test: {'PASS' if res == DeviceState.OFF else 'FAIL'} (Expected OFF via Fallback, got {res})")

        # 6. Test Stale Sensor with allow_expired=True (Should be Normal ON)
        res = evaluate(instructions, context, memory, allow_expired=True)
        print(f"Stale Sensor (Allowed) Test: {'PASS' if res == DeviceState.ON else 'FAIL'} (Expected ON, got {res})")

    finally:
        shutil.rmtree(temp_dir)
        print(f"Removed temp dir: {temp_dir}")

# EXECUTE NEW TEST
test_context_loading_and_expiry()

# EXECUTE OLD TESTS
# Test 1: Defer ON
code_defer = """
Set OFF
If Switch1 CLOSED Then ON
Defer 00:10 Then ON
"""
steps_defer = [
    {"offset_sec": 0,  "switches": {"Switch1": False}, "expect": "OFF"},
    {"offset_sec": 1,  "switches": {"Switch1": True},  "expect": "OFF"},
    {"offset_sec": 5,  "switches": {"Switch1": True},  "expect": "OFF"},
    {"offset_sec": 10, "switches": {"Switch1": True},  "expect": "OFF"},
    {"offset_sec": 11, "switches": {"Switch1": True},  "expect": "ON"},
    {"offset_sec": 15, "switches": {"Switch1": False}, "expect": "OFF"},
]
run_test("Defer ON", code_defer, steps_defer)

# Test 2: Min Time OFF
code_min = """
Set ON
If Switch1 CLOSED Then OFF
Min Time 00:10 Then OFF
"""
steps_min = [
    {"offset_sec": 0,  "switches": {"Switch1": False}, "expect": "ON"},
    {"offset_sec": 5,  "switches": {"Switch1": True},  "expect": "OFF"},
    {"offset_sec": 10, "switches": {"Switch1": False}, "expect": "OFF"},
    {"offset_sec": 14, "switches": {"Switch1": False}, "expect": "OFF"},
    {"offset_sec": 16, "switches": {"Switch1": False}, "expect": "ON"},
]
run_test("Min Time OFF", code_min, steps_min)

# Test 3: Complex Sensor Logic (with Set OFF)
code_sensor = """
Set OFF
If Temp < 24.5 Then ON
If Temp > 26.0 Then OFF
"""
steps_sensor = [
    {"offset_sec": 0, "sensors": {"Temp": 25.0}, "expect": "OFF"},
    {"offset_sec": 1, "sensors": {"Temp": 24.0}, "expect": "ON"},
    {"offset_sec": 2, "sensors": {"Temp": 25.0}, "expect": "OFF"},
]
run_test("Sensor Simple (Set OFF)", code_sensor, steps_sensor)

# Test 4: Hysteresis Logic (NO Set OFF)
code_hyst = """
If Temp < 24.5 Then ON
If Temp > 26.0 Then OFF
"""
steps_hyst = [
    {"offset_sec": 0, "sensors": {"Temp": 25.0}, "expect": "OFF"},
    {"offset_sec": 1, "sensors": {"Temp": 24.0}, "expect": "ON"},
    {"offset_sec": 2, "sensors": {"Temp": 25.0}, "expect": "ON"},
    {"offset_sec": 3, "sensors": {"Temp": 26.1}, "expect": "OFF"},
]
run_test("Hysteresis (No Set)", code_hyst, steps_hyst)

print("\n--- Syntax Verification Tests ---")
print(verify_code("Set ON")[1])
print(verify_code("Set INVALID")[1])
print(verify_code("If Time 10:00 to 11:00 Then ON")[1])
print(verify_code("If Time 10:00 to 11:00 Then INVALID")[1])
print(verify_code("Defer 00:10 Then ON")[1])
print(verify_code("If Sensor > 25 then ON")[1])


