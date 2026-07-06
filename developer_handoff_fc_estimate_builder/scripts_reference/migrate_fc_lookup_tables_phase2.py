from __future__ import annotations

import argparse
import csv
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import psycopg

try:
    from scripts.etl.fc_actuals import collapse_actual_display_bucket, map_actual_service_bucket
    from scripts.export_robotic_tkr_per_ip_bucket_totals import DRUG_CLASS, IMPLANT_CLASS, SUPPLY_CLASS
except ModuleNotFoundError:  # pragma: no cover
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from scripts.etl.fc_actuals import collapse_actual_display_bucket, map_actual_service_bucket
    from scripts.export_robotic_tkr_per_ip_bucket_totals import DRUG_CLASS, IMPLANT_CLASS, SUPPLY_CLASS


DEFAULT_SOURCE_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
DEFAULT_TARGET_DB_NAME = "fc_handover_phase1"
DEFAULT_TARGET_DB_URL_TEMPLATE = "postgresql://postgres:postgres@127.0.0.1:54322/{db_name}"


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
    return DEFAULT_TARGET_DB_URL_TEMPLATE.format(db_name=target_db_name).replace(
        DEFAULT_SOURCE_DB_URL.rsplit("/", 1)[0], base
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create and load canonical FC service and pharmacy mapping lookup tables into the clean FC DB."
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


def as_bool(value: Any) -> bool:
    return normalize_text(value).lower() == "true"


def canonical_item_key(item_code: str, item_name: str, explicit_key: str = "") -> str:
    if normalize_text(explicit_key):
        return normalize_text(explicit_key)
    if normalize_code(item_code):
        return normalize_code(item_code)
    return normalize_key(item_name)


def choose_preferred_text(current: str, candidate: str) -> str:
    if normalize_text(current):
        return current
    return candidate


@dataclass
class ServiceRow:
    canonical_item_key: str
    item_code: str
    item_name: str
    fc_estimate_bucket: str
    grouping: str
    billing_head: str
    sub_head: str
    room_category_dependent: str
    mapping_source: str


@dataclass
class PharmacyRow:
    canonical_item_key: str
    item_code: str
    item_name: str
    classification: str
    fc_estimate_bucket: str
    grouping: str
    present_in_ip_pharmacy: bool
    present_in_ot_pharmacy: bool
    mapping_source: str


def service_artifact_paths() -> dict[str, Path]:
    root = repo_root()
    return {
        "mapping": root / "output" / "reference" / "service_fc_estimate_bucket_mapping.csv",
        "inventory": root / "output" / "service_inventory_all_templates.csv",
    }


def pharmacy_artifact_paths() -> dict[str, Path]:
    root = repo_root()
    return {
        "mapping": root / "output" / "reference" / "pharmacy_fc_bucket_mapping.csv",
        "inventory": root / "output" / "pharmacy_item_inventory_all_templates.csv",
    }


def derive_service_fc_bucket(item_code: str, item_name: str, raw_bucket: str) -> str:
    mapped = map_actual_service_bucket(item_code, item_name, raw_bucket)
    return collapse_actual_display_bucket(mapped)


def derive_pharmacy_fc_bucket(
    classification: str,
    *,
    present_in_ip_pharmacy: bool,
    present_in_ot_pharmacy: bool,
    distinct_ip_count_ip_pharmacy: int,
    distinct_ip_count_ot_pharmacy: int,
) -> tuple[str, str]:
    if classification == IMPLANT_CLASS:
        return "implants", "Implants"
    if classification == DRUG_CLASS:
        if present_in_ip_pharmacy and not present_in_ot_pharmacy:
            return "ip_drugs", "IP Drugs"
        if present_in_ot_pharmacy and not present_in_ip_pharmacy:
            return "ot_drugs", "OT Drugs"
        if distinct_ip_count_ot_pharmacy > distinct_ip_count_ip_pharmacy:
            return "ot_drugs", "OT Drugs"
        return "ip_drugs", "IP Drugs"
    if classification == SUPPLY_CLASS:
        if present_in_ip_pharmacy and not present_in_ot_pharmacy:
            return "ip_consumables", "IP Consumables"
        if present_in_ot_pharmacy and not present_in_ip_pharmacy:
            return "ot_consumables", "OT Consumables"
        if distinct_ip_count_ot_pharmacy > distinct_ip_count_ip_pharmacy:
            return "ot_consumables", "OT Consumables"
        return "ip_consumables", "IP Consumables"
    return "", ""


def load_service_rows() -> tuple[list[ServiceRow], dict[str, Any]]:
    paths = service_artifact_paths()
    by_code: dict[str, dict[str, str]] = {}
    by_name: dict[str, dict[str, str]] = {}
    mapping_rows: list[dict[str, str]] = []
    inventory_keys_seen: set[str] = set()
    rows_by_key: dict[str, ServiceRow] = {}
    mapping_only_keys = 0
    unmatched_inventory_keys: list[str] = []

    with paths["mapping"].open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            item_code = normalize_code(row.get("item_code"))
            item_name = normalize_text(row.get("item_name"))
            payload = {
                "item_code": item_code,
                "item_name": item_name,
                "raw_fc_estimate_bucket": normalize_text(row.get("FC_Estimate_Bucket")),
                "grouping": normalize_text(row.get("Grouping")),
            }
            mapping_rows.append(payload)
            if item_code:
                by_code[item_code] = payload
            if item_name:
                by_name[item_name] = payload

    with paths["inventory"].open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            item_code = normalize_code(row.get("item_code"))
            item_name = normalize_text(row.get("item_name"))
            key = canonical_item_key(item_code, item_name, row.get("canonical_item_key"))
            inventory_keys_seen.add(key)
            matched = by_code.get(item_code) or by_name.get(item_name)
            if not matched:
                unmatched_inventory_keys.append(key)
                continue
            rows_by_key[key] = ServiceRow(
                canonical_item_key=key,
                item_code=item_code or matched["item_code"],
                item_name=item_name or matched["item_name"],
                fc_estimate_bucket=derive_service_fc_bucket(
                    item_code or matched["item_code"],
                    item_name or matched["item_name"],
                    matched["raw_fc_estimate_bucket"],
                ),
                grouping=matched["grouping"],
                billing_head=normalize_text(row.get("observed_billing_heads")),
                sub_head=normalize_text(row.get("observed_sub_heads")),
                room_category_dependent=normalize_text(row.get("observed_room_category_dependent_values")),
                mapping_source="service_fc_estimate_bucket_mapping.csv + service_inventory_all_templates.csv",
            )

    for mapping_row in mapping_rows:
        item_code = normalize_code(mapping_row["item_code"])
        item_name = normalize_text(mapping_row["item_name"])
        key = canonical_item_key(item_code, item_name)
        if key in rows_by_key:
            existing = rows_by_key[key]
            existing.item_code = choose_preferred_text(existing.item_code, item_code)
            existing.item_name = choose_preferred_text(existing.item_name, item_name)
            continue
        mapping_only_keys += 1
        rows_by_key[key] = ServiceRow(
            canonical_item_key=key,
            item_code=item_code,
            item_name=item_name,
            fc_estimate_bucket=derive_service_fc_bucket(item_code, item_name, mapping_row["raw_fc_estimate_bucket"]),
            grouping=mapping_row["grouping"],
            billing_head="",
            sub_head="",
            room_category_dependent="",
            mapping_source="service_fc_estimate_bucket_mapping.csv",
        )

    summary = {
        "mapping_reference_rows": len(mapping_rows),
        "inventory_distinct_key_count": len(inventory_keys_seen),
        "inventory_rows_loaded": len(inventory_keys_seen) - len(set(unmatched_inventory_keys)),
        "mapping_only_rows_added": mapping_only_keys,
        "inventory_unmatched_count": len(unmatched_inventory_keys),
        "inventory_unmatched_sample": unmatched_inventory_keys[:10],
    }
    return sorted(rows_by_key.values(), key=lambda row: row.canonical_item_key), summary


def load_pharmacy_rows() -> tuple[list[PharmacyRow], dict[str, Any]]:
    paths = pharmacy_artifact_paths()
    by_code: dict[str, dict[str, str]] = {}
    by_name: dict[str, dict[str, str]] = {}
    mapping_rows: list[dict[str, str]] = []
    inventory_keys_seen: set[str] = set()
    rows_by_key: dict[str, PharmacyRow] = {}
    mapping_only_keys = 0
    unmatched_inventory_keys: list[str] = []
    mixed_context_keys: list[str] = []

    with paths["mapping"].open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            item_code = normalize_code(row.get("item_code"))
            item_name = normalize_text(row.get("item_name"))
            payload = {
                "item_code": item_code,
                "item_name": item_name,
                "classification": normalize_text(row.get("Bucket") or row.get("classification")),
            }
            mapping_rows.append(payload)
            if item_code:
                by_code[item_code] = payload
            if item_name:
                by_name[item_name] = payload

    with paths["inventory"].open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            item_code = normalize_code(row.get("item_code"))
            item_name = normalize_text(row.get("item_name"))
            key = canonical_item_key(item_code, item_name, row.get("canonical_item_key"))
            inventory_keys_seen.add(key)
            matched = by_code.get(item_code) or by_name.get(item_name)
            if not matched:
                unmatched_inventory_keys.append(key)
                continue

            present_in_ip_pharmacy = as_bool(row.get("present_in_ip_pharmacy"))
            present_in_ot_pharmacy = as_bool(row.get("present_in_ot_pharmacy"))
            distinct_ip_count_ip_pharmacy = int(normalize_text(row.get("distinct_ip_count_ip_pharmacy")) or 0)
            distinct_ip_count_ot_pharmacy = int(normalize_text(row.get("distinct_ip_count_ot_pharmacy")) or 0)
            fc_estimate_bucket, grouping = derive_pharmacy_fc_bucket(
                matched["classification"],
                present_in_ip_pharmacy=present_in_ip_pharmacy,
                present_in_ot_pharmacy=present_in_ot_pharmacy,
                distinct_ip_count_ip_pharmacy=distinct_ip_count_ip_pharmacy,
                distinct_ip_count_ot_pharmacy=distinct_ip_count_ot_pharmacy,
            )
            if present_in_ip_pharmacy and present_in_ot_pharmacy:
                mixed_context_keys.append(key)

            rows_by_key[key] = PharmacyRow(
                canonical_item_key=key,
                item_code=item_code or matched["item_code"],
                item_name=item_name or matched["item_name"],
                classification=matched["classification"],
                fc_estimate_bucket=fc_estimate_bucket,
                grouping=grouping,
                present_in_ip_pharmacy=present_in_ip_pharmacy,
                present_in_ot_pharmacy=present_in_ot_pharmacy,
                mapping_source="pharmacy_fc_bucket_mapping.csv + pharmacy_item_inventory_all_templates.csv",
            )

    for mapping_row in mapping_rows:
        item_code = normalize_code(mapping_row["item_code"])
        item_name = normalize_text(mapping_row["item_name"])
        key = canonical_item_key(item_code, item_name)
        if key in rows_by_key:
            existing = rows_by_key[key]
            existing.item_code = choose_preferred_text(existing.item_code, item_code)
            existing.item_name = choose_preferred_text(existing.item_name, item_name)
            continue
        mapping_only_keys += 1
        fc_estimate_bucket, grouping = derive_pharmacy_fc_bucket(
            mapping_row["classification"],
            present_in_ip_pharmacy=False,
            present_in_ot_pharmacy=False,
            distinct_ip_count_ip_pharmacy=0,
            distinct_ip_count_ot_pharmacy=0,
        )
        rows_by_key[key] = PharmacyRow(
            canonical_item_key=key,
            item_code=item_code,
            item_name=item_name,
            classification=mapping_row["classification"],
            fc_estimate_bucket=fc_estimate_bucket,
            grouping=grouping,
            present_in_ip_pharmacy=False,
            present_in_ot_pharmacy=False,
            mapping_source="pharmacy_fc_bucket_mapping.csv",
        )

    summary = {
        "mapping_reference_rows": len(mapping_rows),
        "inventory_distinct_key_count": len(inventory_keys_seen),
        "inventory_rows_loaded": len(inventory_keys_seen) - len(set(unmatched_inventory_keys)),
        "mapping_only_rows_added": mapping_only_keys,
        "inventory_unmatched_count": len(unmatched_inventory_keys),
        "inventory_unmatched_sample": unmatched_inventory_keys[:10],
        "mixed_ip_ot_context_count": len(mixed_context_keys),
        "mixed_ip_ot_context_sample": mixed_context_keys[:10],
    }
    return sorted(rows_by_key.values(), key=lambda row: row.canonical_item_key), summary


def ensure_target_tables(conn: psycopg.Connection[Any]) -> None:
    with conn.cursor() as cur:
        cur.execute("create schema if not exists fc")
        cur.execute(
            """
            create table if not exists fc.service_item_mapping (
                canonical_item_key text primary key,
                item_code text not null default '',
                item_name text not null default '',
                fc_estimate_bucket text not null,
                grouping text not null default '',
                billing_head text not null default '',
                sub_head text not null default '',
                room_category_dependent text not null default '',
                mapping_source text not null
            )
            """
        )
        cur.execute(
            """
            create table if not exists fc.pharmacy_item_mapping (
                canonical_item_key text primary key,
                item_code text not null default '',
                item_name text not null default '',
                classification text not null,
                fc_estimate_bucket text not null default '',
                grouping text not null default '',
                present_in_ip_pharmacy boolean not null default false,
                present_in_ot_pharmacy boolean not null default false,
                mapping_source text not null
            )
            """
        )
        cur.execute("truncate table fc.service_item_mapping")
        cur.execute("truncate table fc.pharmacy_item_mapping")
    conn.commit()


def insert_service_rows(conn: psycopg.Connection[Any], rows: list[ServiceRow]) -> None:
    with conn.cursor() as cur:
        cur.executemany(
            """
            insert into fc.service_item_mapping (
                canonical_item_key,
                item_code,
                item_name,
                fc_estimate_bucket,
                grouping,
                billing_head,
                sub_head,
                room_category_dependent,
                mapping_source
            )
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            [
                (
                    row.canonical_item_key,
                    row.item_code,
                    row.item_name,
                    row.fc_estimate_bucket,
                    row.grouping,
                    row.billing_head,
                    row.sub_head,
                    row.room_category_dependent,
                    row.mapping_source,
                )
                for row in rows
            ],
        )
    conn.commit()


def insert_pharmacy_rows(conn: psycopg.Connection[Any], rows: list[PharmacyRow]) -> None:
    with conn.cursor() as cur:
        cur.executemany(
            """
            insert into fc.pharmacy_item_mapping (
                canonical_item_key,
                item_code,
                item_name,
                classification,
                fc_estimate_bucket,
                grouping,
                present_in_ip_pharmacy,
                present_in_ot_pharmacy,
                mapping_source
            )
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            [
                (
                    row.canonical_item_key,
                    row.item_code,
                    row.item_name,
                    row.classification,
                    row.fc_estimate_bucket,
                    row.grouping,
                    row.present_in_ip_pharmacy,
                    row.present_in_ot_pharmacy,
                    row.mapping_source,
                )
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


def build_validation_summary(
    conn: psycopg.Connection[Any],
    service_rows: list[ServiceRow],
    pharmacy_rows: list[PharmacyRow],
    service_load_summary: dict[str, Any],
    pharmacy_load_summary: dict[str, Any],
) -> dict[str, Any]:
    service_missing_required = sum(
        1 for row in service_rows if not normalize_text(row.canonical_item_key) or not normalize_text(row.fc_estimate_bucket)
    )
    pharmacy_missing_required = sum(
        1 for row in pharmacy_rows if not normalize_text(row.canonical_item_key) or not normalize_text(row.classification)
    )
    pharmacy_missing_fc_bucket = sum(1 for row in pharmacy_rows if not normalize_text(row.fc_estimate_bucket))

    service_join_matches = service_load_summary["inventory_rows_loaded"]
    pharmacy_join_matches = pharmacy_load_summary["inventory_rows_loaded"]

    service_duplicate_keys = query_rows(
        conn,
        """
        select canonical_item_key, count(*)
        from fc.service_item_mapping
        group by 1
        having count(*) > 1
        order by count(*) desc, canonical_item_key
        limit 10
        """,
    )
    pharmacy_duplicate_keys = query_rows(
        conn,
        """
        select canonical_item_key, count(*)
        from fc.pharmacy_item_mapping
        group by 1
        having count(*) > 1
        order by count(*) desc, canonical_item_key
        limit 10
        """,
    )

    service_samples = query_rows(
        conn,
        """
        select canonical_item_key, item_code, item_name, fc_estimate_bucket, grouping, billing_head, sub_head
        from fc.service_item_mapping
        order by canonical_item_key
        limit 5
        """,
    )
    pharmacy_samples = query_rows(
        conn,
        """
        select canonical_item_key, item_code, item_name, classification, fc_estimate_bucket, grouping, present_in_ip_pharmacy, present_in_ot_pharmacy
        from fc.pharmacy_item_mapping
        order by canonical_item_key
        limit 5
        """,
    )

    return {
        "service": {
            "row_count": query_scalar(conn, "select count(*) from fc.service_item_mapping"),
            "missing_required_count": service_missing_required,
            "duplicate_key_count": len(service_duplicate_keys),
            "duplicate_key_sample": service_duplicate_keys,
            "join_match_count_vs_inventory": service_join_matches,
            "inventory_unmatched_count": service_load_summary["inventory_unmatched_count"],
            "inventory_unmatched_sample": service_load_summary["inventory_unmatched_sample"],
            "sample_rows": service_samples,
        },
        "pharmacy": {
            "row_count": query_scalar(conn, "select count(*) from fc.pharmacy_item_mapping"),
            "missing_required_count": pharmacy_missing_required,
            "missing_fc_estimate_bucket_count": pharmacy_missing_fc_bucket,
            "duplicate_key_count": len(pharmacy_duplicate_keys),
            "duplicate_key_sample": pharmacy_duplicate_keys,
            "join_match_count_vs_inventory": pharmacy_join_matches,
            "inventory_unmatched_count": pharmacy_load_summary["inventory_unmatched_count"],
            "inventory_unmatched_sample": pharmacy_load_summary["inventory_unmatched_sample"],
            "mixed_ip_ot_context_count": pharmacy_load_summary["mixed_ip_ot_context_count"],
            "mixed_ip_ot_context_sample": pharmacy_load_summary["mixed_ip_ot_context_sample"],
            "sample_rows": pharmacy_samples,
        },
    }


def main() -> None:
    args = parse_args()
    source_url = get_source_db_url()
    target_url = args.target_db_url or target_db_url(args.target_db_name, source_url)

    service_rows, service_load_summary = load_service_rows()
    pharmacy_rows, pharmacy_load_summary = load_pharmacy_rows()

    if args.dry_run:
        print(
            json.dumps(
                {
                    "target_db_url": target_url,
                    "service_rows": len(service_rows),
                    "service_summary": service_load_summary,
                    "pharmacy_rows": len(pharmacy_rows),
                    "pharmacy_summary": pharmacy_load_summary,
                },
                indent=2,
                ensure_ascii=True,
            )
        )
        return

    with psycopg.connect(target_url) as conn:
        ensure_target_tables(conn)
        insert_service_rows(conn, service_rows)
        insert_pharmacy_rows(conn, pharmacy_rows)
        validation_summary = build_validation_summary(
            conn,
            service_rows,
            pharmacy_rows,
            service_load_summary,
            pharmacy_load_summary,
        )

    print(
        json.dumps(
            {
                "target_db_url": target_url,
                "service_load_summary": service_load_summary,
                "pharmacy_load_summary": pharmacy_load_summary,
                "validation": validation_summary,
            },
            indent=2,
            ensure_ascii=True,
        )
    )


if __name__ == "__main__":
    main()
