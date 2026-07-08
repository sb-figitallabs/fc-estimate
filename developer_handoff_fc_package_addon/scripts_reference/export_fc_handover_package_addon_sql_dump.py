from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

import psycopg

try:
    from scripts.etl.migrate_fc_packages_phase7 import PACKAGE_SCHEMA_SQL, PACKAGE_TABLES
except ModuleNotFoundError:  # pragma: no cover
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from scripts.etl.migrate_fc_packages_phase7 import PACKAGE_SCHEMA_SQL, PACKAGE_TABLES


DEFAULT_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/fc_handover_phase1"
DEFAULT_SCHEMA_OUTPUT_PATH = "developer_handoff_fc_package_addon/database/fc_handover_package_addon_schema.sql"
DEFAULT_DATA_OUTPUT_PATH = "developer_handoff_fc_package_addon/database/fc_handover_package_addon_data.sql"


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def load_env_file() -> None:
    env_path = repo_root() / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


def get_db_url() -> str:
    load_env_file()
    return os.getenv("FC_HANDOVER_DB_URL", DEFAULT_DB_URL)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export the FC handoff package add-on schema and data SQL files.")
    parser.add_argument("--db-url", default=None)
    parser.add_argument("--schema-output", default=DEFAULT_SCHEMA_OUTPUT_PATH)
    parser.add_argument("--data-output", default=DEFAULT_DATA_OUTPUT_PATH)
    return parser.parse_args()


def copy_escape(value: Any) -> str:
    if value is None:
        return r"\N"
    if isinstance(value, (dict, list)):
        text = json.dumps(value, ensure_ascii=True, separators=(",", ":"))
    else:
        text = str(value)
    return (
        text.replace("\\", "\\\\")
        .replace("\t", "\\t")
        .replace("\n", "\\n")
        .replace("\r", "\\r")
    )


def fetch_table_columns(conn: psycopg.Connection[Any], schema: str, table: str) -> list[str]:
    query = """
    select a.attname
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = %s
      and c.relname = %s
      and a.attnum > 0
      and not a.attisdropped
    order by a.attnum
    """
    with conn.cursor() as cur:
        cur.execute(query, (schema, table))
        return [row[0] for row in cur.fetchall()]


def fetch_row_count(conn: psycopg.Connection[Any], schema: str, table: str) -> int:
    with conn.cursor() as cur:
        cur.execute(f"select count(*) from {schema}.{table}")
        return int(cur.fetchone()[0])


def write_schema_file(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "-- FC handover package add-on schema\n"
        "-- Apply this after restoring the base FC handoff clean database.\n\n"
        + PACKAGE_SCHEMA_SQL.strip()
        + "\n",
        encoding="utf-8",
    )


def write_data_file(path: Path, conn: psycopg.Connection[Any]) -> dict[str, int]:
    path.parent.mkdir(parents=True, exist_ok=True)
    row_counts: dict[str, int] = {}
    with path.open("w", encoding="utf-8", newline="") as handle:
        handle.write("-- FC handover package add-on data\n")
        handle.write("-- Restore this after applying fc_handover_package_addon_schema.sql\n")
        handle.write("begin;\n\n")
        handle.write(
            "truncate table "
            "fc.package_organization_applicability, "
            "fc.package_alias, "
            "fc.package_room_rates, "
            "fc.package_master;\n\n"
        )
        for schema, table in PACKAGE_TABLES:
            columns = fetch_table_columns(conn, schema, table)
            row_counts[f"{schema}.{table}"] = fetch_row_count(conn, schema, table)
            handle.write(f"copy {schema}.{table} ({', '.join(columns)}) from stdin;\n")
            with conn.cursor() as cur:
                cur.execute(f"select * from {schema}.{table}")
                for row in cur:
                    handle.write("\t".join(copy_escape(value) for value in row))
                    handle.write("\n")
            handle.write("\\.\n\n")
        handle.write("commit;\n")
    return row_counts


def main() -> None:
    args = parse_args()
    db_url = args.db_url or get_db_url()
    schema_output = Path(args.schema_output)
    data_output = Path(args.data_output)
    if not schema_output.is_absolute():
        schema_output = repo_root() / schema_output
    if not data_output.is_absolute():
        data_output = repo_root() / data_output

    write_schema_file(schema_output)
    with psycopg.connect(db_url) as conn:
        row_counts = write_data_file(data_output, conn)

    print(f"wrote schema: {schema_output}")
    print(f"wrote data: {data_output}")
    for table_name, row_count in row_counts.items():
        print(f"{table_name}: {row_count}")


if __name__ == "__main__":
    main()
