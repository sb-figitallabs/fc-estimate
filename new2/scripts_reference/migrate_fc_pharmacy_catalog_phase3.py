from __future__ import annotations

import argparse
import json
import os
from decimal import Decimal
from pathlib import Path
from typing import Any

import psycopg


DEFAULT_SOURCE_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
DEFAULT_TARGET_DB_NAME = "fc_handover_phase1"


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


def get_source_db_url() -> str:
    load_env_file()
    return os.getenv("SUPABASE_DB_URL", DEFAULT_SOURCE_DB_URL)


def target_db_url(target_db_name: str, source_db_url: str) -> str:
    base = source_db_url.rsplit("/", 1)[0]
    return f"{base}/{target_db_name}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create and load a clean FC pharmacy catalog rate/MRP reference table from staging.pharmacy_catalog_items_clean."
    )
    parser.add_argument("--target-db-name", default=DEFAULT_TARGET_DB_NAME)
    parser.add_argument("--target-db-url", default=None)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def normalize_text(value: Any) -> str:
    return " ".join(str(value or "").strip().split())


def normalize_code(value: Any) -> str:
    return normalize_text(value).replace(" ", "").upper()


def normalize_key(value: Any) -> str:
    text = normalize_text(value).lower()
    return "_".join(part for part in text.replace("/", " ").replace("-", " ").split() if part)


def canonical_item_key(item_code: str, item_name: str) -> str:
    if normalize_code(item_code):
        return normalize_code(item_code)
    return normalize_key(item_name)


def has_numeric(value: Decimal | None) -> bool:
    return value is not None


def fetch_source_rows(source_url: str) -> list[dict[str, Any]]:
    query = """
    select
        run_id,
        item_code,
        item_name,
        generic_name,
        molecule_name,
        sub_category,
        category,
        category_level_1,
        category_desc,
        department_name,
        manufacturer_name,
        mrp,
        sale_rate,
        uom,
        current_status,
        source_priority,
        source_presence,
        source_item_origin
    from staging.pharmacy_catalog_items_clean
    order by item_code
    """
    with psycopg.connect(source_url) as conn:
        with conn.cursor() as cur:
            cur.execute(query)
            return [
                {
                    "run_id": row[0],
                    "item_code": normalize_code(row[1]),
                    "item_name": normalize_text(row[2]),
                    "generic_name": normalize_text(row[3]),
                    "molecule_name": normalize_text(row[4]),
                    "sub_category": normalize_text(row[5]),
                    "category": normalize_text(row[6]),
                    "category_level_1": normalize_text(row[7]),
                    "category_desc": normalize_text(row[8]),
                    "department_name": normalize_text(row[9]),
                    "manufacturer_name": normalize_text(row[10]),
                    "mrp": row[11],
                    "sale_rate": row[12],
                    "uom": normalize_text(row[13]),
                    "current_status": normalize_text(row[14]),
                    "source_priority": normalize_text(row[15]),
                    "source_presence": normalize_text(row[16]),
                    "source_item_origin": normalize_text(row[17]),
                }
                for row in cur.fetchall()
            ]


def ensure_target_table(conn: psycopg.Connection[Any]) -> None:
    with conn.cursor() as cur:
        cur.execute("create schema if not exists fc")
        cur.execute(
            """
            create table if not exists fc.pharmacy_catalog_rate_reference (
                canonical_item_key text primary key,
                item_code text not null,
                item_name text not null,
                generic_name text not null default '',
                molecule_name text not null default '',
                sub_category text not null default '',
                category text not null default '',
                category_level_1 text not null default '',
                category_desc text not null default '',
                department_name text not null default '',
                manufacturer_name text not null default '',
                uom text not null default '',
                mrp numeric,
                sale_rate numeric,
                mrp_populated boolean not null,
                sale_rate_populated boolean not null,
                current_status text not null default '',
                source_priority text not null default '',
                source_presence text not null default '',
                source_item_origin text not null default '',
                source_run_id bigint,
                source_table text not null default 'staging.pharmacy_catalog_items_clean'
            )
            """
        )
        cur.execute("truncate table fc.pharmacy_catalog_rate_reference")
    conn.commit()


