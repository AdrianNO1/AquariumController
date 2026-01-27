import logging
from datetime import datetime, timedelta, time as time_obj
import os
from utils import read_json_file
from enum import Enum, auto
from typing import List, Dict, Optional, Tuple, Any

logger = logging.getLogger(__name__)

# ... (Previous Enums and Classes) ...

class CommandType(Enum):
    FALLBACK = auto()
    SET = auto()
    IF = auto()
    DEFER = auto()
    MIN_TIME = auto()

class DeviceState(Enum):
    ON = auto()
    OFF = auto()
    # Profiles typically treated as ON or special string, handling simple ON/OFF for now
    
    def __str__(self):
        return self.name

class Operator(Enum):
    GREATER_THAN = ">"
    LESS_THAN = "<"
    EQUALS = "="
    
    @staticmethod
    def from_str(s):
        if s == ">": return Operator.GREATER_THAN
        if s == "<": return Operator.LESS_THAN
        if s == "=" or s == "==": return Operator.EQUALS
        return None

class Instruction:
    def __init__(self, cmd_type: CommandType):
        self.cmd_type = cmd_type

class SetInstruction(Instruction):
    def __init__(self, state: DeviceState):
        super().__init__(CommandType.SET)
        self.state = state
        
class FallbackInstruction(Instruction):
    def __init__(self, state: DeviceState):
        super().__init__(CommandType.FALLBACK)
        self.state = state

class IfTimeInstruction(Instruction):
    def __init__(self, start_time: time_obj, end_time: time_obj, state: DeviceState):
        super().__init__(CommandType.IF)
        self.condition_type = "TIME"
        self.start_time = start_time
        self.end_time = end_time
        self.state = state

class IfSensorInstruction(Instruction):
    def __init__(self, sensor_name: str, operator: Operator, value: float, state: DeviceState):
        super().__init__(CommandType.IF)
        self.condition_type = "SENSOR"
        self.sensor_name = sensor_name
        self.operator = operator
        self.value = value
        self.state = state

class IfSwitchInstruction(Instruction):
    def __init__(self, switch_name: str, target_state: str, state: DeviceState):
        super().__init__(CommandType.IF)
        self.condition_type = "SWITCH"
        self.switch_name = switch_name
        self.target_state = target_state # OPEN or CLOSED
        self.state = state

class DeferInstruction(Instruction):
    def __init__(self, state: DeviceState, duration_seconds: int):
        super().__init__(CommandType.DEFER)
        self.state = state # The state being deferred (e.g. Defer 1:00 Then ON means delay turning ON)
        self.duration = duration_seconds

class MinTimeInstruction(Instruction):
    def __init__(self, state: DeviceState, duration_seconds: int):
        super().__init__(CommandType.MIN_TIME)
        self.state = state # "Min Time ... Then OFF" means "Must stay OFF for at least..."
        self.duration = duration_seconds

class DeviceStateMemory:
    def __init__(self):
        self.current_state = DeviceState.OFF
        self.last_transition_time = 0 # Unix timestamp (0 means ancient history)
        
        # For Defer
        self.pending_state: Optional[DeviceState] = None
        self.pending_start_time = 0

