"""Minimal migration runner: applies backend/migrations/*.sql in filename order.

Each file runs in its own transaction and is recorded in schema_migrations.
An advisory lock makes it safe when several app workers start at once."""

import logging

import psycopg

from .config import settings

log = logging.getLogger("carbonara.migrate")
LOCK_ID = 727_001


def run_migrations() -> None:
    with psycopg.connect(settings.database_url, autocommit=True) as conn:
        conn.execute("SELECT pg_advisory_lock(%s)", (LOCK_ID,))
        try:
            conn.execute(
                """CREATE TABLE IF NOT EXISTS schema_migrations (
                       version    text PRIMARY KEY,
                       applied_at timestamptz NOT NULL DEFAULT now())"""
            )
            applied = {r[0] for r in conn.execute("SELECT version FROM schema_migrations")}
            for path in sorted(settings.migrations_dir.glob("*.sql")):
                if path.name in applied:
                    continue
                log.info("Applying migration %s", path.name)
                with conn.transaction():
                    conn.execute(path.read_text(encoding="utf-8"))
                    conn.execute(
                        "INSERT INTO schema_migrations (version) VALUES (%s)", (path.name,)
                    )
        finally:
            conn.execute("SELECT pg_advisory_unlock(%s)", (LOCK_ID,))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run_migrations()
