from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb


DEFAULT_SOURCE_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
DEFAULT_TARGET_DB_NAME = "fc_handover_phase1"

PACKAGE_TABLES = [
    ("fc", "package_master"),
    ("fc", "package_room_rates"),
    ("fc", "package_alias"),
    ("fc", "package_organization_applicability"),
]

PACKAGE_SCHEMA_SQL = """
create schema if not exists fc;

create table if not exists fc.package_master (
    tariff_code text not null,
    package_code text not null,
    package_name text not null,
    canonical_package_name text,
    normalized_package_name text,
    tariff_name text,
    package_type text,
    department_code text,
    department_name text,
    company_code text,
    package_amount numeric,
    package_atl_amount numeric,
    pre_days integer,
    post_days integer,
    package_duration integer,
    is_active boolean,
    effective_from date,
    effective_to date,
    equservice_code text,
    surgery_code text,
    is_edit_days_in_pkg_billing boolean,
    source_pack text not null,
    source_version text,
    payor_bucket text not null,
    documentation_available boolean,
    documentation_status text,
    has_tariff boolean,
    tariff_source text,
    tariff_information text,
    has_inclusions boolean,
    inclusion_source text,
    inclusions_text text,
    has_exclusions boolean,
    exclusion_source text,
    exclusions_text text,
    documentation_family text,
    documentation_confidence text,
    documentation_notes text,
    matched_room_category text,
    json_package_code text,
    json_package_id text,
    json_serial_no text,
    json_procedure_name text,
    json_system text,
    json_category text,
    package_specific_reference_codes text,
    shared_terms_apply boolean,
    non_admissible_expense_rules_apply boolean,
    agreement_general_clauses text,
    agreement_surgical_guidelines text,
    fc_template_available boolean,
    fc_runtime_ready boolean,
    fc_template_status text,
    fc_mapping_confidence text,
    fc_match_method text,
    fc_template_package_code text,
    fc_template_primary_package_name text,
    fc_template_package_names text,
    fc_tariff_code text,
    fc_tariff_name text,
    fc_case_count_total bigint,
    fc_template_action text,
    fc_runtime_behavior text,
    fc_notes text,
    fc_alternative_candidates_jsonb jsonb not null default '[]'::jsonb,
    can_generate_estimate boolean,
    can_generate_label text,
    runtime_status text,
    readiness_score numeric,
    primary_blocker text,
    secondary_gaps text,
    missing_items text,
    developer_action text,
    in_review_queue boolean,
    warning_reason text,
    primary key (tariff_code, package_code)
);

create index if not exists fc_package_master_name_idx
    on fc.package_master (lower(package_name));
create index if not exists fc_package_master_canonical_name_idx
    on fc.package_master (lower(coalesce(canonical_package_name, '')));
create index if not exists fc_package_master_payor_idx
    on fc.package_master (payor_bucket, tariff_code);
create index if not exists fc_package_master_fc_pkg_idx
    on fc.package_master (fc_template_package_code);
create index if not exists fc_package_master_runtime_idx
    on fc.package_master (runtime_status, can_generate_estimate);

create table if not exists fc.package_room_rates (
    tariff_code text not null,
    package_code text not null,
    ordinal integer not null,
    room_category_code text,
    room_category_label text,
    amount numeric,
    source_field text,
    source_note text,
    primary key (tariff_code, package_code, ordinal),
    foreign key (tariff_code, package_code)
        references fc.package_master(tariff_code, package_code)
        on delete cascade
);

create table if not exists fc.package_alias (
    tariff_code text not null,
    package_code text not null,
    package_name text,
    alias_text text not null,
    alias_type text not null default '',
    alias_source text,
    alias_confidence text,
    normalized_alias_text text,
    source_code text,
    source_record_id text,
    notes text,
    primary key (tariff_code, package_code, alias_text, alias_type),
    foreign key (tariff_code, package_code)
        references fc.package_master(tariff_code, package_code)
        on delete cascade
);

create index if not exists fc_package_alias_norm_idx
    on fc.package_alias (normalized_alias_text);

create table if not exists fc.package_organization_applicability (
    organization_cd text not null default '',
    organization_name text,
    tariff_code text not null,
    tariff_name text,
    package_code text not null,
    package_name text,
    payor_bucket text not null,
    applicability_source text not null,
    primary key (organization_cd, tariff_code, package_code),
    foreign key (tariff_code, package_code)
        references fc.package_master(tariff_code, package_code)
        on delete cascade
);

create index if not exists fc_package_org_applicability_lookup_idx
    on fc.package_organization_applicability (organization_cd, tariff_code);

create or replace view fc.v_package_runtime_lookup as
with alias_summary as (
    select
        tariff_code,
        package_code,
        jsonb_agg(
            jsonb_build_object(
                'alias_text', alias_text,
                'alias_type', nullif(alias_type, ''),
                'alias_source', alias_source,
                'alias_confidence', alias_confidence
            )
            order by normalized_alias_text, alias_text
        ) as aliases_jsonb
    from fc.package_alias
    group by tariff_code, package_code
),
room_rate_summary as (
    select
        tariff_code,
        package_code,
        jsonb_agg(
            jsonb_build_object(
                'ordinal', ordinal,
                'room_category_code', room_category_code,
                'room_category_label', room_category_label,
                'amount', amount,
                'source_field', source_field,
                'source_note', source_note
            )
            order by ordinal
        ) as room_rates_jsonb
    from fc.package_room_rates
    group by tariff_code, package_code
)
select
    nullif(app.organization_cd, '') as organization_cd,
    app.organization_name,
    pm.tariff_code,
    coalesce(app.tariff_name, pm.tariff_name) as tariff_name,
    pm.package_code,
    pm.package_name,
    pm.canonical_package_name,
    pm.normalized_package_name,
    pm.package_type,
    pm.department_code,
    pm.department_name,
    pm.company_code,
    pm.package_amount,
    pm.package_atl_amount,
    pm.pre_days,
    pm.post_days,
    pm.package_duration,
    pm.is_active,
    pm.effective_from,
    pm.effective_to,
    pm.equservice_code,
    pm.surgery_code,
    pm.is_edit_days_in_pkg_billing,
    pm.source_pack,
    pm.source_version,
    pm.payor_bucket,
    app.applicability_source,
    pm.documentation_available,
    pm.documentation_status,
    pm.has_tariff,
    pm.tariff_source,
    pm.tariff_information,
    pm.has_inclusions,
    pm.inclusion_source,
    pm.inclusions_text,
    pm.has_exclusions,
    pm.exclusion_source,
    pm.exclusions_text,
    pm.documentation_family,
    pm.documentation_confidence,
    pm.documentation_notes,
    pm.matched_room_category,
    pm.json_package_code,
    pm.json_package_id,
    pm.json_serial_no,
    pm.json_procedure_name,
    pm.json_system,
    pm.json_category,
    pm.package_specific_reference_codes,
    pm.shared_terms_apply,
    pm.non_admissible_expense_rules_apply,
    pm.agreement_general_clauses,
    pm.agreement_surgical_guidelines,
    coalesce(rr.room_rates_jsonb, '[]'::jsonb) as room_rates_jsonb,
    pm.fc_template_available,
    pm.fc_runtime_ready,
    pm.fc_template_status,
    pm.fc_mapping_confidence,
    pm.fc_match_method,
    pm.fc_template_package_code,
    pm.fc_template_primary_package_name,
    pm.fc_template_package_names,
    pm.fc_tariff_code,
    pm.fc_tariff_name,
    pm.fc_case_count_total,
    pm.fc_template_action,
    pm.fc_runtime_behavior,
    pm.fc_notes,
    pm.fc_alternative_candidates_jsonb,
    pm.can_generate_estimate,
    pm.can_generate_label,
    pm.runtime_status,
    pm.readiness_score,
    pm.primary_blocker,
    pm.secondary_gaps,
    pm.missing_items,
    pm.developer_action,
    pm.in_review_queue,
    pm.warning_reason,
    coalesce(al.aliases_jsonb, '[]'::jsonb) as aliases_jsonb
from fc.package_master pm
join fc.package_organization_applicability app
  on app.tariff_code = pm.tariff_code
 and app.package_code = pm.package_code
left join room_rate_summary rr
  on rr.tariff_code = pm.tariff_code
 and rr.package_code = pm.package_code
left join alias_summary al
  on al.tariff_code = pm.tariff_code
 and al.package_code = pm.package_code;

create or replace view fc.v_package_case_history as
select
    runtime.organization_cd,
    runtime.organization_name,
    runtime.tariff_code,
    runtime.package_code,
    runtime.package_name,
    count(distinct mt.admission_no) as admission_count,
    max(mt.date_of_admission) as latest_admission_at,
    min(mt.package_amount) filter (where mt.package_amount is not null) as min_observed_package_amount,
    max(mt.package_amount) filter (where mt.package_amount is not null) as max_observed_package_amount,
    jsonb_agg(
        distinct jsonb_build_object(
            'admission_no', mt.admission_no,
            'date_of_admission', mt.date_of_admission,
            'doctor_name', mt.doctor_name,
            'department_name', mt.department_name,
            'package_amount', mt.package_amount
        )
    ) filter (where mt.admission_no is not null) as sample_admissions_jsonb
from fc.v_package_runtime_lookup runtime
left join mart.main_table mt
  on upper(trim(coalesce(mt.tariff_code, ''))) = upper(trim(coalesce(runtime.tariff_code, '')))
 and upper(trim(coalesce(mt.package_code, ''))) = upper(trim(coalesce(runtime.package_code, '')))
 and (
     runtime.organization_cd is null
     or upper(trim(coalesce(mt.organization_cd, ''))) = upper(trim(coalesce(runtime.organization_cd, '')))
 )
group by
    runtime.organization_cd,
    runtime.organization_name,
    runtime.tariff_code,
    runtime.package_code,
    runtime.package_name;
"""

