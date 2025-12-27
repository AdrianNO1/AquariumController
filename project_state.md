# Aquarium Controller Project State

## Overview
You are building a comprehensive **Aquarium Controller** system designed to manage lights, pumps, and other equipment across multiple aquariums (Main, Main 2, Kjeller, etc.). The system uses a **Flask** web server for the dashboard and communicates with **ESP32** devices via **MQTT** (and potentially USB/Serial) to control hardware pins.

## Project Structure
*   **`app.py`**: The main web server. It handles the dashboard UI, API routes for saving/loading data, and communicates with the background manager thread.
*   **`manager.py`**: The "brain" running in the background. It manages the connected devices, handles updates, and executes commands.
*   **`ESP32Manager.py`**: Handles specific communication with ESP32 devices over MQTT, including schedule updates and command batching.
*   **`custom_syntax.py`**: The parser for your Domain Specific Language (DSL). This is where the "Auto" logic lives.
*   **`templates/index.html`**: The main dashboard. It visualizes the state of switches and sensors.

## Your Specific Questions

### 1. What is the "Dashboard"?
The dashboard (`index.html`) is the control center. It displays "Boxes" representing different zones (e.g., Main, Biljard). Inside these boxes are **Switches**.

### 2. What are the "Switches"?
Switches represent physical devices (lights, pumps, heaters) connected to pins on your ESPs.
*   **Status Indicators**: They show if a device is currently running.
*   **Control Modes**: Each switch has three modes:
    *   **OFF**: Manually forces the device off.
    *   **ON**: Manually forces the device on.
    *   **AUTO**: The device's state is determined by your **DSL Code**.
*   **Alarms**: You can configure switches to trigger an alarm if they stay Open or Closed for too long (e.g., a float switch indicating a high water level).

### 3. What are the "Question Marks"?
The question marks you see in the UI (specifically in the configuration popups) are **Help Tooltips**. Hovering over them reveals a list of available functions you can use in your code, such as:
*   `turnOn()`
*   `turnOff()`
*   `readTemp("sensor")`
*   `ifOpen("switch")`

### 4. What is the "DSL Code Thing"?
This is the custom logic engine you started building in `custom_syntax.py`. It allows you to write simple scripts to automate your devices.

**Current Capabilities:**
*   **Time Ranges**: `if Time "08:00" to "20:00": ...`
*   **Basic Logic**: `if`, `elif`, `else`.
*   **Function Calls**: `Arduino1.isOn()`, `analogWrite()`.

**What's Missing (The "Apex Fusion" Goal):**
You noted that you want to use variables like **temperature**, **time**, and **sensor readings** directly in your code.
*   *Current State*: The code has a TODO comment: `# TODO add variable assignment and reading from pins. Can be managed with a dictionary.`
*   *Goal*: You need to extend `custom_syntax.py` to inject these variables (e.g., `temp`, `ph`) into the execution context so you can write logic like:
    ```python
    if temp > 28.0:
        turnOff()
    ```

## Next Steps
To achieve the flexibility you want (migrating away from the limited graph control), you need to:
1.  **Update `custom_syntax.py`**: Implement the logic to pass sensor data (temperature, pH, etc.) into the `parse_code` function.
2.  **Expose Variables**: Make these variables accessible inside your DSL scripts.
3.  **Frontend**: Ensure the "Switch Config" popup allows you to write and save this enhanced code.
