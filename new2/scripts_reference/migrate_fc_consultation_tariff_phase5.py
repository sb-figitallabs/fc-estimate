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
        description="Create and load the clean FC consultation tariff rate matrix from staging.v_tariff_current_kims_consultation."
    )
    parser.add_argument("--target-db-name", default=DEFAULT_TARGET_DB_NAME)
    parser.add_argument("--target-db-url", default=None)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def normalize_text(value: Any) -> str:
    return " ".join(str(value or "").strip().split())


def normalize_code(value: Any) -> str:
    return normalize_text(value).upper()


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


def fetch_source_rows(source_url: str) -> list[dict[str, Any]]:
    query = """
    with tariff_name_map as (
        select
            upper(trim(tariff_name)) as tariff_name_norm,
            case when count(distinct upper(trim(tariff_cd))) = 1
                then max(upper(trim(tariff_cd)))
                else null
            end as derived_tariff_cd,
            count(distinct upper(trim(tariff_cd))) as tariff_cd_count
        from staging.tariff_master
        where nullif(trim(coalesce(tariff_name, '')), '') is not null
          and nullif(trim(coalesce(tariff_cd, '')), '') is not null
        group by 1
    )
    select
        c.run_id,
        c.tariff_name,
        map.derived_tariff_cd,
        c.doctor_cd,
        c.doctor_name,
        c.department_name,
        c.ward_group_name,
        c.charge,
        c.revisit_charge,
        c.emergency_charge,
        c.billing_head,
        c.is_active,
        c.classification_status,
        c.selection_reason,
        c.reference_reason,
        c.review_reason,
        c.source_dataset,
        c.source_file_name,
        c.source_sheet_name,
        c.source_row_number
    from staging.v_tariff_current_kims_consultation c
    left join tariff_name_map map
      on map.tariff_name_norm = upper(trim(c.tariff_name))
    order by c.tariff_name, c.doctor_cd, c.ward_group_name, c.source_row_number
    """
    with psycopg.connect(source_url) as conn:
        with conn.cursor() as cur:
            cur.execute(query)
            return [
                {
                    "source_run_id": row[0],
                    "tariff_name": normalize_text(row[1]),
                    "tariff_cd": normalize_code(row[2]),
                    "doctor_cd": normalize_code(row[3]),
                    "doctor_name": normalize_text(row[4]),
                    "department_name": normalize_text(row[5]),
                    "ward_group_name": normalize_code(row[6]),
                    "charge": row[7],
                    "revisit_charge": row[8],
                    "emergency_charge": row[9],
                    "billing_head": normalize_text(row[10]),
                    "is_active": normalize_text(row[11]),
                    "classification_status": normalize_text(row[12]),
                    "selection_reason": normalize_text(row[13]),
                    "reference_reason": normalize_text(row[14]),
                    "review_reason": normalize_text(row[15]),
                    "source_dataset": normalize_text(row[16]),
                    "source_file_name": normalize_text(row[17]),
                    "source_sheet_name": normalize_text(row[18]),
                    "source_row_number": row[19],
                }
                for row in cur.fetchall()
            ]


def ensure_target_table(conn: psycopg.Connection[Any]) -> None:
    with conn.cursor() as cur:
        cur.execute("create schema if not exists fc")
        cur.execute(
            """
            create table if not exists fc.consultation_tariff_rate_matrix (
                tariff_name text not null,
                tariff_cd text,
                doctor_cd text not null,
                doctor_name text not null,
                department_name text not null default '',
                ward_group_name text not null,
                charge numeric not null,
                revisit_charge numeric not null,
                emergency_charge numeric not null,
                billing_head text not null default '',
                is_active text not null default '',
                classification_status text not null default '',
                selection_reason text not null default '',
                reference_reason text not null default '',
                review_reason text not null default '',
                source_dataset text not null default '',
                source_file_name text not null default '',
                source_sheet_name text not null default '',
                source_row_number integer,
                source_run_id bigint,
                primary key (tariff_name, doctor_cd, ward_group_name)
            )
            """
        )
        cur.execute("truncate table fc.consultation_tariff_rate_matrix")
    conn.commit()