PACKAGE_MASTER_QUERY = """
select
    a.tariff_code,
    a.package_code,
    a.package_name,
    a.canonical_package_name,
    a.normalized_package_name,
    a.tariff_name,
    a.package_type,
    a.department_code,
    a.department_name,
    a.company_code,
    a.package_amount,
    a.package_atl_amount,
    a.pre_days,
    a.post_days,
    a.package_duration,
    a.is_active,
    a.effective_from,
    a.effective_to,
    a.equservice_code,
    a.surgery_code,
    a.is_edit_days_in_pkg_billing,
    a.source_pack,
    a.source_version,
    a.payor_bucket,
    d.documentation_available,
    d.documentation_status,
    d.has_tariff,
    d.tariff_source,
    d.tariff_information,
    d.has_inclusions,
    d.inclusion_source,
    d.inclusions_text,
    d.has_exclusions,
    d.exclusion_source,
    d.exclusions_text,
    d.documentation_family,
    d.documentation_confidence,
    d.documentation_notes,
    d.matched_room_category,
    d.json_package_code,
    d.json_package_id,
    d.json_serial_no,
    d.json_procedure_name,
    d.json_system,
    d.json_category,
    d.package_specific_reference_codes,
    d.shared_terms_apply,
    d.non_admissible_expense_rules_apply,
    d.agreement_general_clauses,
    d.agreement_surgical_guidelines,
    f.fc_template_available,
    f.fc_runtime_ready,
    f.fc_template_status,
    f.fc_mapping_confidence,
    f.fc_match_method,
    f.fc_template_package_code,
    f.fc_template_primary_package_name,
    f.fc_template_package_names,
    f.fc_tariff_code,
    f.fc_tariff_name,
    f.fc_case_count_total,
    f.fc_template_action,
    f.fc_runtime_behavior,
    f.fc_notes,
    f.fc_alternative_candidates_jsonb,
    r.can_generate_estimate,
    r.can_generate_label,
    r.runtime_status,
    r.readiness_score,
    r.primary_blocker,
    r.secondary_gaps,
    r.missing_items,
    r.developer_action,
    r.in_review_queue,
    r.warning_reason
from package_curated.v_current_package_anchor a
left join package_curated.v_current_package_documentation d
  on d.tariff_code = a.tariff_code
 and d.package_code = a.package_code
left join package_curated.v_current_package_fc_mapping f
  on f.tariff_code = a.tariff_code
 and f.package_code = a.package_code
left join package_curated.v_current_package_runtime_status r
  on r.tariff_code = a.tariff_code
 and r.package_code = a.package_code
order by a.tariff_code, a.package_code
"""

