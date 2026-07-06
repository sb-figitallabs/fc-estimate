from __future__ import annotations

import argparse
import os
from pathlib import Path
from typing import Any

import psycopg


DEFAULT_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/fc_handover_phase1"
DEFAULT_OUTPUT_PATH = "output/fc_handover_phase1_clean.sql"
TARGET_TABLES = [
    ("mart", "main_table"),
    ("fc", "service_item_mapping"),
    ("fc", "pharmacy_item_mapping"),
    ("fc", "pharmacy_catalog_rate_reference"),
    ("fc", "service_tariff_rate_matrix"),
    ("fc", "consultation_tariff_rate_matrix"),
    ("fc", "organization_tariff_mapping"),
]


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
    parser = argparse.ArgumentParser(description="Export the clean FC handover tables to a restoreable SQL dump.")
    parser.add_argument("--db-url", default=None)
    parser.add_argument("--output", default=DEFAULT_OUTPUT_PATH)
    return parser.parse_args()


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def copy_escape(value: Any) -> str:
    if value is None:
        return r"\N"
    text = str(value)
    return (
        text.replace("\\", "\\\\")
        .replace("\t", "\\t")
        .replace("\n", "\\n")
        .replace("\r", "\\r")
    )


def fetch_table_columns(conn: psycopg.Connection[Any], schema: str, table: str) -> list[dict[str, Any]]:
    query = """
    select
        a.attname as column_name,
        pg_catalog.format_type(a.atttypid, a.atttypmod) as formatted_type,
        not a.attnotnull as is_nullable,
        pg_get_expr(d.adbin, d.adrelid) as column_default
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where n.nspname = %s
      and c.relname = %s
      and a.attnum > 0
      and not a.attisdropped
    order by a.attnum
    """
    with conn.cursor() as cur:
        cur.execute(query, (schema, table))
        return [
            {
                "column_name": row[0],
                "formatted_type": row[1],
                "is_nullable": bool(row[2]),
                "column_default": row[3],
            }
            for row in cur.fetchall()
        ]


def fetch_primary_key(conn: psycopg.Connection[Any], schema: str, table: str) -> str | None:
    query = """
    select pg_get_constraintdef(con.oid)
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = %s
      and c.relname = %s
      and con.contype = 'p'
    limit 1
    """
    with conn.cursor() as cur:
        cur.execute(query, (schema, table))
        row = cur.fetchone()
    return row[0] if row else None


def fetch_row_count(conn: psycopg.Connection[Any], schema: str, table: str) -> int:
    with conn.cursor() as cur:
        cur.execute(f"select count(*) from {schema}.{table}")
        return int(cur.fetchone()[0])


def write_table_ddl(handle: Any, conn: psycopg.Connection[Any], schema: str, table: str) -> None:
    columns = fetch_table_columns(conn, schema, table)
    pk_def = fetch_primary_key(conn, schema, table)
    handle.write(f"create schema if not exists {schema};\n")
    handle.write(f"drop table if exists {schema}.{table};\n")
    handle.write(f"create table {schema}.{table} (\n")
    lines: list[str] = []
    for column in columns:
        line = f"    {column['column_name']} {column['formatted_type']}"
        if column["column_default"] is not None:
            line += f" default {column['column_default']}"
        if not column["is_nullable"]:
            line += " not null"
        lines.append(line)
    if pk_def:
        lines.append(f"    {pk_def}")
    handle.write(",\n".join(lines))
    handle.write("\n);\n\n")


def write_table_data(handle: Any, conn: psycopg.Connection[Any], schema: str, table: str) -> None:
    columns = fetch_table_columns(conn, schema, table)
    column_names = [column["column_name"] for column in columns]
    handle.write(f"truncate table {schema}.{table};\n")
    handle.write(f"copy {schema}.{table} ({', '.join(column_names)}) from stdin;\n")
    with conn.cursor() as cur:
        cur.execute(f"select * from {schema}.{table}")
        for row in cur:
            handle.write("\t".join(copy_escape(value) for value in row))
            handle.write("\n")
    handle.write("\\.\n\n")


def main() -> None:
    args = parse_args()
    db_url = args.db_url or get_db_url()
    output_path = Path(args.output)
    if not output_path.is_absolute():
        output_path = repo_root() / output_path
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with psycopg.connect(db_url) as conn:
        table_counts = {f"{schema}.{table}": fetch_row_count(conn, schema, table) for schema, table in TARGET_TABLES}
        with output_path.open("w", encoding="utf-8", newline="") as handle:
            handle.write("-- Clean FC handover SQL dump\n")
            handle.write(f"-- Source database: {db_url}\n")
            handle.write("begin;\n\n")
            for schema, table in TARGET_TABLES:
                write_table_ddl(handle, conn, schema, table)
            for schema, table in TARGET_TABLES:
                write_table_data(handle, conn, schema, table)
            handle.write("commit;\n")

    print(f"wrote {output_path}")
    for table_name, row_count in table_counts.items():
        print(f"{table_name}: {row_count}")


if __name__ == "__main__":
    main()