def insert_rows(conn: psycopg.Connection[Any], rows: list[dict[str, Any]]) -> None:
    with conn.cursor() as cur:
        cur.executemany(
            """
            insert into fc.pharmacy_catalog_rate_reference (
                canonical_item_key,
                item_code,
                item_name,
                generic_name,
                molecule_name,
                sub_category,
                category,
                category_level_1,
                category_desc,
                department_name,
                manufacturer_name,
                uom,
                mrp,
                sale_rate,
                mrp_populated,
                sale_rate_populated,
                current_status,
                source_priority,
                source_presence,
                source_item_origin,
                source_run_id
            )
            values (
                %(canonical_item_key)s,
                %(item_code)s,
                %(item_name)s,
                %(generic_name)s,
                %(molecule_name)s,
                %(sub_category)s,
                %(category)s,
                %(category_level_1)s,
                %(category_desc)s,
                %(department_name)s,
                %(manufacturer_name)s,
                %(uom)s,
                %(mrp)s,
                %(sale_rate)s,
                %(mrp_populated)s,
                %(sale_rate_populated)s,
                %(current_status)s,
                %(source_priority)s,
                %(source_presence)s,
                %(source_item_origin)s,
                %(run_id)s
            )
            """,
            [
                {
                    **row,
                    "canonical_item_key": canonical_item_key(row["item_code"], row["item_name"]),
                    "mrp_populated": has_numeric(row["mrp"]),
                    "sale_rate_populated": has_numeric(row["sale_rate"]),
                }
                for row in rows
            ],
        )
    conn.commit()


def query_scalar(conn: psycopg.Connection[Any], sql: str) -> int:
    with conn.cursor() as cur:
        cur.execute(sql)
        return int(cur.fetchone()[0])


def query_rows(conn: psycopg.Connection[Any], sql: str) -> list[tuple[Any, ...]]:
    with conn.cursor() as cur:
        cur.execute(sql)
        return cur.fetchall()


def json_safe(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, tuple):
        return [json_safe(part) for part in value]
    if isinstance(value, list):
        return [json_safe(part) for part in value]
    if isinstance(value, dict):
        return {key: json_safe(val) for key, val in value.items()}
    return value


def validation_summary(conn: psycopg.Connection[Any], source_rows: list[dict[str, Any]]) -> dict[str, Any]:
    source_count = len(source_rows)
    expected_mrp_populated = sum(1 for row in source_rows if row["mrp"] is not None)
    expected_sale_rate_populated = sum(1 for row in source_rows if row["sale_rate"] is not None)

    return {
        "row_count": query_scalar(conn, "select count(*) from fc.pharmacy_catalog_rate_reference"),
        "mrp_populated_count": query_scalar(
            conn, "select count(*) from fc.pharmacy_catalog_rate_reference where mrp_populated"
        ),
        "sale_rate_populated_count": query_scalar(
            conn, "select count(*) from fc.pharmacy_catalog_rate_reference where sale_rate_populated"
        ),
        "missing_item_code_count": query_scalar(
            conn, "select count(*) from fc.pharmacy_catalog_rate_reference where nullif(btrim(item_code), '') is null"
        ),
        "missing_item_name_count": query_scalar(
            conn, "select count(*) from fc.pharmacy_catalog_rate_reference where nullif(btrim(item_name), '') is null"
        ),
        "duplicate_key_count": len(
            query_rows(
                conn,
                """
                select canonical_item_key, count(*)
                from fc.pharmacy_catalog_rate_reference
                group by 1
                having count(*) > 1
                limit 10
                """,
            )
        ),
        "expected_source_row_count": source_count,
        "expected_mrp_populated_count": expected_mrp_populated,
        "expected_sale_rate_populated_count": expected_sale_rate_populated,
        "sample_rows": query_rows(
            conn,
            """
            select canonical_item_key, item_code, item_name, mrp, sale_rate, mrp_populated, sale_rate_populated
            from fc.pharmacy_catalog_rate_reference
            order by item_code
            limit 5
            """,
        ),
    }


def main() -> None:
    args = parse_args()
    source_url = get_source_db_url()
    target_url = args.target_db_url or target_db_url(args.target_db_name, source_url)
    source_rows = fetch_source_rows(source_url)

    if args.dry_run:
        print(
            json.dumps(
                {
                    "target_db_url": target_url,
                    "source_row_count": len(source_rows),
                    "mrp_populated_count": sum(1 for row in source_rows if row["mrp"] is not None),
                    "sale_rate_populated_count": sum(1 for row in source_rows if row["sale_rate"] is not None),
                },
                indent=2,
                ensure_ascii=True,
            )
        )
        return

    with psycopg.connect(target_url) as conn:
        ensure_target_table(conn)
        insert_rows(conn, source_rows)
        summary = validation_summary(conn, source_rows)

    print(
        json.dumps(
            json_safe(
                {
                "target_db_url": target_url,
                "validation": summary,
                }
            ),
            indent=2,
            ensure_ascii=True,
        )
    )


if __name__ == "__main__":
    main()