PACKAGE_ROOM_RATES_QUERY = """
select
    tariff_code,
    package_code,
    ordinal,
    room_category_code,
    room_category_label,
    amount,
    source_field,
    source_note
from package_curated.v_current_package_room_rates
order by tariff_code, package_code, ordinal
"""

PACKAGE_ALIAS_QUERY = """
select
    tariff_code,
    package_code,
    package_name,
    alias_text,
    coalesce(alias_type, '') as alias_type,
    alias_source,
    alias_confidence,
    normalized_alias_text,
    source_code,
    source_record_id,
    notes
from package_curated.v_current_package_alias
order by tariff_code, package_code, normalized_alias_text, alias_text
"""

PACKAGE_ORG_APPLICABILITY_QUERY = """
select
    coalesce(organization_cd, '') as organization_cd,
    organization_name,
    tariff_code,
    tariff_name,
    package_code,
    package_name,
    payor_bucket,
    applicability_source
from package_curated.package_organization_applicability
order by coalesce(organization_cd, ''), tariff_code, package_code
"""


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
        description="Publish the curated package layer from postgres into the clean FC handoff database."
    )
    parser.add_argument("--target-db-name", default=DEFAULT_TARGET_DB_NAME)
    parser.add_argument("--target-db-url", default=None)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def fetch_rows(conn: psycopg.Connection[Any], sql: str) -> list[dict[str, Any]]:
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(sql)
        return [dict(row) for row in cur.fetchall()]


