"""
diagnose_openaq.py — One-shot diagnostic: fetch 3 raw measurements from a single
sensor and print the exact JSON structure so we can see the real field names.
"""
import os, sys, json, requests
from dotenv import load_dotenv

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
load_dotenv(dotenv_path=os.path.join(_HERE, ".env"))
load_dotenv()

API_KEY = os.getenv("OPENAQ_API_KEY", "")
headers = {"Accept": "application/json", "X-API-Key": API_KEY}

# Delhi station external_id = 50 (from last setup_stations run)
# Step 1: get sensors
r = requests.get("https://api.openaq.org/v3/locations/50/sensors", headers=headers, timeout=15)
r.raise_for_status()
sensors = r.json().get("results", [])
print("=== SENSORS (first 2) ===")
print(json.dumps(sensors[:2], indent=2))

# Find pm25 sensor
pm25_sensor = next(
    (s for s in sensors if (s.get("parameter") or {}).get("name", "").lower() == "pm25"),
    None
)
if not pm25_sensor:
    print("No pm25 sensor found. All sensor names:", [(s.get("parameter") or {}).get("name") for s in sensors])
    sys.exit(1)

print(f"\npm25 sensor id = {pm25_sensor['id']}")

# Step 2: get 3 measurements
r2 = requests.get(
    f"https://api.openaq.org/v3/sensors/{pm25_sensor['id']}/measurements",
    headers=headers,
    params={"limit": 3},
    timeout=15,
)
r2.raise_for_status()
measurements = r2.json().get("results", [])
print("\n=== MEASUREMENTS (first 3 raw) ===")
print(json.dumps(measurements, indent=2))
