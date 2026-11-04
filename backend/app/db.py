from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .config import settings

pool = ConnectionPool(
    settings.database_url,
    min_size=1,
    max_size=10,
    kwargs={"row_factory": dict_row},
    open=False,
)


def get_conn():
    """FastAPI dependency: one transaction per request.

    Commits when the request handler returns, rolls back if it raises
    (including HTTPException)."""
    with pool.connection() as conn:
        yield conn
