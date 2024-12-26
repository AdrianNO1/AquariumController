import paho.mqtt.client as mqtt
import time

# MQTT broker settings
BROKER_ADDRESS = "192.168.1.73"
BROKER_PORT = 1883
TOPIC = "aquarium/discover"

# Callback when the client connects to the broker
def on_connect(client, userdata, flags, rc):
    if rc == 0:
        print("Connected to MQTT broker successfully")
        # Subscribe to the topic
        client.subscribe(TOPIC)
    else:
        print(f"Connection failed with code {rc}")

# Callback when a message is received
def on_message(client, userdata, msg):
    print(f"Received message: {msg.payload.decode()} on topic: {msg.topic}")

# Callback when the client disconnects
def on_disconnect(client, userdata, rc):
    print("Disconnected from MQTT broker")

def main():
    # Create MQTT client instance
    client = mqtt.Client()

    # Set callbacks
    client.on_connect = on_connect
    client.on_message = on_message
    client.on_disconnect = on_disconnect

    try:
        # Connect to broker
        print(f"Connecting to broker at {BROKER_ADDRESS}:{BROKER_PORT}")
        client.connect(BROKER_ADDRESS, BROKER_PORT, 60)

        # Start the loop
        client.loop_start()

        # Wait for connection to be established
        time.sleep(2)

        # Publish a test message
        test_message = "announce"
        print(f"Publishing message: {test_message}")
        client.publish(TOPIC, test_message)

        # Keep the script running for a while
        print("Waiting for messages... (Press Ctrl+C to exit)")
        while True:
            time.sleep(1)

    except KeyboardInterrupt:
        print("\nExiting...")
    except Exception as e:
        print(f"Error: {e}")
    finally:
        # Clean up
        client.loop_stop()
        client.disconnect()

if __name__ == "__main__":
    main()
