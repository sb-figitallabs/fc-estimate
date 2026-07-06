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


class DuplicateTariffKeyError(RuntimeError):
    pass


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
        description="Create and load the clean FC service tariff rate matrix from staging.v_tariff_current_kims_rates."
    )
    parser.add_argument("--target-db-name", default=DEFAULT_TARGET_DB_NAME)
    parser.add_argument("--target-db-url", default=None)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def normalize_text(value: Any) -> str:
    return " ".join(str(value or "").strip().split())


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
    select
        run_id,
        tariff_cd,
        tariff_name,
        rate_domain,
        service_cd,
        service_name,
        service_group_name,
        service_type,
        ward_group_name,
        charge,
        billing_head,
        equ_service_cd,
        service_group_cd,
        is_procedure,
        is_package,
        service_for,
        is_diet,
        is_outside,
        is_sample_needed,
        is_req_consent_slip,
        classification_status,
        selection_reason,
        reference_reason,
        review_reason,
        source_dataset,
        source_file_name,
        source_sheet_name,
        source_row_number
    from staging.v_tariff_current_kims_rates
    where
        source_dataset = '04_Base_Rates_KIMS'
        or (
            source_dataset = '05_Org_Rates_KIMS'
            and upper(trim(coalesce(tariff_cd, ''))) <> 'TR1'
        )
    order by tariff_cd, rate_domain, service_cd, ward_group_name, source_row_number
    """
    with psycopg.connect(source_url) as conn:
        with conn.cursor() as cur:
            cur.execute(query)
            return [
                {
                    "source_run_id": row[0],
                    "tariff_cd": normalize_text(row[1]).upper().replace(" ", ""),
                    "tariff_name": normalize_text(row[2]),
                    "rate_domain": normalize_text(row[3]).lower(),
                    "service_cd": normalize_text(row[4]).upper(),
                    "service_name": normalize_text(row[5]),
                    "service_group_name": normalize_text(row[6]),
                    "service_type": normalize_text(row[7]),
                    "ward_group_name": normalize_text(row[8]).upper(),
                    "charge": row[9],
                    "billing_head": normalize_text(row[10]),
                    "equ_service_cd": normalize_text(row[11]).upper(),
                    "service_group_cd": normalize_text(row[12]).upper(),
                    "is_procedure": normalize_text(row[13]),
                    "is_package": normalize_text(row[14]),
                    "service_for": normalize_text(row[15]),
                    "is_diet": normalize_text(row[16]),
                    "is_outside": normalize_text(row[17]),
                    "is_sample_needed": normalize_text(row[18]),
                    "is_req_consent_slip": normalize_text(row[19]),
                    "classification_status": normalize_text(row[20]),
                    "selection_reason": normalize_text(row[21]),
                    "reference_reason": normalize_text(row[22]),
                    "review_reason": normalize_text(row[23]),
                    "source_dataset": normalize_text(row[24]),
                    "source_file_name": normalize_text(row[25]),
                    "source_sheet_name": normalize_text(row[26]),
                    "source_row_number": row[27],
                }
                for row in cur.fetchall()
            ]


def fetch_duplicate_summary(source_url: str) -> dict[str, Any]:
    duplicate_group_query = """
    select
        tariff_cd,
        rate_domain,
        service_cd,
        ward_group_name,
        count(*) as duplicate_count,
        count(distinct charge) as distinct_charge_count,
        min(charge) as min_charge,
        max(charge) as max_charge,
        min(service_name) as min_service_name,
        max(service_name) as max_service_name
    from staging.v_tariff_current_kims_rates
    where
        source_dataset = '04_Base_Rates_KIMS'
        or (
            source_dataset = '05_Org_Rates_KIMS'
            and upper(trim(coalesce(tariff_cd, ''))) <> 'TR1'
        )
    group by 1, 2, 3, 4
    having count(*) > 1
    order by duplicate_count desc, tariff_cd, rate_domain, service_cd, ward_group_name
    limit 20
    """
    duplicate_counts_query = """
    select
        count(*) as duplicate_key_group_count,
        count(*) filter (where distinct_charge_count > 1) as conflicting_charge_group_count
    from (
        select
            tariff_cd,
            rate_domain,
            service_cd,
            ward_group_name,
            count(*) as duplicate_count,
            count(distinct charge) as distinct_charge_count
        from staging.v_tariff_current_kims_rates
        where
            source_dataset = '04_Base_Rates_KIMS'
            or (
                source_dataset = '05_Org_Rates_KIMS'
                and upper(trim(coalesce(tariff_cd, ''))) <> 'TR1'
            )
        group by 1, 2, 3, 4
        having count(*) > 1
    ) t
    """
    with psycopg.connect(source_url) as conn:
        with conn.cursor() as cur:
            cur.execute(duplicate_counts_query)
            duplicate_key_group_count, conflicting_charge_group_count = cur.fetchone()
            cur.execute(duplicate_group_query)
            duplicate_key_samples = cur.fetchall()
    return {
        "duplicate_key_group_count": int(duplicate_key_group_count or 0),
        "conflicting_charge_group_count": int(conflicting_charge_group_count or 0),
        "duplicate_key_samples": duplicate_key_samples,
    }


def ensure_target_table(conn: psycopg.Connection[Any]) -> None:
    with conn.cursor() as cur:
        cur.execute("create schema if not exists fc")
        cur.execute(
            """
            create table if not exists fc.service_tariff_rate_matrix (
                tariff_cd text not null,
                tariff_name text not null default '',
                rate_domain text not null,
                service_cd text not null,
                service_name text not null default '',
                service_group_name text not null default '',
                service_type text not null default '',
                ward_group_name text not null,
                charge numeric not null,
                billing_head text not null default '',
                equ_service_cd text not null default '',
                service_group_cd text not null default '',
                is_procedure text not null default '',
                is_package text not null default '',
                service_for text not null default '',
                is_diet text not null default '',
                is_outside text not null default '',
                is_sample_needed text not null default '',
                is_req_consent_slip text not null default '',
                classification_status text not null default '',
                selection_reason text not null default '',
                reference_reason text not null default '',
                review_reason text not null default '',
                source_dataset text not null default '',
                source_file_name text not null default '',
                source_sheet_name text not null default '',
                source_row_number integer,
                source_run_id bigint,
                primary key (tariff_cd, rate_domain, service_cd, ward_group_name)
            )
            """
        )
    conn.commit()


def truncate_target_table(conn: psycopg.Connection[Any]) -> None:
    with conn.cursor() as cur:
        cur.execute("truncate table fc.service_tariff_rate_matrix")
    conn.commit()


def insert_rows(conn: psycopg.Connection[Any], rows: list[dict[str, Any]]) -> None:
    with conn.cursor() as cur:
        cur.executemany(
            """
            insert into fc.service_tariff_rate_matrix (
                tariff_cd,
                tariff_name,
                rate_domain,
                service_cd,
                service_name,
                service_group_name,
                service_type,
                ward_group_name,
                charge,
                billing_head,
                equ_service_cd,
                service_group_cd,
                is_procedure,
                is_package,
                service_for,
                is_diet,
                is_outside,
                is_sample_needed,
                is_req_consent_slip,
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
                %(tariff_cd)s,
                %(tariff_name)s,
                %(rate_domain)s,
                %(service_cd)s,
                %(service_name)s,
                %(service_group_name)s,
                %(service_type)s,
                %(ward_group_name)s,
                %(charge)s,
                %(billing_head)s,
                %(equ_service_cd)s,
                %(service_group_cd)s,
                %(is_procedure)s,
                %(is_package)s,
                %(service_for)s,
                %(is_diet)s,
                %(is_outside)s,
                %(is_sample_needed)s,
                %(is_req_consent_slip)s,
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


def source_summary(rows: list[dict[str, Any]], duplicate_summary: dict[str, Any]) -> dict[str, Any]:
    domain_counts: dict[str, int] = {}
    for row in rows:
        domain_counts[row["rate_domain"]] = domain_counts.get(row["rate_domain"], 0) + 1
    return {
        "row_count": len(rows),
        "domain_counts": domain_counts,
        "missing_tariff_cd_count": sum(1 for row in rows if not row["tariff_cd"]),
        "missing_service_cd_count": sum(1 for row in rows if not row["service_cd"]),
        "missing_ward_group_name_count": sum(1 for row in rows if not row["ward_group_name"]),
        "missing_charge_count": sum(1 for row in rows if row["charge"] is None),
        "blank_service_name_count": sum(1 for row in rows if not row["service_name"]),
        "distinct_tariff_cd_count": len({row["tariff_cd"] for row in rows}),
        "distinct_service_cd_count": len({row["service_cd"] for row in rows}),
        "distinct_ward_group_name_count": len({row["ward_group_name"] for row in rows}),
        **duplicate_summary,
    }


def validate_no_duplicate_keys(duplicate_summary: dict[str, Any]) -> None:
    if duplicate_summary["duplicate_key_group_count"] > 0:
        raise DuplicateTariffKeyError(
            json.dumps(
                json_safe(
                    {
                        "error": "duplicate_source_keys",
                        "duplicate_key_group_count": duplicate_summary["duplicate_key_group_count"],
                        "conflicting_charge_group_count": duplicate_summary["conflicting_charge_group_count"],
                        "duplicate_key_samples": duplicate_summary["duplicate_key_samples"],
                    }
                ),
                ensure_ascii=True,
            )
        )


def build_validation_summary(conn: psycopg.Connection[Any], source_rows: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "row_count": query_scalar(conn, "select count(*) from fc.service_tariff_rate_matrix"),
        "domain_counts": dict(
            query_rows(
                conn,
                """
                select rate_domain, count(*)
                from fc.service_tariff_rate_matrix
                group by 1
                order by 1
                """,
            )
        ),
        "missing_tariff_cd_count": query_scalar(
            conn, "select count(*) from fc.service_tariff_rate_matrix where nullif(btrim(tariff_cd), '') is null"
        ),
        "missing_service_cd_count": query_scalar(
            conn, "select count(*) from fc.service_tariff_rate_matrix where nullif(btrim(service_cd), '') is null"
        ),
        "missing_ward_group_name_count": query_scalar(
            conn, "select count(*) from fc.service_tariff_rate_matrix where nullif(btrim(ward_group_name), '') is null"
        ),
        "missing_charge_count": query_scalar(
            conn, "select count(*) from fc.service_tariff_rate_matrix where charge is null"
        ),
        "blank_service_name_count": query_scalar(
            conn, "select count(*) from fc.service_tariff_rate_matrix where nullif(btrim(service_name), '') is null"
        ),
        "distinct_tariff_cd_count": query_scalar(
            conn, "select count(distinct tariff_cd) from fc.service_tariff_rate_matrix"
        ),
        "distinct_service_cd_count": query_scalar(
            conn, "select count(distinct service_cd) from fc.service_tariff_rate_matrix"
        ),
        "distinct_ward_group_name_count": query_scalar(
            conn, "select count(distinct ward_group_name) from fc.service_tariff_rate_matrix"
        ),
        "sample_rows": query_rows(
            conn,
            """
            select tariff_cd, rate_domain, service_cd, service_name, ward_group_name, charge, billing_head
            from fc.service_tariff_rate_matrix
            where ward_group_name in ('GENERAL', 'TWIN', 'SINGLE', 'DELUXE', 'SUITE', 'PREMIUM SUITE', 'ICCU', 'OUT PATIENT')
            order by tariff_cd, rate_domain, service_cd, ward_group_name
            limit 10
            """,
        ),
        "sample_cross_ward_rows": query_rows(
            conn,
            """
            select tariff_cd, rate_domain, service_cd, ward_group_name, charge
            from fc.service_tariff_rate_matrix
            where service_cd = 'ANS0001'
            order by tariff_cd, ward_group_name
            limit 20
            """,
        ),
        "source_row_count_expected": len(source_rows),
        "source_domain_counts_expected": {
            domain: count for domain, count in source_summary(source_rows, {"duplicate_key_group_count": 0, "conflicting_charge_group_count": 0, "duplicate_key_samples": []})["domain_counts"].items()
        },
    }


def main() -> None:
    args = parse_args()
    source_url = get_source_db_url()
    target_url = args.target_db_url or target_db_url(args.target_db_name, source_url)
    rows = fetch_source_rows(source_url)
    duplicate_summary = fetch_duplicate_summary(source_url)
    src_summary = source_summary(rows, duplicate_summary)

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

    try:
        validate_no_duplicate_keys(duplicate_summary)
    except DuplicateTariffKeyError as exc:
        print(
            json.dumps(
                json_safe(
                    {
                        "target_db_url": target_url,
                        "source_summary": src_summary,
                        "load_status": "blocked_by_duplicate_source_keys",
                        "error_detail": json.loads(str(exc)),
                    }
                ),
                indent=2,
                ensure_ascii=True,
            )
        )
        raise SystemExit(1)

    with psycopg.connect(target_url) as conn:
        ensure_target_table(conn)
        truncate_target_table(conn)
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