class ApexParser:
    def __init__(self):
        pass

    def parse_state(self, token: str) -> DeviceState:
        token = token.upper()
        if token == "ON": return DeviceState.ON
        if token == "OFF": return DeviceState.OFF
        raise ValueError(f"Invalid state '{token}'. Expected ON or OFF.")

    def parse_time(self, token: str) -> time_obj:
        try:
            return datetime.strptime(token, "%H:%M").time()
        except ValueError:
            raise ValueError(f"Invalid time '{token}'. Expected format HH:MM.")

    def parse_duration(self, token: str) -> int:
        parts = token.split(':')
        if len(parts) != 2:
            raise ValueError(f"Invalid duration '{token}'. Expected format MM:SS.")
        try:
            m = int(parts[0])
            s = int(parts[1])
            return m * 60 + s
        except ValueError:
            raise ValueError(f"Duration values must be numbers, got '{token}'.")

    def parse_line(self, line: str, line_num: int) -> Optional[Instruction]:
        line = line.strip()
        if not line or line.startswith("#") or line.startswith("//"):
            return None

        tokens = line.split()
        if not tokens:
            return None

        cmd = tokens[0].upper()

        try:
            if cmd == "FALLBACK":
                if len(tokens) < 2: raise ValueError("Missing state for FALLBACK command.")
                return FallbackInstruction(self.parse_state(tokens[1]))
            
            elif cmd == "SET":
                if len(tokens) < 2: raise ValueError("Missing state for SET command.")
                return SetInstruction(self.parse_state(tokens[1]))

            elif cmd == "IF":
                if len(tokens) < 2: raise ValueError("Incomplete IF command.")
                
                # If Time 08:00 to 09:00 Then ON
                if tokens[1].upper() == "TIME":
                    if len(tokens) < 7: raise ValueError("Incomplete 'If Time' command. Format: If Time HH:MM to HH:MM Then ON/OFF")
                    start = self.parse_time(tokens[2])
                    if tokens[3].upper() != "TO": raise ValueError(f"Expected 'to' in time range, got '{tokens[3]}'.")
                    end = self.parse_time(tokens[4])
                    if tokens[5].upper() != "THEN": raise ValueError(f"Expected 'Then' after time range, got '{tokens[5]}'.")
                    state = self.parse_state(tokens[6])
                    return IfTimeInstruction(start, end, state)
                
                # Check for Switch/Sensor
                cond_token = tokens[2].upper()
                
                # Operator means Sensor
                operator = Operator.from_str(cond_token)
                if operator: 
                    if len(tokens) < 6: raise ValueError("Incomplete Sensor condition. Format: If Sensor > Value Then ON/OFF")
                    sensor_name = tokens[1]
                    try:
                        value = float(tokens[3])
                    except ValueError:
                        raise ValueError(f"Invalid sensor value '{tokens[3]}'. Expected number.")
                    
                    if tokens[4].upper() != "THEN": raise ValueError(f"Expected 'Then', got '{tokens[4]}'.")
                    state = self.parse_state(tokens[5])
                    return IfSensorInstruction(sensor_name, operator, value, state)
                
                # Switch logic (OPEN/CLOSED)
                if cond_token in ["OPEN", "CLOSED"]:
                     if len(tokens) < 5: raise ValueError("Incomplete Switch condition. Format: If Switch OPEN/CLOSED Then ON/OFF")
                     switch_name = tokens[1]
                     switch_state = cond_token
                     if tokens[3].upper() != "THEN": raise ValueError(f"Expected 'Then', got '{tokens[3]}'.")
                     state = self.parse_state(tokens[4])
                     return IfSwitchInstruction(switch_name, switch_state, state)

                raise ValueError(f"Unknown condition type or format in: {line}")
            
            elif cmd == "DEFER":
                if len(tokens) < 4: raise ValueError("Incomplete DEFER command. Format: Defer MM:SS Then ON/OFF")
                duration = self.parse_duration(tokens[1])
                if tokens[2].upper() != "THEN": raise ValueError(f"Expected 'Then', got '{tokens[2]}'.")
                state = self.parse_state(tokens[3])
                return DeferInstruction(state, duration)

            elif cmd == "MIN":
                if len(tokens) < 5: raise ValueError("Incomplete MIN TIME command. Format: Min Time MM:SS Then ON/OFF")
                if tokens[1].upper() == "TIME":
                    duration = self.parse_duration(tokens[2])
                    if tokens[3].upper() != "THEN": raise ValueError(f"Expected 'Then', got '{tokens[3]}'.")
                    state = self.parse_state(tokens[4])
                    return MinTimeInstruction(state, duration)
                else:
                    raise ValueError(f"Expected 'Time' after Min, got '{tokens[1]}'.")
            
            else:
                raise ValueError(f"Unknown command '{cmd}'. Supported: Set, If, Defer, Min Time, Fallback.")

        except IndexError:
            raise ValueError(f"Unexpected end of line.")
        except ValueError as e:
            raise ValueError(f"Line {line_num}: {str(e)}")


    def parse_block(self, code: str) -> List[Instruction]:
        instructions = []
        for i, line in enumerate(code.split('\n')):
            inst = self.parse_line(line, i + 1)
            if inst:
                instructions.append(inst)
        return instructions

def verify_code(code: str, context: 'InterpreterContext' = None) -> Tuple[bool, Optional[str]]:
    """
    Verify DSL code for syntax errors and optionally validate referenced resources.
    If context is provided, also checks that referenced sensors/switches exist.
    """
    parser = ApexParser()
    try:
        instructions = parser.parse_block(code)
        
        # If context provided, validate referenced resources exist
        if context is not None:
            missing = []
            for inst in instructions:
                if isinstance(inst, IfSensorInstruction):
                    if inst.sensor_name not in context.sensors:
                        missing.append(f"Sensor '{inst.sensor_name}' not found")
                elif isinstance(inst, IfSwitchInstruction):
                    if inst.switch_name not in context.switches:
                        missing.append(f"Switch '{inst.switch_name}' not found")
            
            if missing:
                return False, "Missing resources: " + "; ".join(missing)
        
        return True, None
    except ValueError as e:
        return False, str(e)
    except Exception as e:
        return False, f"Unexpected error: {str(e)}"