def fetch_scalar(conn: psycopg.Connection[Any], sql: str) -> Any:
    with conn.cursor() as cur:
        cur.execute(sql)
        row = cur.fetchone()
    return row[0] if row else None


def fetch_validation_snapshot(source_conn: psycopg.Connection[Any]) -> dict[str, Any]:
    return {
        "source_anchor_count": int(fetch_scalar(source_conn, "select count(*) from package_curated.v_current_package_anchor") or 0),
        "source_runtime_count": int(fetch_scalar(source_conn, "select count(*) from package_curated.v_package_runtime_master") or 0),
        "source_doc_count": int(fetch_scalar(source_conn, "select count(*) from package_curated.v_current_package_documentation") or 0),
        "source_alias_count": int(fetch_scalar(source_conn, "select count(*) from package_curated.v_current_package_alias") or 0),
        "source_room_rate_count": int(fetch_scalar(source_conn, "select count(*) from package_curated.v_current_package_room_rates") or 0),
        "source_org_applicability_count": int(fetch_scalar(source_conn, "select count(*) from package_curated.package_organization_applicability") or 0),
        "source_tariff_codes": fetch_scalar(
            source_conn,
            "select string_agg(tariff_code, ',' order by tariff_code) from (select distinct tariff_code from package_curated.v_current_package_anchor) t",
        ),
        "source_duplicate_anchor_rows": int(
            fetch_scalar(
                source_conn,
                """
                select count(*) from (
                    select tariff_code, package_code, count(*)
                    from package_curated.v_current_package_anchor
                    group by 1, 2
                    having count(*) > 1
                ) duplicates
                """,
            )
            or 0
        ),
        "source_ambiguous_org_count": int(
            fetch_scalar(source_conn, "select count(*) from package_curated.v_package_organization_mapping_qa") or 0
        ),
    }


def ensure_target_schema(target_conn: psycopg.Connection[Any]) -> None:
    with target_conn.cursor() as cur:
        cur.execute(PACKAGE_SCHEMA_SQL)


def truncate_target_tables(target_conn: psycopg.Connection[Any]) -> None:
    with target_conn.cursor() as cur:
        cur.execute(
            """
            truncate table
                fc.package_organization_applicability,
                fc.package_alias,
                fc.package_room_rates,
                fc.package_master
            """
        )


def adapt_master_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    adapted: list[dict[str, Any]] = []
    for row in rows:
        payload = dict(row)
        payload["fc_alternative_candidates_jsonb"] = Jsonb(payload.get("fc_alternative_candidates_jsonb") or [])
        adapted.append(payload)
    return adapted


def dedupe_alias_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deduped: dict[tuple[str, str, str, str], dict[str, Any]] = {}
    for row in rows:
        key = (
            str(row.get("tariff_code") or ""),
            str(row.get("package_code") or ""),
            str(row.get("alias_text") or ""),
            str(row.get("alias_type") or ""),
        )
        deduped.setdefault(key, row)
    return list(deduped.values())