def insert_rows(conn: psycopg.Connection[Any], rows: list[dict[str, Any]]) -> None:
    with conn.cursor() as cur:
        cur.executemany(
            """
            insert into fc.consultation_tariff_rate_matrix (
                tariff_name,
                tariff_cd,
                doctor_cd,
                doctor_name,
                department_name,
                ward_group_name,
                charge,
                revisit_charge,
                emergency_charge,
                billing_head,
                is_active,
                classification_status,
                selection_reason,
                reference_reason,
                review_reason,
                source_dataset,
                source_file_name,
                source_sheet_name,
                source_row_number,
                source_run_id
            )
            values (
                %(tariff_name)s,
                nullif(%(tariff_cd)s, ''),
                %(doctor_cd)s,
                %(doctor_name)s,
                %(department_name)s,
                %(ward_group_name)s,
                %(charge)s,
                %(revisit_charge)s,
                %(emergency_charge)s,
                %(billing_head)s,
                %(is_active)s,
                %(classification_status)s,
                %(selection_reason)s,
                %(reference_reason)s,
                %(review_reason)s,
                %(source_dataset)s,
                %(source_file_name)s,
                %(source_sheet_name)s,
                %(source_row_number)s,
                %(source_run_id)s
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


def source_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    key_counts: dict[tuple[str, str, str], int] = {}
    for row in rows:
        key = (row["tariff_name"], row["doctor_cd"], row["ward_group_name"])
        key_counts[key] = key_counts.get(key, 0) + 1
    return {
        "row_count": len(rows),
        "missing_tariff_name_count": sum(1 for row in rows if not row["tariff_name"]),
        "missing_doctor_cd_count": sum(1 for row in rows if not row["doctor_cd"]),
        "missing_doctor_name_count": sum(1 for row in rows if not row["doctor_name"]),
        "missing_ward_group_name_count": sum(1 for row in rows if not row["ward_group_name"]),
        "missing_charge_count": sum(1 for row in rows if row["charge"] is None),
        "missing_revisit_charge_count": sum(1 for row in rows if row["revisit_charge"] is None),
        "missing_emergency_charge_count": sum(1 for row in rows if row["emergency_charge"] is None),
        "distinct_tariff_name_count": len({row["tariff_name"] for row in rows}),
        "distinct_doctor_cd_count": len({row["doctor_cd"] for row in rows}),
        "distinct_ward_group_name_count": len({row["ward_group_name"] for row in rows}),
        "resolved_tariff_cd_row_count": sum(1 for row in rows if row["tariff_cd"]),
        "unresolved_tariff_cd_row_count": sum(1 for row in rows if not row["tariff_cd"]),
        "unresolved_tariff_name_samples": sorted({row["tariff_name"] for row in rows if not row["tariff_cd"]})[:10],
        "duplicate_key_group_count": sum(1 for count in key_counts.values() if count > 1),
    }


def build_validation_summary(conn: psycopg.Connection[Any], source_rows: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "row_count": query_scalar(conn, "select count(*) from fc.consultation_tariff_rate_matrix"),
        "missing_tariff_name_count": query_scalar(
            conn, "select count(*) from fc.consultation_tariff_rate_matrix where nullif(btrim(tariff_name), '') is null"
        ),
        "missing_doctor_cd_count": query_scalar(
            conn, "select count(*) from fc.consultation_tariff_rate_matrix where nullif(btrim(doctor_cd), '') is null"
        ),
        "missing_doctor_name_count": query_scalar(
            conn, "select count(*) from fc.consultation_tariff_rate_matrix where nullif(btrim(doctor_name), '') is null"
        ),
        "missing_ward_group_name_count": query_scalar(
            conn, "select count(*) from fc.consultation_tariff_rate_matrix where nullif(btrim(ward_group_name), '') is null"
        ),
        "missing_charge_count": query_scalar(
            conn, "select count(*) from fc.consultation_tariff_rate_matrix where charge is null"
        ),
        "missing_revisit_charge_count": query_scalar(
            conn, "select count(*) from fc.consultation_tariff_rate_matrix where revisit_charge is null"
        ),
        "missing_emergency_charge_count": query_scalar(
            conn, "select count(*) from fc.consultation_tariff_rate_matrix where emergency_charge is null"
        ),
        "distinct_tariff_name_count": query_scalar(
            conn, "select count(distinct tariff_name) from fc.consultation_tariff_rate_matrix"
        ),
        "distinct_doctor_cd_count": query_scalar(
            conn, "select count(distinct doctor_cd) from fc.consultation_tariff_rate_matrix"
        ),
        "distinct_ward_group_name_count": query_scalar(
            conn, "select count(distinct ward_group_name) from fc.consultation_tariff_rate_matrix"
        ),
        "duplicate_key_count": len(
            query_rows(
                conn,
                """
                select tariff_name, doctor_cd, ward_group_name, count(*)
                from fc.consultation_tariff_rate_matrix
                group by 1, 2, 3
                having count(*) > 1
                limit 10
                """,
            )
        ),
        "resolved_tariff_cd_row_count": query_scalar(
            conn, "select count(*) from fc.consultation_tariff_rate_matrix where nullif(btrim(coalesce(tariff_cd, '')), '') is not null"
        ),
        "unresolved_tariff_cd_row_count": query_scalar(
            conn, "select count(*) from fc.consultation_tariff_rate_matrix where nullif(btrim(coalesce(tariff_cd, '')), '') is null"
        ),
        "unresolved_tariff_name_samples": query_rows(
            conn,
            """
            select tariff_name, count(*)
            from fc.consultation_tariff_rate_matrix
            where nullif(btrim(coalesce(tariff_cd, '')), '') is null
            group by 1
            order by count(*) desc, tariff_name
            limit 10
            """,
        ),
        "sample_rows": query_rows(
            conn,
            """
            select tariff_name, tariff_cd, doctor_cd, doctor_name, ward_group_name, charge, revisit_charge, emergency_charge
            from fc.consultation_tariff_rate_matrix
            where ward_group_name in ('OUT PATIENT', 'DELUXE', 'TWIN', 'SINGLE', 'SUITE', 'ICCU', 'GENERAL', 'PREMIUM SUITE')
            order by tariff_name, doctor_cd, ward_group_name
            limit 10
            """,
        ),
        "sample_cross_ward_rows": query_rows(
            conn,
            """
            select tariff_name, tariff_cd, doctor_cd, ward_group_name, charge, revisit_charge, emergency_charge
            from fc.consultation_tariff_rate_matrix
            where doctor_cd = (
                select doctor_cd
                from fc.consultation_tariff_rate_matrix
                group by doctor_cd
                order by count(*) desc, doctor_cd
                limit 1
            )
            order by tariff_name, ward_group_name
            limit 20
            """,
        ),
        "source_row_count_expected": len(source_rows),
    }


def main() -> None:
    args = parse_args()
    source_url = get_source_db_url()
    target_url = args.target_db_url or target_db_url(args.target_db_name, source_url)
    rows = fetch_source_rows(source_url)
    src_summary = source_summary(rows)

    if args.dry_run:
        print(
            json.dumps(
                json_safe(
                    {
                        "target_db_url": target_url,
                        "source_summary": src_summary,
                    }
                ),
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
            json_safe(
                {
                    "target_db_url": target_url,
                    "source_summary": src_summary,
                    "load_status": "loaded",
                    "validation": validation,
                }
            ),
            indent=2,
            ensure_ascii=True,
        )
    )


if __name__ == "__main__":
    main()
