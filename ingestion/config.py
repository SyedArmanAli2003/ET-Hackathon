"""
config.py — Central configuration for the air quality ingestion pipeline.

Cities are sourced from OpenAQ's location database. Each entry maps directly
to a row in the `stations` table via `external_id` (the OpenAQ location ID).

Usage:
    from config import TRACKED_CITIES, get_city, ALL_CITY_NAMES

    # Iterate all cities
    for city in TRACKED_CITIES:
        print(city["name"], city["lat"], city["lng"])

    # Look up a single city by name
    delhi = get_city("Delhi")
"""

from __future__ import annotations

# ─────────────────────────────────────────────────────────────────────────────
# Tracked Cities
# lat/lng are approximate geographic centres used to seed the stations table
# and to query OpenAQ's /locations endpoint (radius search).
# external_id is set after the first successful OpenAQ lookup; leave None
# here and the ingest script will populate it on first run.
# ─────────────────────────────────────────────────────────────────────────────

TRACKED_CITIES: list[dict] = [
    # ── North India ───────────────────────────────────────────────────────────
    {
        "name": "Delhi",
        "city": "Delhi",
        "lat": 28.6139,
        "lng": 77.2090,
        "country": "IN",
        "external_id": None,   # populated on first ingest run
    },
    {
        "name": "Jaipur",
        "city": "Jaipur",
        "lat": 26.9124,
        "lng": 75.7873,
        "country": "IN",
        "external_id": None,
    },
    {
        "name": "Lucknow",
        "city": "Lucknow",
        "lat": 26.8467,
        "lng": 80.9462,
        "country": "IN",
        "external_id": None,
    },
    {
        "name": "Kanpur",
        "city": "Kanpur",
        "lat": 26.4499,
        "lng": 80.3319,
        "country": "IN",
        "external_id": None,
    },
    {
        "name": "Chandigarh",
        "city": "Chandigarh",
        "lat": 30.7333,
        "lng": 76.7794,
        "country": "IN",
        "external_id": None,
    },
    {
        "name": "Patna",
        "city": "Patna",
        "lat": 25.5941,
        "lng": 85.1376,
        "country": "IN",
        "external_id": None,
    },

    # ── West India ────────────────────────────────────────────────────────────
    {
        "name": "Mumbai",
        "city": "Mumbai",
        "lat": 19.0760,
        "lng": 72.8777,
        "country": "IN",
        "external_id": None,
    },
    {
        "name": "Ahmedabad",
        "city": "Ahmedabad",
        "lat": 23.0225,
        "lng": 72.5714,
        "country": "IN",
        "external_id": None,
    },
    {
        "name": "Pune",
        "city": "Pune",
        "lat": 18.5204,
        "lng": 73.8567,
        "country": "IN",
        "external_id": None,
    },
    {
        "name": "Surat",
        "city": "Surat",
        "lat": 21.1702,
        "lng": 72.8311,
        "country": "IN",
        "external_id": None,
    },
    {
        "name": "Indore",
        "city": "Indore",
        "lat": 22.7196,
        "lng": 75.8577,
        "country": "IN",
        "external_id": None,
    },
    {
        "name": "Bhopal",
        "city": "Bhopal",
        "lat": 23.2599,
        "lng": 77.4126,
        "country": "IN",
        "external_id": None,
    },

    # ── South India ───────────────────────────────────────────────────────────
    {
        "name": "Bengaluru",
        "city": "Bengaluru",
        "lat": 12.9716,
        "lng": 77.5946,
        "country": "IN",
        "external_id": None,
    },
    {
        "name": "Chennai",
        "city": "Chennai",
        "lat": 13.0827,
        "lng": 80.2707,
        "country": "IN",
        "external_id": None,
    },
    {
        "name": "Hyderabad",
        "city": "Hyderabad",
        "lat": 17.3850,
        "lng": 78.4867,
        "country": "IN",
        "external_id": None,
    },
    {
        "name": "Kochi",
        "city": "Kochi",
        "lat": 9.9312,
        "lng": 76.2673,
        "country": "IN",
        "external_id": None,
    },
    {
        "name": "Visakhapatnam",
        "city": "Visakhapatnam",
        "lat": 17.6868,
        "lng": 83.2185,
        "country": "IN",
        "external_id": None,
    },

    # ── East India ────────────────────────────────────────────────────────────
    {
        "name": "Kolkata",
        "city": "Kolkata",
        "lat": 22.5726,
        "lng": 88.3639,
        "country": "IN",
        "external_id": None,
    },
    {
        "name": "Nagpur",
        "city": "Nagpur",
        "lat": 21.1458,
        "lng": 79.0882,
        "country": "IN",
        "external_id": None,
    },
    {
        "name": "Guwahati",
        "city": "Guwahati",
        "lat": 26.1445,
        "lng": 91.7362,
        "country": "IN",
        "external_id": None,
    },
]

# ─────────────────────────────────────────────────────────────────────────────
# Convenience helpers
# ─────────────────────────────────────────────────────────────────────────────

ALL_CITY_NAMES: list[str] = [c["name"] for c in TRACKED_CITIES]


def get_city(name: str) -> dict:
    """Return the config dict for a city by name (case-insensitive).

    Raises ValueError if the city is not in TRACKED_CITIES.
    """
    name_lower = name.strip().lower()
    for city in TRACKED_CITIES:
        if city["name"].lower() == name_lower:
            return city
    raise ValueError(
        f"City '{name}' not found in TRACKED_CITIES. "
        f"Available cities: {', '.join(ALL_CITY_NAMES)}"
    )


# ─────────────────────────────────────────────────────────────────────────────
# Ingestion settings
# ─────────────────────────────────────────────────────────────────────────────

# How many hours of history to fetch on a backfill run
BACKFILL_HOURS: int = 24

# OpenAQ radius search (km) around each city centre
OPENAQ_RADIUS_KM: int = 25

# Data source label written to readings.data_source
DATA_SOURCE_LABEL: str = "openaq-v3"
