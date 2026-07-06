from __future__ import annotations

import argparse
import csv
import json
import os
from pathlib import Path
from typing import Any

import psycopg


DEFAULT_SOURCE_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
DEFAULT_TARGET_DB_NAME = "fc_handover_phase1"
DEFAULT_CSV_PATH = "/Users/reyvanttambi/Downloads/Org Master _Tariff.xlsx - Sheet1 (2).csv"
DEFAULT_PRIORITY_TYPE = "IPPRIORITY1"
DEFAULT_MAPPING_SOURCE = "kims_csv_org_master_tariff"


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
        description="Create and load the clean FC KIMS-only organization-to-tariff mapping table from CSV."
    )
    parser.add_argument("--csv-path", default=DEFAULT_CSV_PATH)
    parser.add_argument("--target-db-name", default=DEFAULT_TARGET_DB_NAME)
    parser.add_argument("--target-db-url", default=None)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def normalize_text(value: Any) -> str:
    return " ".join(str(value or "").strip().split())


def normalize_code(value: Any) -> str:
    return normalize_text(value).upper()


def fetch_tariff_name_map(source_url: str) -> dict[str, str]:
    query = """
    select
        upper(trim(tariff_cd)) as tariff_cd_norm,
        case when count(distinct nullif(trim(tariff_name), '')) = 1
            then max(nullif(trim(tariff_name), ''))
            else null
        end as derived_tariff_name
    from staging.tariff_master
    where nullif(trim(coalesce(tariff_cd, '')), '') is not null
    group by 1
    """
    with psycopg.connect(source_url) as conn:
        with conn.cursor() as cur:
            cur.execute(query)
            return {
                normalize_code(row[0]): normalize_text(row[1])
                for row in cur.fetchall()
                if normalize_code(row[0])
            }


def fetch_source_rows(csv_path: Path, source_url: str) -> list[dict[str, Any]]:
    tariff_name_map = fetch_tariff_name_map(source_url)
    rows: list[dict[str, Any]] = []
    with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for idx, raw_row in enumerate(reader, start=2):
            tariff_cd = normalize_code(raw_row.get("IPPRIORITY1"))
            rows.append(
                {
                    "company_cd": normalize_code(raw_row.get("COMPANYCD")),
                    "organization_name": normalize_text(raw_row.get("ORGANIZATIONNAME")),
                    "organization_cd": normalize_code(raw_row.get("ORGANIZATIONCD")),
                    "tariff_cd": tariff_cd,
                    "tariff_name": tariff_name_map.get(tariff_cd, ""),
                    "priority_type": DEFAULT_PRIORITY_TYPE,
                    "mapping_source": DEFAULT_MAPPING_SOURCE,
                    "source_file_name": csv_path.name,
                    "source_row_number": idx,
                }
            )
    return rows


def ensure_target_table(conn: psycopg.Connection[Any]) -> None:
    with conn.cursor() as cur:
        cur.execute("create schema if not exists fc")
        cur.execute(
            """
            create table if not exists fc.organization_tariff_mapping (
                company_cd text not null default '',
                organization_name text not null,
                organization_cd text not null,
                tariff_cd text not null,
                tariff_name text,
                priority_type text not null,
                mapping_source text not null,
                source_file_name text not null,
                source_row_number integer,
                primary key (organization_cd)
            )
            """
        )
        cur.execute("truncate table fc.organization_tariff_mapping")
    conn.commit()


