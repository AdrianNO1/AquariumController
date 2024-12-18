import json
import secrets
from werkzeug.security import generate_password_hash

def create_config():
    # Generate a secure random secret key
    secret_key = secrets.token_hex(32)
    
    # Get password from user input
    password = input("Enter the admin password: ")
    
    # Generate password hash
    password_hash = generate_password_hash(password, method='pbkdf2:sha256')
    
    # Create config dictionary
    config = {
        "secret_key": secret_key,
        "password_hash": password_hash
    }
    
    # Save to file
    with open('secret.json', 'w') as f:
        json.dump(config, f, indent=4)
    
    print("Config file created successfully!")

if __name__ == "__main__":
    create_config()