class InterpreterContext:
    def __init__(self, sensors: Dict[str, float], switches: Dict[str, bool], current_time: datetime, sensor_timestamps: Dict[str, datetime] = None):
        self.sensors = sensors
        self.sensor_timestamps = sensor_timestamps or {}
        self.switches = switches 
        # current_time must be datetime for timestamp calc, though logic uses time portion
        self.current_time_dt = current_time 
        self.current_time_obj = current_time.time()

def evaluate(instructions: List[Instruction], context: InterpreterContext, memory: DeviceStateMemory, allow_expired: bool = False, errors: List[str] = None) -> DeviceState:
    """
    Evaluate DSL instructions and return the resulting device state.
    
    Args:
        instructions: Parsed DSL instructions
        context: Sensor/switch context
        memory: Device state memory for Defer/MinTime
        allow_expired: If True, don't check sensor expiry
        errors: Optional list to collect error messages (for frontend display)
    """
    # 1. Determine "Logical State" (Proposed State)
    # Default to current state (Supports Hysteresis / No-Change behavior)
    raw_state = memory.current_state 
    
    # Logic pass
    for inst in instructions:
        if isinstance(inst, FallbackInstruction):
            # Fallback is ignored in normal logic evaluation (handled by manager if comms fail)
            continue 

        if isinstance(inst, SetInstruction):
            raw_state = inst.state

        elif isinstance(inst, IfTimeInstruction):
            is_active = False
            start = inst.start_time
            end = inst.end_time
            now = context.current_time_obj
            
            if start <= end:
                is_active = start <= now <= end
            else:
                # Wraps midnight
                is_active = now >= start or now <= end
            
            if is_active:
                raw_state = inst.state
        
        elif isinstance(inst, IfSensorInstruction):
            val = context.sensors.get(inst.sensor_name)
            if val is None:
                # Sensor not found - log error, collect for frontend, and use fallback
                error_msg = f"Sensor '{inst.sensor_name}' not found"
                logger.error(f"ERROR: {error_msg}!")
                print(f"ERROR: {error_msg}!")
                if errors is not None:
                    errors.append(error_msg)
                fallback = next((i for i in instructions if isinstance(i, FallbackInstruction)), None)
                if fallback:
                    logger.warning(f"Using fallback state {fallback.state} due to missing sensor.")
                    return fallback.state
                # No fallback, skip this condition
                continue
            
            # Check expiry
            if not allow_expired:
                ts = context.sensor_timestamps.get(inst.sensor_name)
                if ts:
                    # calculate age
                    age = (context.current_time_dt - ts).total_seconds()
                    if age > 300: # 5 minutes
                         error_msg = f"Sensor '{inst.sensor_name}' is stale ({age:.0f}s old)"
                         logger.error(f"ERROR: {error_msg}.")
                         print(f"ERROR: {error_msg}.")
                         if errors is not None:
                             errors.append(error_msg)
                         # Check fallback
                         fallback = next((i for i in instructions if isinstance(i, FallbackInstruction)), None)
                         if fallback:
                             logger.warning(f"Using fallback state {fallback.state} due to stale sensor.")
                             return fallback.state
            
            condition_met = False
            if inst.operator == Operator.GREATER_THAN:
                 condition_met = val > inst.value
            elif inst.operator == Operator.LESS_THAN:
                 condition_met = val < inst.value
            elif inst.operator == Operator.EQUALS:
                 condition_met = abs(val - inst.value) < 0.001
            
            if condition_met:
                raw_state = inst.state
        
        elif isinstance(inst, IfSwitchInstruction):
            # Check if switch exists
            if inst.switch_name not in context.switches:
                # Switch not found - log error, collect for frontend, and use fallback
                error_msg = f"Switch '{inst.switch_name}' not found"
                logger.error(f"ERROR: {error_msg}!")
                print(f"ERROR: {error_msg}!")
                if errors is not None:
                    errors.append(error_msg)
                fallback = next((i for i in instructions if isinstance(i, FallbackInstruction)), None)
                if fallback:
                    logger.warning(f"Using fallback state {fallback.state} due to missing switch.")
                    return fallback.state
                # No fallback, skip this condition
                continue
            
            # Switch exists, evaluate condition
            is_closed = context.switches[inst.switch_name]
            target_is_closed = (inst.target_state == "CLOSED")
            
            if is_closed == target_is_closed:
                raw_state = inst.state

    # 2. Defer Processing
    # Check if we are trying to transition
    if raw_state != memory.current_state:
        
        # Check if there is a Defer for this SPECIFIC transition
        defer_duration = 0
        for inst in instructions:
            if isinstance(inst, DeferInstruction) and inst.state == raw_state:
                # We want to switch TO 'raw_state', and there is a Defer for 'raw_state'
                # e.g. raw is ON, Defer ... Then ON
                defer_duration = max(defer_duration, inst.duration)
        
        if defer_duration > 0:
            current_ts = context.current_time_dt.timestamp()
            
            # If we were not already pending for this state, start pending
            if memory.pending_state != raw_state:
                memory.pending_state = raw_state
                memory.pending_start_time = current_ts
                # We do NOT switch yet
                return memory.current_state
            else:
                # We were already pending. Check time.
                elapsed = current_ts - memory.pending_start_time
                if elapsed < defer_duration:
                    # Still waiting
                    return memory.current_state
                else:
                    # Timer done! Allow transition (fall through to Min Time)
                    pass
        else:
            # No defer, immediate transition allowed (pending Min Time)
            pass
    else:
        # We are not trying to change state. Clear pending.
        memory.pending_state = None
        memory.pending_start_time = 0

    # 3. Min Time Processing
    # We are about to be in 'raw_state'. 
    # If this represents a CHANGE from memory.current_state, we must check MIN TIME of the OLD state.
    # e.g. We are ON, we want to go OFF. "Min Time ... Then ON" means "Must stay ON for X"
    
    if raw_state != memory.current_state:
        min_time_duration = 0
        
        # Look for Min Time constraint on the CURRENT (old) state
        for inst in instructions:
            if isinstance(inst, MinTimeInstruction) and inst.state == memory.current_state:
                min_time_duration = max(min_time_duration, inst.duration)
        
        if min_time_duration > 0:
            current_ts = context.current_time_dt.timestamp()
            time_in_state = current_ts - memory.last_transition_time
            
            if time_in_state < min_time_duration:
                # Cannot change yet. Force hold old state.
                return memory.current_state

    # 4. Final State Commit
    if raw_state != memory.current_state:
        memory.current_state = raw_state
        memory.last_transition_time = context.current_time_dt.timestamp()
        memory.pending_state = None # Reset pending if we successfully switched
        

    return memory.current_state


