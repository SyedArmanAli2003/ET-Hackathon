"""
explore_data.py — Load readings + weather from Supabase into pandas DataFrames
and produce a summary report + AQI-over-time plot.

Outputs
-------
  Console:  date range, row counts per station, null audit, AQI stats per station
  File:     ingestion/aqi_over_time.png  (saved; not shown interactively)

Usage
-----
    python ingestion/explore_data.py

    # Save plot to a custom path
    python ingestion/explore_data.py --output reports/aqi_plot.png

    # Limit the number of stations shown on the plot (default: 3)
    python ingestion/explore_data.py --top-n 5
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

# Force UTF-8 output on Windows so print() doesn't hit cp1252 limits
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import matplotlib
matplotlib.use("Agg")          # non-interactive backend — no display needed
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import pandas as pd
from dotenv import load_dotenv
from sqlalchemy import text

# ── path setup ────────────────────────────────────────────────────────────────
_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))

load_dotenv(dotenv_path=_HERE / ".env")
load_dotenv()

from db import get_engine  # noqa: E402


# ── DB loaders ────────────────────────────────────────────────────────────────

def load_readings(engine) -> pd.DataFrame:
    """
    Load the full `readings` table joined to `stations.city` into a DataFrame.
    Columns: station_id, city, timestamp (UTC-aware), aqi, pm25, data_source
    """
    query = """
        SELECT
            r.station_id,
            s.city,
            r.timestamp AT TIME ZONE 'UTC'   AS timestamp,
            r.aqi::float                      AS aqi,
            r.pm25::float                     AS pm25,
            r.data_source
        FROM readings r
        JOIN stations s ON s.id = r.station_id
        ORDER BY s.city, r.timestamp
    """
    with engine.connect() as conn:
        df = pd.read_sql(text(query), conn)

    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    return df


def load_weather(engine) -> pd.DataFrame:
    """
    Load the full `weather` table joined to `stations.city` into a DataFrame.
    Columns: station_id, city, timestamp (UTC-aware), temperature, wind_speed, humidity
    """
    query = """
        SELECT
            w.station_id,
            s.city,
            w.timestamp AT TIME ZONE 'UTC'   AS timestamp,
            w.temperature::float              AS temperature,
            w.wind_speed::float               AS wind_speed,
            w.humidity::float                 AS humidity
        FROM weather w
        JOIN stations s ON s.id = w.station_id
        ORDER BY s.city, w.timestamp
    """
    with engine.connect() as conn:
        df = pd.read_sql(text(query), conn)

    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    return df


# ── Analysis helpers ──────────────────────────────────────────────────────────

_DIVIDER = "-" * 70


def print_section(title: str) -> None:
    print(f"\n{_DIVIDER}")
    print(f"  {title}")
    print(_DIVIDER)


def summarise_readings(df: pd.DataFrame) -> None:
    """Print a full console report for the readings DataFrame."""

    print_section("READINGS — Overview")
    print(f"  Total rows       : {len(df):,}")
    print(f"  Distinct stations: {df['city'].nunique()}")
    if not df.empty:
        print(f"  Date range (UTC) : {df['timestamp'].min()}  →  {df['timestamp'].max()}")
    else:
        print("  (no data)")
        return

    print_section("READINGS — Row count per station")
    counts = df.groupby("city").size().rename("row_count").sort_values(ascending=False)
    print(counts.to_string())

    print_section("READINGS — Null audit")
    nulls = df[["aqi", "pm25", "timestamp"]].isnull().sum()
    if nulls.sum() == 0:
        print("  No nulls found ✅")
    else:
        print(nulls[nulls > 0].to_string())

    print_section("READINGS — AQI stats per station (min / mean / max)")
    stats = (
        df.groupby("city")["aqi"]
        .agg(min="min", mean="mean", max="max")
        .round(2)
        .sort_values("mean", ascending=False)
    )
    print(stats.to_string())


def summarise_weather(df: pd.DataFrame) -> None:
    """Print a full console report for the weather DataFrame."""

    print_section("WEATHER — Overview")
    print(f"  Total rows       : {len(df):,}")
    print(f"  Distinct stations: {df['city'].nunique()}")
    if not df.empty:
        print(f"  Date range (UTC) : {df['timestamp'].min()}  →  {df['timestamp'].max()}")
    else:
        print("  (no data)")
        return

    print_section("WEATHER — Row count per station")
    counts = df.groupby("city").size().rename("row_count").sort_values(ascending=False)
    print(counts.to_string())

    print_section("WEATHER — Null audit")
    nulls = df[["temperature", "wind_speed", "humidity"]].isnull().sum()
    if nulls.sum() == 0:
        print("  No nulls found ✅")
    else:
        print(nulls[nulls > 0].to_string())

    print_section("WEATHER — Temperature stats per station (°C)")
    stats = (
        df.groupby("city")["temperature"]
        .agg(min="min", mean="mean", max="max")
        .round(2)
        .sort_values("mean", ascending=False)
    )
    print(stats.to_string())


# ── Plotting ──────────────────────────────────────────────────────────────────

# Colour palette — visually distinct for up to 5 stations
_PALETTE = ["#E63946", "#2A9D8F", "#E9C46A", "#457B9D", "#F4A261"]


def pick_stations(df: pd.DataFrame, top_n: int) -> list[str]:
    """
    Pick the top_n stations by row count (most data = most interesting plot).
    Falls back to all stations if fewer than top_n are available.
    """
    by_count = df.groupby("city").size().sort_values(ascending=False)
    return list(by_count.head(top_n).index)


def plot_aqi(df: pd.DataFrame, stations: list[str], output_path: Path) -> None:
    """
    Line chart: AQI over time for each station in `stations`.
    X-axis: UTC timestamp.  Y-axis: AQI (0–500 US EPA scale).
    Saved to `output_path` as a PNG.
    """
    fig, ax = plt.subplots(figsize=(14, 6))
    fig.patch.set_facecolor("#1A1A2E")      # dark background
    ax.set_facecolor("#16213E")

    for i, city in enumerate(stations):
        subset = df[df["city"] == city].sort_values("timestamp")
        color  = _PALETTE[i % len(_PALETTE)]
        ax.plot(
            subset["timestamp"],
            subset["aqi"],
            label=city,
            color=color,
            linewidth=1.8,
            alpha=0.9,
        )
        # Subtle fill under each line
        ax.fill_between(subset["timestamp"], subset["aqi"], alpha=0.08, color=color)

    # ── AQI health band reference lines ──────────────────────────────────────
    band_lines = [
        (50,  "#2A9D8F", "Good"),
        (100, "#E9C46A", "Moderate"),
        (150, "#F4A261", "Unhealthy (sens.)"),
        (200, "#E63946", "Unhealthy"),
    ]
    for y, colour, label in band_lines:
        ax.axhline(y=y, color=colour, linestyle="--", linewidth=0.7, alpha=0.5)
        ax.text(
            df["timestamp"].min(), y + 2, label,
            color=colour, fontsize=7, alpha=0.7,
        )

    # ── Formatting ────────────────────────────────────────────────────────────
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %d\n%H:%M", tz="UTC"))
    ax.xaxis.set_major_locator(mdates.HourLocator(interval=4))
    plt.setp(ax.xaxis.get_majorticklabels(), rotation=0, ha="center", fontsize=8)

    ax.set_xlabel("Time (UTC)", color="#CCCCCC", fontsize=10)
    ax.set_ylabel("AQI  (US EPA)", color="#CCCCCC", fontsize=10)
    ax.set_title(
        "Air Quality Index — Last 24 Hours",
        color="#FFFFFF", fontsize=14, fontweight="bold", pad=15,
    )
    ax.tick_params(colors="#CCCCCC")
    for spine in ax.spines.values():
        spine.set_edgecolor("#444444")
    ax.set_ylim(bottom=0)
    ax.legend(
        loc="upper right",
        framealpha=0.3,
        facecolor="#16213E",
        edgecolor="#444444",
        labelcolor="#FFFFFF",
        fontsize=9,
    )

    plt.tight_layout()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path, dpi=150, bbox_inches="tight", facecolor=fig.get_facecolor())
    plt.close(fig)
    print(f"\n  Plot saved → {output_path.resolve()}")


# ── Main ──────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Explore readings + weather data from Supabase.",
    )
    parser.add_argument(
        "--output",
        default=str(_HERE / "aqi_over_time.png"),
        help="Path to save the AQI plot PNG (default: ingestion/aqi_over_time.png).",
    )
    parser.add_argument(
        "--top-n",
        type=int,
        default=3,
        metavar="N",
        help="Number of stations to include in the AQI plot (default: 3).",
    )
    return parser.parse_args()


def main() -> None:
    args   = parse_args()
    engine = get_engine()

    print("\n" + "=" * 70)
    print("  SUPABASE DATA EXPLORER")
    print("=" * 70)

    # ── Load ──────────────────────────────────────────────────────────────────
    print("\nLoading data from Supabase…", end="", flush=True)
    readings = load_readings(engine)
    weather  = load_weather(engine)
    print(f" done  (readings={len(readings):,}  weather={len(weather):,})")

    # ── Summarise ─────────────────────────────────────────────────────────────
    summarise_readings(readings)
    summarise_weather(weather)

    # ── Plot ──────────────────────────────────────────────────────────────────
    print_section(f"PLOT — Top {args.top_n} stations by data volume")

    if readings.empty:
        print("  No readings data — skipping plot.")
        return

    stations = pick_stations(readings, args.top_n)
    print(f"  Selected stations: {', '.join(stations)}")
    plot_aqi(readings, stations, Path(args.output))

    print("\n" + "=" * 70)
    print("  Done.")
    print("=" * 70 + "\n")


if __name__ == "__main__":
    main()
