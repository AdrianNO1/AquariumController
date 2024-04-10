import serial, time, threading, multiprocessing, os, json, logging, math, queue, re, sys, datetime

from get_connected_arduinos import get_arduinos

serial_devices = []


def initialize(serial_device):
    print("initializing", serial_device)
    try:
        serial_device["serial"].write(bytes("whodis\n", encoding="utf-8"))
        time.sleep(0.05)
        name = serial_device["serial"].readline().decode().strip().strip(";")
        if not name:
            print("serial_device did not recieve a name. Possible timeout")
            name = "Not responding"
            serial_device["status"] = "No response"
            serial_device["error"] = "Error: Device is not responding"
        else:
            serial_device["status"] = "Responded"
            serial_device["error"] = ""
        
        serial_device["lastused"] = int(time.time())
        serial_device["name"] = name
    except serial.serialutil.SerialException:
        print("Device disconnected when initializing")
        return
    serial_devices.append(serial_device)
    print(f"USB device initialized: {serial_device['name']}")

def start_initialization_timer(device):
    threading.Timer(2, initialize, args=({"device": device, "serial": serial.Serial(device, 9600, timeout=1), "name": None},)).start()


start_initialization_timer("/dev/ttyACM0")
import time, datetime
time.sleep(4)
device = serial_devices[0]

last_returned = None
command = f"p\n"
while True:
    old = last_returned
    try:
        device["serial"].write(bytes(command, encoding="utf-8"))
        time.sleep(0.05)
        last_returned = device["serial"].readline().decode(encoding="utf-8").strip().strip(";") + "\n"
        time.sleep(0.05)

    except serial.serialutil.SerialException:
        last_returned = "disconnected"
    if old != last_returned:
        print("new stuff:", last_returned)
        print(datetime.datetime.now().strftime("%d/%m/%Y, %H:%M:%S"))
    time.sleep(5)