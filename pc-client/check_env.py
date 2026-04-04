import os
from dotenv import load_dotenv
from pathlib import Path

# Look for .env in the same folder as this script
env_path = Path('.') / '.env'
print(f"Checking for .env at: {env_path.resolve()}")

if load_dotenv(env_path):
    val = os.environ.get('PC_SECRET')
    if val:
        print(f"SUCCESS: Found PC_SECRET")
        print(f"Length: {len(val)}")
    else:
        print("FAILURE: .env loaded, but PC_SECRET is empty or missing.")
else:
    print("FAILURE: Could not load .env file at all.")