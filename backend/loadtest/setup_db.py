"""Creates (or drops) the disposable football_quiz_loadtest database and
runs real migrations against it. Never touches football_quiz or
football_quiz_test - see the DB_NAME guard below.

Usage:
    python loadtest/setup_db.py              # drop-if-exists, recreate, migrate
    python loadtest/setup_db.py --drop-only   # just drop it, don't recreate
"""

import argparse
import os
import subprocess
import sys

import psycopg2

PG_HOST = os.environ.get("LOADTEST_PG_HOST", "localhost")
PG_PORT = int(os.environ.get("LOADTEST_PG_PORT", "5432"))
PG_USER = os.environ.get("LOADTEST_PG_USER", "quiz_user")
PG_PASSWORD = os.environ.get("LOADTEST_PG_PASSWORD", "quiz_password")
DB_NAME = "football_quiz_loadtest"

DATABASE_URL = f"postgresql://{PG_USER}:{PG_PASSWORD}@{PG_HOST}:{PG_PORT}/{DB_NAME}"


def _admin_connection():
    # Connect to a database that's guaranteed to exist already (the real dev
    # DB) purely as an administrative connection to issue CREATE/DROP
    # DATABASE - those statements can't run against the database they're
    # operating on.
    conn = psycopg2.connect(host=PG_HOST, port=PG_PORT, user=PG_USER, password=PG_PASSWORD, dbname="football_quiz")
    conn.autocommit = True
    return conn


def drop_database() -> None:
    conn = _admin_connection()
    try:
        cur = conn.cursor()
        # Terminate any lingering connections (e.g. a waitress server left
        # running from a previous session) - DROP DATABASE fails outright if
        # anything is still connected.
        cur.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s AND pid <> pg_backend_pid()",
            (DB_NAME,),
        )
        cur.execute(f"DROP DATABASE IF EXISTS {DB_NAME}")
        print(f"Dropped {DB_NAME} (if it existed).")
    finally:
        conn.close()


def create_database() -> None:
    conn = _admin_connection()
    try:
        cur = conn.cursor()
        cur.execute(f"CREATE DATABASE {DB_NAME}")
        print(f"Created {DB_NAME}.")
    finally:
        conn.close()


def run_migrations() -> None:
    env = dict(os.environ)
    env["FLASK_APP"] = "wsgi.py"
    env["FLASK_ENV"] = "development"  # migrations don't need production's secret validation
    env["DATABASE_URL"] = DATABASE_URL
    backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    result = subprocess.run(
        [sys.executable, "-m", "flask", "db", "upgrade"],
        cwd=backend_dir,
        env=env,
    )
    if result.returncode != 0:
        raise SystemExit("flask db upgrade failed - see output above")
    print("Migrations applied.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--drop-only", action="store_true")
    args = parser.parse_args()

    drop_database()
    if not args.drop_only:
        create_database()
        run_migrations()
        print(f"\nReady: {DATABASE_URL}")
