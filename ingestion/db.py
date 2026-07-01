"""
db.py — SQLAlchemy engine factory for the Supabase Postgres connection.

Usage:
    from db import get_engine, get_connection

    with get_connection() as conn:
        conn.execute(text("SELECT 1"))
"""

import os
from dotenv import load_dotenv
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

# Load .env from the ingestion/ directory (or project root as fallback)
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"))
load_dotenv()  # fallback to CWD

_engine: Engine | None = None
_ALLOWED_TABLES = frozenset({"stations", "readings", "weather", "forecasts", "user_profiles"})


def get_engine() -> Engine:
    """Return a singleton SQLAlchemy engine connected to Supabase Postgres."""
    global _engine
    if _engine is None:
        db_url = os.getenv("SUPABASE_DB_URL")
        if not db_url:
            raise RuntimeError(
                "SUPABASE_DB_URL is not set. "
                "Copy ingestion/.env.template to ingestion/.env and fill in your connection string."
            )
        # Enforce SSL — add if not already present
        if "sslmode" not in db_url:
            sep = "&" if "?" in db_url else "?"
            db_url = f"{db_url}{sep}sslmode=require"
        _engine = create_engine(
            db_url,
            pool_pre_ping=True,
            pool_size=5,
            max_overflow=10,
            connect_args={"connect_timeout": 10},
        )
    return _engine


def get_connection():
    """Context manager: yields an open connection from the pool."""
    return get_engine().connect()


def validate_table_name(name: str) -> str:
    """Validate table name against the allowlist to prevent SQL injection."""
    if name not in _ALLOWED_TABLES:
        raise ValueError(
            f"Invalid table name: '{name}'. Allowed: {sorted(_ALLOWED_TABLES)}"
        )
    return name


def verify_connection() -> bool:
    """Smoke-test the database connection. Returns True on success."""
    try:
        with get_connection() as conn:
            conn.execute(text("SELECT 1"))
        print("[OK]  Database connection OK")
        return True
    except Exception:
        print("[FAIL]  Database connection failed — check your credentials and network.")
        return False


if __name__ == "__main__":
    verify_connection()