def insert_rows(conn: psycopg.Connection[Any], rows: list[dict[str, Any]]) -> None:
    with conn.cursor() as cur:
        cur.executemany(
            """
            insert into fc.organization_tariff_mapping (
                company_cd,
                organization_name,
                organization_cd,
                tariff_cd,
                tariff_name,
                priority_type,
                mapping_source,
                source_file_name,
                source_row_number
            )
            values (
                %(company_cd)s,
                %(organization_name)s,
                %(organization_cd)s,
                %(tariff_cd)s,
                nullif(%(tariff_name)s, ''),
                %(priority_type)s,
                %(mapping_source)s,
                %(source_file_name)s,
                %(source_row_number)s
            )
            """,
            rows,
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


def source_summary(rows: list[dict[str, Any]], csv_path: Path) -> dict[str, Any]:
    org_counts: dict[str, int] = {}
    for row in rows:
        org_cd = row["organization_cd"]
        org_counts[org_cd] = org_counts.get(org_cd, 0) + 1
    return {
        "csv_path": str(csv_path),
        "row_count": len(rows),
        "distinct_organization_cd_count": len({row["organization_cd"] for row in rows}),
        "missing_organization_cd_count": sum(1 for row in rows if not row["organization_cd"]),
        "missing_organization_name_count": sum(1 for row in rows if not row["organization_name"]),
        "missing_tariff_cd_count": sum(1 for row in rows if not row["tariff_cd"]),
        "duplicate_organization_cd_count": sum(1 for count in org_counts.values() if count > 1),
        "resolved_tariff_name_count": sum(1 for row in rows if row["tariff_name"]),
        "unresolved_tariff_name_count": sum(1 for row in rows if not row["tariff_name"]),
    }


def build_validation_summary(conn: psycopg.Connection[Any], source_rows: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "row_count": query_scalar(conn, "select count(*) from fc.organization_tariff_mapping"),
        "distinct_organization_cd_count": query_scalar(
            conn, "select count(distinct organization_cd) from fc.organization_tariff_mapping"
        ),
        "missing_organization_cd_count": query_scalar(
            conn, "select count(*) from fc.organization_tariff_mapping where nullif(btrim(organization_cd), '') is null"
        ),
        "missing_organization_name_count": query_scalar(
            conn, "select count(*) from fc.organization_tariff_mapping where nullif(btrim(organization_name), '') is null"
        ),
        "missing_tariff_cd_count": query_scalar(
            conn, "select count(*) from fc.organization_tariff_mapping where nullif(btrim(tariff_cd), '') is null"
        ),
        "duplicate_organization_cd_count": len(
            query_rows(
                conn,
                """
                select organization_cd, count(*)
                from fc.organization_tariff_mapping
                group by 1
                having count(*) > 1
                limit 10
                """,
            )
        ),
        "priority_type_values": query_rows(
            conn,
            """
            select priority_type, count(*)
            from fc.organization_tariff_mapping
            group by 1
            order by 1
            """,
        ),
        "resolved_tariff_name_count": query_scalar(
            conn,
            "select count(*) from fc.organization_tariff_mapping where nullif(btrim(coalesce(tariff_name, '')), '') is not null",
        ),
        "unresolved_tariff_name_count": query_scalar(
            conn,
            "select count(*) from fc.organization_tariff_mapping where nullif(btrim(coalesce(tariff_name, '')), '') is null",
        ),
        "unresolved_tariff_name_samples": query_rows(
            conn,
            """
            select organization_cd, organization_name, tariff_cd
            from fc.organization_tariff_mapping
            where nullif(btrim(coalesce(tariff_name, '')), '') is null
            order by organization_cd
            limit 10
            """,
        ),
        "sample_rows": query_rows(
            conn,
            """
            select company_cd, organization_name, organization_cd, tariff_cd, tariff_name, priority_type
            from fc.organization_tariff_mapping
            order by organization_cd
            limit 10
            """,
        ),
        "org1063_row": query_rows(
            conn,
            """
            select organization_cd, organization_name, tariff_cd, tariff_name
            from fc.organization_tariff_mapping
            where organization_cd = 'ORG1063'
            """
        ),
        "org218_row": query_rows(
            conn,
            """
            select organization_cd, organization_name, tariff_cd, tariff_name
            from fc.organization_tariff_mapping
            where organization_cd = 'ORG218'
            """
        ),
        "source_row_count_expected": len(source_rows),
    }


def main() -> None:
    args = parse_args()
    csv_path = Path(args.csv_path)
    source_url = get_source_db_url()
    target_url = args.target_db_url or target_db_url(args.target_db_name, source_url)
    rows = fetch_source_rows(csv_path, source_url)
    src_summary = source_summary(rows, csv_path)

    if args.dry_run:
        print(
            json.dumps(
                {
                    "target_db_url": target_url,
                    "source_summary": src_summary,
                },
                indent=2,
                ensure_ascii=True,
            )
        )
        return

    with psycopg.connect(target_url) as conn:
        ensure_target_table(conn)
        insert_rows(conn, rows)
        validation = build_validation_summary(conn, rows)

    print(
        json.dumps(
            {
                "target_db_url": target_url,
                "source_summary": src_summary,
                "load_status": "loaded",
                "validation": validation,
            },
            indent=2,
            ensure_ascii=True,
        )
    )


if __name__ == "__main__":
    main()