def build_interpreter_context(data_dir: str) -> InterpreterContext:
    """
    Builds an InterpreterContext from the JSON files in the specified data directory.
    Uses 'espstatuses.json' for sensor values and switch states.
    """
    esp_status_path = os.path.join(data_dir, "espstatuses.json")
    
    try:
        data = read_json_file(esp_status_path)
    except FileNotFoundError:
        raise FileNotFoundError(f"Missing required data file: {esp_status_path}")
    except Exception as e:
        raise ValueError(f"Error reading context data: {str(e)}")

    sensors = {}
    sensor_timestamps = {}
    switches = {}

    # Parse Sensors
    if "sensors" in data:
        sensor_data = data["sensors"]
        # Handle list format (e.g. [{"name": "Temp", "value": 25.0}, ...])
        if isinstance(sensor_data, list):
            for s in sensor_data:
                if "name" in s and "value" in s:
                    try:
                        sensors[s["name"]] = float(s["value"])
                        if "updated_at" in s:
                            # 2025-12-27T14:04:38.010451
                            try:
                                dt = datetime.fromisoformat(s["updated_at"])
                                sensor_timestamps[s["name"]] = dt
                            except ValueError:
                                logger.warning(f"Invalid timestamp format for sensor '{s['name']}': {s['updated_at']}")
                    except (ValueError, TypeError) as e:
                        logger.warning(f"Failed to parse sensor '{s.get('name', 'unknown')}': {e}")
                else:
                    logger.warning(f"Skipping malformed sensor entry (missing name or value): {s}")
        # Handle dict format if present
        elif isinstance(sensor_data, dict):
            for name, info in sensor_data.items():
                if isinstance(info, dict) and "value" in info:
                    try:
                        sensors[name] = float(info["value"])
                        if "updated_at" in info:
                            try:
                                dt = datetime.fromisoformat(info["updated_at"])
                                sensor_timestamps[name] = dt
                            except ValueError:
                                logger.warning(f"Invalid timestamp format for sensor '{name}': {info['updated_at']}")
                    except (ValueError, TypeError) as e:
                        logger.warning(f"Failed to parse sensor '{name}': {e}")
                else:
                    logger.warning(f"Skipping malformed sensor entry '{name}': missing 'value' field")

    # Parse Switches
    if "switches" in data:
        switch_data = data["switches"]
        if isinstance(switch_data, dict):
            for name, info in switch_data.items():
                if isinstance(info, dict) and "is_open" in info:
                    # DSL Logic: True=Closed, False=Open
                    # Json Logic: is_open=True -> Open
                    # Json Logic: is_open=False -> Closed
                    # Therefore: is_closed (DSL) = not is_open (JSON)
                    switches[name] = not info["is_open"]
                else:
                    logger.warning(f"Skipping malformed switch entry '{name}': missing 'is_open' field")
    
    current_time = datetime.now()
    return InterpreterContext(sensors, switches, current_time, sensor_timestamps)