def insert_rows(target_conn: psycopg.Connection[Any], table_name: str, rows: list[dict[str, Any]], columns: list[str]) -> None:
    if not rows:
        return
    placeholders = ", ".join(f"%({column})s" for column in columns)
    sql = f"insert into {table_name} ({', '.join(columns)}) values ({placeholders})"
    with target_conn.cursor() as cur:
        cur.executemany(sql, rows)


def build_target_summary(target_conn: psycopg.Connection[Any]) -> dict[str, Any]:
    return {
        "target_package_master_count": int(fetch_scalar(target_conn, "select count(*) from fc.package_master") or 0),
        "target_package_room_rate_count": int(fetch_scalar(target_conn, "select count(*) from fc.package_room_rates") or 0),
        "target_package_alias_count": int(fetch_scalar(target_conn, "select count(*) from fc.package_alias") or 0),
        "target_package_org_applicability_count": int(
            fetch_scalar(target_conn, "select count(*) from fc.package_organization_applicability") or 0
        ),
        "target_runtime_view_count": int(fetch_scalar(target_conn, "select count(*) from fc.v_package_runtime_lookup") or 0),
        "target_case_history_view_count": int(fetch_scalar(target_conn, "select count(*) from fc.v_package_case_history") or 0),
        "target_tariff_codes": fetch_scalar(
            target_conn,
            "select string_agg(tariff_code, ',' order by tariff_code) from (select distinct tariff_code from fc.package_master) t",
        ),
        "target_duplicate_anchor_rows": int(
            fetch_scalar(
                target_conn,
                """
                select count(*) from (
                    select tariff_code, package_code, count(*)
                    from fc.package_master
                    group by 1, 2
                    having count(*) > 1
                ) duplicates
                """,
            )
            or 0
        ),
        "target_cash_org_rows": int(
            fetch_scalar(
                target_conn,
                "select count(*) from fc.package_organization_applicability where payor_bucket = 'cash' and organization_cd = ''",
            )
            or 0
        ),
        "target_non_cash_blank_org_rows": int(
            fetch_scalar(
                target_conn,
                "select count(*) from fc.package_organization_applicability where payor_bucket <> 'cash' and organization_cd = ''",
            )
            or 0
        ),
    }


def validate_publish(source_summary: dict[str, Any], target_summary: dict[str, Any]) -> None:
    if source_summary["source_duplicate_anchor_rows"] != 0:
        raise RuntimeError("Source package_curated has duplicate canonical anchors; publish halted.")
    if target_summary["target_duplicate_anchor_rows"] != 0:
        raise RuntimeError("Target fc.package_master has duplicate canonical anchors after publish.")
    if source_summary["source_anchor_count"] != target_summary["target_package_master_count"]:
        raise RuntimeError("Target package_master count does not match source anchor count.")
    if source_summary["published_alias_count"] != target_summary["target_package_alias_count"]:
        raise RuntimeError("Target package_alias count does not match source alias count.")
    if source_summary["source_room_rate_count"] != target_summary["target_package_room_rate_count"]:
        raise RuntimeError("Target package_room_rates count does not match source room-rate count.")
    if source_summary["source_org_applicability_count"] != target_summary["target_package_org_applicability_count"]:
        raise RuntimeError("Target package_organization_applicability count does not match source applicability count.")
    if target_summary["target_non_cash_blank_org_rows"] != 0:
        raise RuntimeError("Non-cash package applicability rows were published without organization_cd.")


def main() -> None:
    args = parse_args()
    source_db_url = get_source_db_url()
    resolved_target_db_url = args.target_db_url or target_db_url(args.target_db_name, source_db_url)

    with psycopg.connect(source_db_url) as source_conn:
        source_summary = fetch_validation_snapshot(source_conn)
        package_master_rows = fetch_rows(source_conn, PACKAGE_MASTER_QUERY)
        room_rate_rows = fetch_rows(source_conn, PACKAGE_ROOM_RATES_QUERY)
        raw_alias_rows = fetch_rows(source_conn, PACKAGE_ALIAS_QUERY)
        alias_rows = dedupe_alias_rows(raw_alias_rows)
        org_applicability_rows = fetch_rows(source_conn, PACKAGE_ORG_APPLICABILITY_QUERY)
    source_summary["published_alias_count"] = len(alias_rows)
    source_summary["duplicate_alias_rows_removed"] = len(raw_alias_rows) - len(alias_rows)

    dry_run_summary = {
        **source_summary,
        "package_master_rows_to_publish": len(package_master_rows),
        "package_room_rate_rows_to_publish": len(room_rate_rows),
        "package_alias_rows_to_publish": len(alias_rows),
        "package_org_applicability_rows_to_publish": len(org_applicability_rows),
        "target_db_url": resolved_target_db_url,
        "dry_run": args.dry_run,
    }
    if args.dry_run:
        print(json.dumps(dry_run_summary, indent=2, ensure_ascii=True, default=str))
        return

    with psycopg.connect(resolved_target_db_url) as target_conn:
        with target_conn.transaction():
            ensure_target_schema(target_conn)
            truncate_target_tables(target_conn)
            insert_rows(
                target_conn,
                "fc.package_master",
                adapt_master_rows(package_master_rows),
                [
                    "tariff_code",
                    "package_code",
                    "package_name",
                    "canonical_package_name",
                    "normalized_package_name",
                    "tariff_name",
                    "package_type",
                    "department_code",
                    "department_name",
                    "company_code",
                    "package_amount",
                    "package_atl_amount",
                    "pre_days",
                    "post_days",
                    "package_duration",
                    "is_active",
                    "effective_from",
                    "effective_to",
                    "equservice_code",
                    "surgery_code",
                    "is_edit_days_in_pkg_billing",
                    "source_pack",
                    "source_version",
                    "payor_bucket",
                    "documentation_available",
                    "documentation_status",
                    "has_tariff",
                    "tariff_source",
                    "tariff_information",
                    "has_inclusions",
                    "inclusion_source",
                    "inclusions_text",
                    "has_exclusions",
                    "exclusion_source",
                    "exclusions_text",
                    "documentation_family",
                    "documentation_confidence",
                    "documentation_notes",
                    "matched_room_category",
                    "json_package_code",
                    "json_package_id",
                    "json_serial_no",
                    "json_procedure_name",
                    "json_system",
                    "json_category",
                    "package_specific_reference_codes",
                    "shared_terms_apply",
                    "non_admissible_expense_rules_apply",
                    "agreement_general_clauses",
                    "agreement_surgical_guidelines",
                    "fc_template_available",
                    "fc_runtime_ready",
                    "fc_template_status",
                    "fc_mapping_confidence",
                    "fc_match_method",
                    "fc_template_package_code",
                    "fc_template_primary_package_name",
                    "fc_template_package_names",
                    "fc_tariff_code",
                    "fc_tariff_name",
                    "fc_case_count_total",
                    "fc_template_action",
                    "fc_runtime_behavior",
                    "fc_notes",
                    "fc_alternative_candidates_jsonb",
                    "can_generate_estimate",
                    "can_generate_label",
                    "runtime_status",
                    "readiness_score",
                    "primary_blocker",
                    "secondary_gaps",
                    "missing_items",
                    "developer_action",
                    "in_review_queue",
                    "warning_reason",
                ],
            )
            insert_rows(
                target_conn,
                "fc.package_room_rates",
                room_rate_rows,
                [
                    "tariff_code",
                    "package_code",
                    "ordinal",
                    "room_category_code",
                    "room_category_label",
                    "amount",
                    "source_field",
                    "source_note",
                ],
            )
            insert_rows(
                target_conn,
                "fc.package_alias",
                alias_rows,
                [
                    "tariff_code",
                    "package_code",
                    "package_name",
                    "alias_text",
                    "alias_type",
                    "alias_source",
                    "alias_confidence",
                    "normalized_alias_text",
                    "source_code",
                    "source_record_id",
                    "notes",
                ],
            )
            insert_rows(
                target_conn,
                "fc.package_organization_applicability",
                org_applicability_rows,
                [
                    "organization_cd",
                    "organization_name",
                    "tariff_code",
                    "tariff_name",
                    "package_code",
                    "package_name",
                    "payor_bucket",
                    "applicability_source",
                ],
            )
        target_summary = build_target_summary(target_conn)

    validate_publish(source_summary, target_summary)
    print(
        json.dumps(
            {
                **source_summary,
                **target_summary,
                "target_db_url": resolved_target_db_url,
                "dry_run": False,
            },
            indent=2,
            ensure_ascii=True,
            default=str,
        )
    )


if __name__ == "__main__":
    main()
