from __future__ import annotations

import json
import os
import math
from pathlib import Path

import psycopg
from scripts.fc_slot_family import cath_lab_slot_order, is_cath_lab_slot_service

try:
    from scripts.etl.fc_actuals import (
        DEFAULT_PHARMACY_MAPPING,
        DEFAULT_SERVICE_MAPPING,
        FC_ACTUAL_BUCKET_ORDER,
        as_float,
        audit_mapping_coverage,
        build_cleaned_pharmacy_payloads,
        compute_fc_actual_bucket_payload,
        load_fc_actual_mappings,
    )
    from scripts.etl.fc_actual_quality import evaluate_fc_actual_quality
except ModuleNotFoundError:  # pragma: no cover
    from fc_actuals import (
        DEFAULT_PHARMACY_MAPPING,
        DEFAULT_SERVICE_MAPPING,
        FC_ACTUAL_BUCKET_ORDER,
        as_float,
        audit_mapping_coverage,
        build_cleaned_pharmacy_payloads,
        compute_fc_actual_bucket_payload,
        load_fc_actual_mappings,
    )
    from fc_actual_quality import evaluate_fc_actual_quality

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - optional convenience dependency
    def load_dotenv(*_args: object, **_kwargs: object) -> bool:
        return False


DEFAULT_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
DAYCARE_SIGNAL_SQL = """
upper(coalesce(item->>'service_code','')) in ('ROM0010', 'RNS0075')
or upper(coalesce(item->>'service_name','')) in (
    'BED CHARGES - DAYCARE',
    'BED CHARGES- DAYCARE',
    'DAYCARE CHARGES UPTO 12 HRS'
)
"""


def repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def load_env() -> None:
    load_dotenv(repo_root() / ".env")


def get_db_url() -> str:
    load_env()
    return os.getenv("SUPABASE_DB_URL", DEFAULT_DB_URL)


def connect_db() -> psycopg.Connection:
    return psycopg.connect(get_db_url())


def _normalize_text(value: object) -> str:
    return " ".join(str(value or "").strip().split())


def _is_food_or_beverage_row(item: dict[str, object]) -> bool:
    signals = [
        _normalize_text(item.get("department_name")),
        _normalize_text(item.get("service_group_name")),
        _normalize_text(item.get("service_name")),
    ]
    upper = [signal.upper() for signal in signals if signal]
    keywords = ["FOOD", "BEVERAGE", "FOOD AND BEVERAGES", "TEA", "COFFEE", "JUICE", "SOUP"]
    return any(keyword in signal for signal in upper for keyword in keywords)


def _infer_room_category(service_name: str | None, ward_name: str | None) -> str | None:
    value = f"{service_name or ''} {ward_name or ''}".upper().strip()
    if any(token in value for token in ["MICU", "SICU", "PICU", "NICU", "ICCU", "ICU"]):
        return "icu"
    if "HDU" in value:
        return "hdu"
    if "SINGLE" in value:
        return "single"
    if "TWIN" in value:
        return "twin"
    if "GENERAL" in value:
        return "general"
    if "DAY CARE" in value or "DAYCARE" in value:
        return "daycare"
    if "DELUXE" in value:
        return "deluxe"
    return None


def _derive_room_labels(services_json: list[dict[str, object]]) -> list[str]:
    raw_labels: set[str] = set()
    for item in services_json or []:
        ward_name = _normalize_text(item.get("ward_name")).upper()
        if ward_name:
            raw_labels.add(ward_name)
        inferred = _infer_room_category(
            _normalize_text(item.get("service_name")),
            _normalize_text(item.get("ward_name")),
        )
        if inferred == "icu":
            raw_labels.add("ICU")
        elif inferred == "hdu":
            raw_labels.add("HDU")
        elif inferred == "single":
            raw_labels.add("SINGLE")
        elif inferred == "twin":
            raw_labels.add("TWIN SHARING")
        elif inferred == "general":
            raw_labels.add("GENERAL WARD")
        elif inferred == "daycare":
            raw_labels.add("DAYCARE")
        elif inferred == "deluxe":
            raw_labels.add("DELUXE")
    room_precedence = [
        "MICU",
        "SICU",
        "ICCU",
        "ICU",
        "HDU",
        "EMERGENCY ROOM",
        "SINGLE",
        "DELUXE",
        "TWIN SHARING",
        "GENERAL WARD",
        "PRE/POST OPERATIVE",
        "DAYCARE",
    ]
    return sorted(
        raw_labels,
        key=lambda label: (room_precedence.index(label) if label in room_precedence else len(room_precedence), label),
    )


def _derive_primary_commercial_room_category(services_json: list[dict[str, object]]) -> str:
    labels = _derive_room_labels(services_json)
    for preferred in ["SINGLE", "DELUXE", "TWIN SHARING", "GENERAL WARD"]:
        if preferred in labels:
            return {
                "SINGLE": "Single",
                "DELUXE": "Deluxe",
                "TWIN SHARING": "Twin",
                "GENERAL WARD": "General",
            }[preferred]
    return ""


def _derive_icu_unit_name(services_json: list[dict[str, object]]) -> str:
    labels = _derive_room_labels(services_json)
    for preferred in ["SICU", "MICU", "ICCU", "ICU", "HDU"]:
        if preferred in labels:
            return preferred
    return ""


def _derive_icu_and_ward_days(services_json: list[dict[str, object]], los_days: float) -> tuple[float, float]:
    if los_days <= 0:
        return 0.0, 0.0
    total_days = max(1, int(math.ceil(los_days)))
    critical_days_observed = 0
    ward_days_observed = 0
    daycare_days_observed = 0
    for item in services_json or []:
        if _normalize_text(item.get("service_type")).upper() != "WARD CHARGES":
            continue
        room_category = _infer_room_category(
            _normalize_text(item.get("service_name")),
            _normalize_text(item.get("ward_name")),
        )
        try:
            quantity = max(float(item.get("quantity") or 0), 0)
        except (TypeError, ValueError):
            quantity = 0.0
        rounded_quantity = int(round(quantity))
        if room_category in {"icu", "hdu"}:
            critical_days_observed += rounded_quantity
        elif room_category in {"general", "single", "twin", "deluxe"}:
            ward_days_observed += rounded_quantity
        elif room_category == "daycare":
            daycare_days_observed += rounded_quantity
    icu_days = min(critical_days_observed, total_days)
    residual_days = max(total_days - icu_days - min(daycare_days_observed, max(total_days - icu_days, 0)), 0)
    ward_days = min(ward_days_observed, residual_days) if ward_days_observed > 0 else residual_days
    return float(icu_days), float(ward_days)


def _count_distinct_non_food_service_lines(services_json: list[dict[str, object]]) -> int:
    seen: set[str] = set()
    for item in services_json or []:
        if _is_food_or_beverage_row(item):
            continue
        service_code = _normalize_text(item.get("service_code")).replace(" ", "").upper()
        service_name = _normalize_text(item.get("service_name"))
        key = service_code or service_name
        if key:
            seen.add(key)
    return len(seen)


def _ensure_main_table_daycare_broad_columns(cur: psycopg.Cursor) -> None:
    cur.execute("alter table mart.main_table add column if not exists is_daycare_broad boolean")
    cur.execute("alter table mart.main_table add column if not exists daycare_broad_reason text")


def _ensure_main_table_payor_bucket_column(cur: psycopg.Cursor) -> None:
    cur.execute("alter table mart.main_table add column if not exists payor_bucket text")


def _ensure_main_table_short_stay_column(cur: psycopg.Cursor) -> None:
    cur.execute("alter table mart.main_table add column if not exists short_stay_non_daycare_ip boolean")


def _ensure_main_table_stay_audit_columns(cur: psycopg.Cursor) -> None:
    cur.execute("alter table mart.main_table add column if not exists service_line_count integer")
    cur.execute("alter table mart.main_table add column if not exists icu_days double precision")
    cur.execute("alter table mart.main_table add column if not exists ward_days double precision")
    cur.execute("alter table mart.main_table add column if not exists room_category text")
    cur.execute("alter table mart.main_table add column if not exists icu_unit_name text")


def _ensure_main_table_tariff_columns(cur: psycopg.Cursor) -> None:
    cur.execute("alter table mart.main_table add column if not exists tariff_code text")
    cur.execute("alter table mart.main_table add column if not exists tariff_name text")
    cur.execute("alter table mart.main_table add column if not exists tariff_resolution_source text")


def _ensure_main_table_fc_actual_columns(cur: psycopg.Cursor) -> None:
    cur.execute("alter table mart.main_table add column if not exists fc_actual_bucket_totals_jsonb jsonb not null default '{}'::jsonb")
    cur.execute("alter table mart.main_table add column if not exists fc_actual_total_excluding_fnb_and_returns numeric")


def _ensure_main_table_cleaned_pharmacy_columns(cur: psycopg.Cursor) -> None:
    cur.execute("alter table mart.main_table add column if not exists cleaned_pharmacy_issue_jsonb jsonb not null default '{}'::jsonb")
    cur.execute("alter table mart.main_table add column if not exists cleaned_pharmacy_returns_jsonb jsonb not null default '{}'::jsonb")
    cur.execute("alter table mart.main_table add column if not exists cleaned_pharmacy_net_jsonb jsonb not null default '{}'::jsonb")


def _ensure_main_table_fc_actual_quality_columns(cur: psycopg.Cursor) -> None:
    cur.execute("alter table mart.main_table add column if not exists fc_actual_quality_level text not null default 'ok'")
    cur.execute("alter table mart.main_table add column if not exists fc_actual_quality_flags_jsonb jsonb not null default '{}'::jsonb")


def _ensure_main_table_cash_drug_admin_columns(cur: psycopg.Cursor) -> None:
    cur.execute("alter table mart.main_table add column if not exists fc_actual_cash_drug_administration_charge numeric")
    cur.execute("alter table mart.main_table add column if not exists fc_actual_total_excluding_fnb_and_returns_plus_cash_drug_admin numeric")


def _ensure_main_table_procedure_duration_columns(cur: psycopg.Cursor) -> None:
    cur.execute("alter table mart.main_table add column if not exists derived_ot_hours numeric")
    cur.execute("alter table mart.main_table add column if not exists derived_ot_service_codes text")
    cur.execute("alter table mart.main_table add column if not exists derived_cath_lab_hours numeric")
    cur.execute("alter table mart.main_table add column if not exists derived_cath_lab_service_codes text")


def _ensure_main_table_emergency_mlc_columns(cur: psycopg.Cursor) -> None:
    cur.execute("alter table mart.main_table add column if not exists has_emergency_origin boolean not null default false")
    cur.execute("alter table mart.main_table add column if not exists has_mlc_charge boolean not null default false")
    cur.execute("alter table mart.main_table add column if not exists emergency_mlc_context_jsonb jsonb not null default '{}'::jsonb")


def _parse_ot_hours(service_name: str) -> float | None:
    text = _normalize_text(service_name)
    if not text.startswith("OT - ") or not text.endswith(" HOURS"):
        return None
    core = text.removeprefix("OT - ").removesuffix(" HOURS").strip()
    mappings = {
        "2": 2.0,
        "2 1/2": 2.5,
        "3": 3.0,
        "3 1/2": 3.5,
        "4": 4.0,
        "4 1/2": 4.5,
        "5": 5.0,
    }
    return mappings.get(core)


def _derive_ot_duration_fields(services_json: list[dict[str, object]] | None) -> tuple[float | None, str]:
    matched_codes: set[str] = set()
    derived_hours: float | None = None
    for item in services_json or []:
        if _normalize_text(item.get("service_group_name")).upper() != "OT CHARGES":
            continue
        hours = _parse_ot_hours(_normalize_text(item.get("service_name")))
        if hours is None:
            continue
        if derived_hours is None:
            derived_hours = hours
        code = _normalize_text(item.get("service_code")).replace(" ", "").upper()
        if code:
            matched_codes.add(code)
    return derived_hours, " | ".join(sorted(matched_codes))


def _derive_cath_lab_duration_fields(services_json: list[dict[str, object]] | None) -> tuple[float | None, str]:
    matched_codes: set[str] = set()
    total_hours = 0.0
    matched = False
    for item in services_json or []:
        code = _normalize_text(item.get("service_code")).replace(" ", "").upper()
        grouping = _normalize_text(item.get("service_group_name"))
        service_name = _normalize_text(item.get("service_name"))
        if not is_cath_lab_slot_service(code=code, grouping=grouping, service_name=service_name):
            continue
        matched = True
        total_hours += float(cath_lab_slot_order(code=code, service_name=service_name))
        if code:
            matched_codes.add(code)
    return (round(total_hours, 2) if matched else None), " | ".join(sorted(matched_codes))


def _build_signal_entry(
    item: dict[str, object],
    *,
    match_type: str,
) -> dict[str, object]:
    return {
        "service_code": _normalize_text(item.get("service_code")).replace(" ", "").upper(),
        "service_name": _normalize_text(item.get("service_name")),
        "match_type": match_type,
    }


def _derive_emergency_mlc_flags(services_json: list[dict[str, object]] | None) -> dict[str, object]:
    emergency_signals: list[dict[str, object]] = []
    mlc_signals: list[dict[str, object]] = []
    matched_emergency_keys: set[tuple[str, str, str]] = set()
    matched_mlc_keys: set[tuple[str, str, str]] = set()
    mlc_charge_amount = 0.0

    for item in services_json or []:
        service_code = _normalize_text(item.get("service_code")).replace(" ", "").upper()
        service_name = _normalize_text(item.get("service_name")).upper()
        service_group_name = _normalize_text(item.get("service_group_name")).upper()
        department_name = _normalize_text(item.get("department_name")).upper()
        ward_name = _normalize_text(item.get("ward_name")).upper()
        amount = round(float(as_float(item.get("amount"))), 2)

        emergency_match_type = ""
        if "ER PHYSICIAN" in service_name or "EMERGENCY ROOM" in service_name:
            emergency_match_type = "service_name"
        elif "EMERGENCY ROOM" in ward_name:
            emergency_match_type = "ward_name"
        if emergency_match_type:
            key = (service_code, service_name, emergency_match_type)
            if key not in matched_emergency_keys:
                matched_emergency_keys.add(key)
                emergency_signals.append(_build_signal_entry(item, match_type=emergency_match_type))

        mlc_match_type = ""
        if service_code == "HSP0047":
            mlc_match_type = "service_code"
        elif "MLC" in service_name:
            mlc_match_type = "service_name"
        elif "MLC" in service_group_name:
            mlc_match_type = "service_group_name"
        elif "MLC" in department_name:
            mlc_match_type = "department_name"
        if mlc_match_type:
            key = (service_code, service_name, mlc_match_type)
            if key not in matched_mlc_keys:
                matched_mlc_keys.add(key)
                mlc_signals.append(_build_signal_entry(item, match_type=mlc_match_type))
            mlc_charge_amount += amount

    return {
        "has_emergency_origin": bool(emergency_signals),
        "has_mlc_charge": bool(mlc_signals),
        "context_json": {
            "version": "v1",
            "emergency_signals": emergency_signals,
            "mlc_signals": mlc_signals,
            "summary": {
                "emergency_signal_count": len(emergency_signals),
                "mlc_signal_count": len(mlc_signals),
                "mlc_charge_amount": round(mlc_charge_amount, 2),
            },
        },
    }


def _ensure_main_table_normalized_los_columns(cur: psycopg.Cursor) -> None:
    cur.execute("alter table mart.main_table add column if not exists normalized_billable_stay_days integer")
    cur.execute("alter table mart.main_table add column if not exists normalized_billable_stay_reason text")
    cur.execute("alter table mart.main_table add column if not exists same_day_daycare_style boolean not null default false")


def _has_daycare_charge_signal(services_json: list[dict[str, object]]) -> bool:
    for item in services_json or []:
        service_code = _normalize_text(item.get("service_code")).replace(" ", "").upper()
        service_name = _normalize_text(item.get("service_name")).upper()
        if service_code in {"ROM0010", "RNS0075"}:
            return True
        if service_name in {"BED CHARGES - DAYCARE", "BED CHARGES- DAYCARE", "DAYCARE CHARGES UPTO 12 HRS"}:
            return True
    return False


def _has_room_charge_signal(services_json: list[dict[str, object]]) -> bool:
    for item in services_json or []:
        if _normalize_text(item.get("service_type")).upper() != "WARD CHARGES":
            continue
        room_category = _infer_room_category(
            _normalize_text(item.get("service_name")),
            _normalize_text(item.get("ward_name")),
        )
        if room_category in {"icu", "hdu", "general", "single", "twin", "deluxe"}:
            return True
    return False


def _classify_same_day_daycare_style(row: dict[str, object]) -> bool:
    date_of_admission = row.get("date_of_admission")
    date_of_discharge = row.get("date_of_discharge")
    los_days = row.get("los_days")
    services_json = row.get("services_json") if isinstance(row.get("services_json"), list) else []
    if date_of_admission is None or date_of_discharge is None or los_days is None:
        return False
    if date_of_admission.date() != date_of_discharge.date():
        return False
    if float(los_days) >= 1:
        return False
    if not _has_daycare_charge_signal(services_json):
        return False
    if _has_room_charge_signal(services_json):
        return False
    return True


def _compute_normalized_billable_stay_days(row: dict[str, object]) -> tuple[int | None, str, bool]:
    date_of_admission = row.get("date_of_admission")
    date_of_discharge = row.get("date_of_discharge")
    los_days_raw = row.get("los_days")
    los_days = float(los_days_raw) if los_days_raw is not None else None
    services_json = row.get("services_json") if isinstance(row.get("services_json"), list) else []
    is_daycare_broad = bool(row.get("is_daycare_broad"))

    same_day_daycare_style = _classify_same_day_daycare_style(row)
    if same_day_daycare_style:
        return 0, "same_day_daycare_fractional_los", True

    has_room_charge_signal = _has_room_charge_signal(services_json)

    if date_of_admission is None or date_of_discharge is None:
        if is_daycare_broad and los_days is not None and los_days < 1:
            return 0, "missing_dates_daycare_los_lt_1", False
        if los_days is not None and los_days > 0:
            return int(math.ceil(los_days)), "missing_dates_fallback_ceil_los", False
        return None, "missing_dates_missing_los", False

    if date_of_admission.date() == date_of_discharge.date():
        if has_room_charge_signal:
            return 1, "same_day_room_based_stay", False
        if los_days is not None and los_days >= 1:
            return 1, "same_day_ambiguous_no_room_signal", False
        return 0, "same_day_ambiguous_no_room_signal", False

    inclusive_days = (date_of_discharge.date() - date_of_admission.date()).days + 1
    normalized_days = inclusive_days
    if (date_of_admission.hour + (date_of_admission.minute / 60.0)) > 13.0:
        normalized_days -= 1
        reason = "cross_day_late_admission_adjusted"
    else:
        reason = "cross_day_inclusive"

    normalized_days = max(normalized_days, 1)
    if los_days is not None:
        floor_los = int(math.floor(los_days))
        ceil_los = int(math.ceil(los_days))
        stay_sum = float(row.get("icu_days") or 0) + float(row.get("ward_days") or 0)
        delta_vs_stay = float(normalized_days) - stay_sum
        if normalized_days not in {floor_los, ceil_los} and delta_vs_stay in {1.0, 2.0}:
            normalized_days = max(normalized_days - 1, 1)
            reason = f"{reason}_stay_aligned_minus_one"

    return normalized_days, reason, False


def _populate_main_table_daycare_broad(cur: psycopg.Cursor) -> None:
    cur.execute(
        f"""
        with classified as (
            select
                mt.main_table_key,
                mt.los_days,
                mt.date_of_admission,
                mt.date_of_discharge,
                exists (
                    select 1
                    from jsonb_array_elements(coalesce(mt.services_json::jsonb, '[]'::jsonb)) as item
                    where {DAYCARE_SIGNAL_SQL}
                ) as has_daycare_charge
            from mart.main_table mt
        ),
        resolved as (
            select
                main_table_key,
                case
                    when not has_daycare_charge then false
                    when los_days is not null and los_days <= 1 then true
                    else false
                end as is_daycare_broad,
                case
                    when not has_daycare_charge then 'no_daycare_charge'
                    when (date_of_admission is null or date_of_discharge is null) and los_days is not null and los_days <= 1
                        then 'daycare_charge_missing_dates_los_le_1'
                    when date_of_admission is null or date_of_discharge is null
                        then 'daycare_charge_missing_dates'
                    when date(date_of_admission) = date(date_of_discharge)
                        and extract(epoch from (date_of_discharge - date_of_admission)) / 3600.0 <= 12.0
                        then 'strict_same_day_upto_12h'
                    when date(date_of_admission) = date(date_of_discharge)
                        and extract(epoch from (date_of_discharge - date_of_admission)) / 3600.0 > 12.0
                        and los_days is not null and los_days <= 1
                        then 'same_day_over_12h_but_los_le_1'
                    when date(date_of_admission) <> date(date_of_discharge)
                        and los_days is not null and los_days <= 1
                        then 'crossed_calendar_day_but_los_le_1'
                    else 'daycare_charge_los_gt_1'
                end as daycare_broad_reason
            from classified
        )
        update mart.main_table mt
        set
            is_daycare_broad = resolved.is_daycare_broad,
            daycare_broad_reason = resolved.daycare_broad_reason
        from resolved
        where mt.main_table_key = resolved.main_table_key
        """
    )


def _populate_main_table_payor_bucket(cur: psycopg.Cursor) -> None:
    cur.execute(
        """
        with resolved as (
            select
                mt.main_table_key,
                case
                    when coalesce(trim(mt.organization_name), '') = 'General Patients' then 'Cash'
                    when coalesce(mt.patient_type, '') = 'Insurance'
                         and coalesce(trim(mt.organization_cd), '') in ('ORG1063', 'ORG53', 'ORG54', 'ORG55', 'ORG56')
                        then 'GIPSA Insurance'
                    when coalesce(mt.patient_type, '') = 'Insurance' then 'Non-GIPSA Insurance'
                    else 'Corporate'
                end as payor_bucket
            from mart.main_table mt
        )
        update mart.main_table mt
        set payor_bucket = resolved.payor_bucket
        from resolved
        where mt.main_table_key = resolved.main_table_key
        """
    )


def _populate_main_table_short_stay_column(cur: psycopg.Cursor) -> None:
    cur.execute(
        """
        with resolved as (
            select
                mt.main_table_key,
                case
                    when coalesce(mt.is_daycare_broad, false) is true then false
                    when mt.los_days is not null and mt.los_days < 1 then true
                    else false
                end as short_stay_non_daycare_ip
            from mart.main_table mt
        )
        update mart.main_table mt
        set short_stay_non_daycare_ip = resolved.short_stay_non_daycare_ip
        from resolved
        where mt.main_table_key = resolved.main_table_key
        """
    )


def _populate_main_table_stay_audit_fields(cur: psycopg.Cursor) -> None:
    cur.execute(
        """
        select main_table_key, los_days, services_json
        from mart.main_table
        """
    )
    updates: list[tuple[int, float, float, str, str, str]] = []
    for main_table_key, los_days, services_json in cur.fetchall():
        service_rows = services_json or []
        normalized_rows = service_rows if isinstance(service_rows, list) else []
        icu_days, ward_days = _derive_icu_and_ward_days(normalized_rows, float(los_days or 0))
        updates.append(
            (
                _count_distinct_non_food_service_lines(normalized_rows),
                icu_days,
                ward_days,
                _derive_primary_commercial_room_category(normalized_rows),
                _derive_icu_unit_name(normalized_rows),
                main_table_key,
            )
        )
    if updates:
        cur.executemany(
            """
            update mart.main_table
            set
                service_line_count = %s,
                icu_days = %s,
                ward_days = %s,
                room_category = %s,
                icu_unit_name = %s
            where main_table_key = %s
            """,
            updates,
        )


def _populate_main_table_tariff_fields(cur: psycopg.Cursor) -> None:
    cur.execute(
        """
        with org_code_unique as (
            select
                trim(organization_cd) as organization_cd,
                min(trim(tariff_cd)) as tariff_cd,
                min(trim(tariff_name)) as tariff_name
            from staging.tariff_org_map
            where upper(coalesce(priority_type, '')) = 'IPPRIORITY1'
              and nullif(trim(organization_cd), '') is not null
              and nullif(trim(tariff_cd), '') is not null
            group by trim(organization_cd)
            having count(distinct trim(tariff_cd)) = 1
        ),
        org_name_unique as (
            select
                trim(organization_name) as organization_name,
                min(trim(tariff_cd)) as tariff_cd,
                min(trim(tariff_name)) as tariff_name
            from staging.tariff_org_map
            where upper(coalesce(priority_type, '')) = 'IPPRIORITY1'
              and nullif(trim(organization_name), '') is not null
              and nullif(trim(tariff_cd), '') is not null
            group by trim(organization_name)
            having count(distinct trim(tariff_cd)) = 1
        ),
        resolved as (
            select
                mt.main_table_key,
                case
                    when coalesce(trim(mt.organization_name), '') in ('General Patients', 'GENERAL') then 'TR1'
                    when ocu.tariff_cd is not null then ocu.tariff_cd
                    when onu.tariff_cd is not null then onu.tariff_cd
                    else null
                end as tariff_code,
                case
                    when coalesce(trim(mt.organization_name), '') in ('General Patients', 'GENERAL') then 'KIMS'
                    when ocu.tariff_name is not null then ocu.tariff_name
                    when onu.tariff_name is not null then onu.tariff_name
                    else null
                end as tariff_name,
                case
                    when coalesce(trim(mt.organization_name), '') in ('General Patients', 'GENERAL') then 'default_cash_name'
                    when ocu.tariff_cd is not null then 'organization_cd_ippriority1'
                    when onu.tariff_cd is not null then 'organization_name_ippriority1'
                    else 'unresolved'
                end as tariff_resolution_source
            from mart.main_table mt
            left join org_code_unique ocu
              on trim(mt.organization_cd) = ocu.organization_cd
            left join org_name_unique onu
              on trim(mt.organization_name) = onu.organization_name
        )
        update mart.main_table mt
        set
            tariff_code = resolved.tariff_code,
            tariff_name = resolved.tariff_name,
            tariff_resolution_source = resolved.tariff_resolution_source
        from resolved
        where mt.main_table_key = resolved.main_table_key
        """
    )


def _fetch_target_main_table_rows(
    cur: psycopg.Cursor,
    admission_nos: list[str] | None = None,
    limit: int | None = None,
) -> list[dict[str, object]]:
    filters = ["complete_bill = true"]
    params: list[object] = []
    if admission_nos:
        filters.append("admission_no = any(%s)")
        params.append(admission_nos)
    where_sql = " and ".join(filters)
    limit_sql = ""
    if limit is not None:
        limit_sql = " limit %s"
        params.append(limit)
    cur.execute(
        f"""
        select
            main_table_key,
            hospital_id,
            admission_no,
            patient_name,
            coalesce(services_json, '[]'::jsonb) as services_json,
            coalesce(pharmacy_json, '{{}}'::jsonb) as pharmacy_json,
            coalesce(cleaned_pharmacy_net_jsonb, '{{}}'::jsonb) as cleaned_pharmacy_net_jsonb,
            coalesce(fc_actual_bucket_totals_jsonb, '{{}}'::jsonb) as fc_actual_bucket_totals_jsonb,
            fc_actual_total_excluding_fnb_and_returns
        from mart.main_table
        where {where_sql}
        order by admission_no
        {limit_sql}
        """,
        params,
    )
    rows: list[dict[str, object]] = []
    for (
        main_table_key,
        hospital_id,
        admission_no,
        patient_name,
        services_json,
        pharmacy_json,
        cleaned_pharmacy_net_jsonb,
        bucket_totals_jsonb,
        total_excluding_fnb_and_returns,
    ) in cur.fetchall():
        rows.append(
            {
                "main_table_key": main_table_key,
                "hospital_id": int(hospital_id),
                "admission_no": str(admission_no),
                "patient_name": _normalize_text(patient_name),
                "services_json": services_json if isinstance(services_json, list) else [],
                "pharmacy_json": pharmacy_json if isinstance(pharmacy_json, dict) else {},
                "cleaned_pharmacy_net_json": (
                    cleaned_pharmacy_net_jsonb if isinstance(cleaned_pharmacy_net_jsonb, dict) else {}
                ),
                "existing_bucket_totals": bucket_totals_jsonb if isinstance(bucket_totals_jsonb, dict) else {},
                "existing_total_excluding_fnb_and_returns": (
                    float(total_excluding_fnb_and_returns) if total_excluding_fnb_and_returns is not None else None
                ),
            }
        )
    return rows


def _fetch_stored_fc_actual_rows(
    cur: psycopg.Cursor,
    admission_nos: list[str] | None = None,
    limit: int | None = None,
) -> list[dict[str, object]]:
    filters = ["complete_bill = true"]
    params: list[object] = []
    if admission_nos:
        filters.append("admission_no = any(%s)")
        params.append(admission_nos)
    where_sql = " and ".join(filters)
    limit_sql = ""
    if limit is not None:
        limit_sql = " limit %s"
        params.append(limit)
    cur.execute(
        f"""
        select
            main_table_key,
            hospital_id,
            admission_no,
            patient_name,
            coalesce(services_json, '[]'::jsonb) as services_json,
            coalesce(pharmacy_json, '{{}}'::jsonb) as pharmacy_json,
            coalesce(cleaned_pharmacy_net_jsonb, '{{}}'::jsonb) as cleaned_pharmacy_net_jsonb,
            coalesce(fc_actual_bucket_totals_jsonb, '{{}}'::jsonb) as fc_actual_bucket_totals_jsonb,
            fc_actual_total_excluding_fnb_and_returns
        from mart.main_table
        where {where_sql}
        order by admission_no
        {limit_sql}
        """,
        params,
    )
    rows: list[dict[str, object]] = []
    for (
        main_table_key,
        hospital_id,
        admission_no,
        patient_name,
        services_json,
        pharmacy_json,
        cleaned_pharmacy_net_jsonb,
        bucket_totals_jsonb,
        total_excluding_fnb_and_returns,
    ) in cur.fetchall():
        rows.append(
            {
                "main_table_key": main_table_key,
                "hospital_id": int(hospital_id),
                "admission_no": str(admission_no),
                "patient_name": _normalize_text(patient_name),
                "services_json": services_json if isinstance(services_json, list) else [],
                "pharmacy_json": pharmacy_json if isinstance(pharmacy_json, dict) else {},
                "cleaned_pharmacy_net_json": (
                    cleaned_pharmacy_net_jsonb if isinstance(cleaned_pharmacy_net_jsonb, dict) else {}
                ),
                "stored_bucket_totals": bucket_totals_jsonb if isinstance(bucket_totals_jsonb, dict) else {},
                "stored_total_excluding_fnb_and_returns": (
                    float(total_excluding_fnb_and_returns) if total_excluding_fnb_and_returns is not None else None
                ),
            }
        )
    return rows


def _fetch_target_main_table_fc_quality_rows(
    cur: psycopg.Cursor,
    admission_nos: list[str] | None = None,
    limit: int | None = None,
) -> list[dict[str, object]]:
    filters = ["complete_bill = true"]
    params: list[object] = []
    if admission_nos:
        filters.append("admission_no = any(%s)")
        params.append(admission_nos)
    where_sql = " and ".join(filters)
    limit_sql = ""
    if limit is not None:
        limit_sql = " limit %s"
        params.append(limit)
    cur.execute(
        f"""
        select
            main_table_key,
            hospital_id,
            admission_no,
            patient_name,
            organization_name,
            payor_bucket,
            package_name,
            package_amount,
            coalesce(has_package, false) as has_package,
            coalesce(is_daycare_broad, false) as is_daycare_broad,
            los_days,
            icu_days,
            ward_days,
            room_category,
            coalesce(services_json, '[]'::jsonb) as services_json,
            coalesce(fc_actual_bucket_totals_jsonb, '{{}}'::jsonb) as fc_actual_bucket_totals_jsonb,
            fc_actual_total_excluding_fnb_and_returns,
            coalesce(fc_actual_quality_level, 'ok') as fc_actual_quality_level
        from mart.main_table
        where {where_sql}
        order by admission_no
        {limit_sql}
        """,
        params,
    )
    rows: list[dict[str, object]] = []
    for (
        main_table_key,
        hospital_id,
        admission_no,
        patient_name,
        organization_name,
        payor_bucket,
        package_name,
        package_amount,
        has_package,
        is_daycare_broad,
        los_days,
        icu_days,
        ward_days,
        room_category,
        services_json,
        bucket_totals_jsonb,
        total_excluding_fnb_and_returns,
        fc_actual_quality_level,
    ) in cur.fetchall():
        rows.append(
            {
                "main_table_key": main_table_key,
                "hospital_id": int(hospital_id),
                "admission_no": str(admission_no),
                "patient_name": _normalize_text(patient_name),
                "organization_name": _normalize_text(organization_name),
                "payor_bucket": _normalize_text(payor_bucket),
                "package_name": _normalize_text(package_name),
                "package_amount": package_amount,
                "has_package": bool(has_package),
                "is_daycare_broad": bool(is_daycare_broad),
                "los_days": float(los_days or 0),
                "icu_days": float(icu_days or 0),
                "ward_days": float(ward_days or 0),
                "room_category": _normalize_text(room_category),
                "services_json": services_json if isinstance(services_json, list) else [],
                "fc_actual_bucket_totals_jsonb": bucket_totals_jsonb if isinstance(bucket_totals_jsonb, dict) else {},
                "fc_actual_total_excluding_fnb_and_returns": float(total_excluding_fnb_and_returns or 0),
                "existing_quality_level": str(fc_actual_quality_level or "ok"),
            }
        )
    return rows


def _fetch_target_main_table_normalized_los_rows(
    cur: psycopg.Cursor,
    admission_nos: list[str] | None = None,
    limit: int | None = None,
) -> list[dict[str, object]]:
    filters = ["complete_bill = true"]
    params: list[object] = []
    if admission_nos:
        filters.append("admission_no = any(%s)")
        params.append(admission_nos)
    where_sql = " and ".join(filters)
    limit_sql = ""
    if limit is not None:
        limit_sql = " limit %s"
        params.append(limit)
    cur.execute(
        f"""
        select
            main_table_key,
            hospital_id,
            admission_no,
            patient_name,
            date_of_admission,
            date_of_discharge,
            los_days,
            coalesce(is_daycare_broad, false) as is_daycare_broad,
            coalesce(icu_days, 0) as icu_days,
            coalesce(ward_days, 0) as ward_days,
            coalesce(services_json, '[]'::jsonb) as services_json
        from mart.main_table
        where {where_sql}
        order by admission_no
        {limit_sql}
        """,
        params,
    )
    rows: list[dict[str, object]] = []
    for (
        main_table_key,
        hospital_id,
        admission_no,
        patient_name,
        date_of_admission,
        date_of_discharge,
        los_days,
        is_daycare_broad,
        icu_days,
        ward_days,
        services_json,
    ) in cur.fetchall():
        rows.append(
            {
                "main_table_key": main_table_key,
                "hospital_id": int(hospital_id),
                "admission_no": str(admission_no),
                "patient_name": _normalize_text(patient_name),
                "date_of_admission": date_of_admission,
                "date_of_discharge": date_of_discharge,
                "los_days": float(los_days) if los_days is not None else None,
                "is_daycare_broad": bool(is_daycare_broad),
                "icu_days": float(icu_days or 0),
                "ward_days": float(ward_days or 0),
                "services_json": services_json if isinstance(services_json, list) else [],
            }
        )
    return rows


def _fetch_target_main_table_procedure_duration_rows(
    cur: psycopg.Cursor,
    admission_nos: list[str] | None = None,
    limit: int | None = None,
) -> list[dict[str, object]]:
    filters = ["complete_bill = true"]
    params: list[object] = []
    if admission_nos:
        filters.append("admission_no = any(%s)")
        params.append(admission_nos)
    where_sql = " and ".join(filters)
    limit_sql = ""
    if limit is not None:
        limit_sql = " limit %s"
        params.append(limit)
    cur.execute(
        f"""
        select
            main_table_key,
            admission_no,
            patient_name,
            coalesce(services_json, '[]'::jsonb) as services_json
        from mart.main_table
        where {where_sql}
        order by admission_no
        {limit_sql}
        """,
        params,
    )
    rows: list[dict[str, object]] = []
    for main_table_key, admission_no, patient_name, services_json in cur.fetchall():
        rows.append(
            {
                "main_table_key": main_table_key,
                "admission_no": str(admission_no),
                "patient_name": _normalize_text(patient_name),
                "services_json": services_json if isinstance(services_json, list) else [],
            }
        )
    return rows


def _fetch_target_main_table_cash_drug_admin_rows(
    cur: psycopg.Cursor,
    admission_nos: list[str] | None = None,
    limit: int | None = None,
) -> list[dict[str, object]]:
    filters = ["complete_bill = true"]
    params: list[object] = []
    if admission_nos:
        filters.append("admission_no = any(%s)")
        params.append(admission_nos)
    where_sql = " and ".join(filters)
    limit_sql = ""
    if limit is not None:
        limit_sql = " limit %s"
        params.append(limit)
    cur.execute(
        f"""
        select
            main_table_key,
            admission_no,
            patient_name,
            coalesce(payor_bucket, '') as payor_bucket,
            coalesce(fc_actual_bucket_totals_jsonb, '{{}}'::jsonb) as fc_actual_bucket_totals_jsonb,
            fc_actual_total_excluding_fnb_and_returns,
            fc_actual_cash_drug_administration_charge,
            fc_actual_total_excluding_fnb_and_returns_plus_cash_drug_admin
        from mart.main_table
        where {where_sql}
        order by admission_no
        {limit_sql}
        """,
        params,
    )
    rows: list[dict[str, object]] = []
    for (
        main_table_key,
        admission_no,
        patient_name,
        payor_bucket,
        bucket_totals_jsonb,
        total_excluding_fnb_and_returns,
        existing_cash_drug_admin_charge,
        existing_adjusted_total,
    ) in cur.fetchall():
        rows.append(
            {
                "main_table_key": main_table_key,
                "admission_no": str(admission_no),
                "patient_name": _normalize_text(patient_name),
                "payor_bucket": _normalize_text(payor_bucket),
                "fc_actual_bucket_totals_jsonb": bucket_totals_jsonb if isinstance(bucket_totals_jsonb, dict) else {},
                "fc_actual_total_excluding_fnb_and_returns": float(total_excluding_fnb_and_returns or 0.0),
                "existing_fc_actual_cash_drug_administration_charge": float(existing_cash_drug_admin_charge or 0.0),
                "existing_fc_actual_total_excluding_fnb_and_returns_plus_cash_drug_admin": float(
                    existing_adjusted_total or 0.0
                ),
            }
        )
    return rows


def _fetch_target_main_table_emergency_mlc_rows(
    cur: psycopg.Cursor,
    admission_nos: list[str] | None = None,
    limit: int | None = None,
) -> list[dict[str, object]]:
    filters = ["complete_bill = true"]
    params: list[object] = []
    if admission_nos:
        filters.append("admission_no = any(%s)")
        params.append(admission_nos)
    where_sql = " and ".join(filters)
    limit_sql = ""
    if limit is not None:
        limit_sql = " limit %s"
        params.append(limit)
    cur.execute(
        f"""
        select
            main_table_key,
            admission_no,
            patient_name,
            coalesce(services_json, '[]'::jsonb) as services_json
        from mart.main_table
        where {where_sql}
        order by admission_no
        {limit_sql}
        """,
        params,
    )
    rows: list[dict[str, object]] = []
    for main_table_key, admission_no, patient_name, services_json in cur.fetchall():
        rows.append(
            {
                "main_table_key": main_table_key,
                "admission_no": str(admission_no),
                "patient_name": _normalize_text(patient_name),
                "services_json": services_json if isinstance(services_json, list) else [],
            }
        )
    return rows


def _fetch_source_rollups_by_admission(
    cur: psycopg.Cursor,
    rows: list[dict[str, object]],
) -> dict[tuple[int, str], dict[str, float]]:
    if not rows:
        return {}

    pair_placeholders = ", ".join(["(%s, %s)"] * len(rows))
    pair_params: list[object] = []
    for row in rows:
        pair_params.extend([row["hospital_id"], row["admission_no"]])

    rollups: dict[tuple[int, str], dict[str, float]] = {
        (int(row["hospital_id"]), str(row["admission_no"])): {
            "service_source_row_count": 0.0,
            "service_source_amount": 0.0,
            "issue_source_row_count": 0.0,
            "issue_source_quantity": 0.0,
            "issue_source_amount": 0.0,
            "return_source_row_count": 0.0,
            "return_source_quantity": 0.0,
            "return_source_amount": 0.0,
        }
        for row in rows
    }

    cur.execute(
        f"""
        select
            hospital_id,
            admission_no,
            count(*)::double precision as row_count,
            coalesce(sum(coalesce(amount, 0)), 0)::double precision as amount_total
        from mart_v2.admission_service_item
        where (hospital_id, admission_no) in ({pair_placeholders})
        group by hospital_id, admission_no
        """,
        pair_params,
    )
    for hospital_id, admission_no, row_count, amount_total in cur.fetchall():
        rollups[(int(hospital_id), str(admission_no))]["service_source_row_count"] = float(row_count or 0)
        rollups[(int(hospital_id), str(admission_no))]["service_source_amount"] = float(amount_total or 0)

    cur.execute(
        f"""
        select
            hospital_id,
            admission_no,
            count(*)::double precision as row_count,
            coalesce(sum(coalesce(quantity, 0)), 0)::double precision as quantity_total,
            coalesce(sum(coalesce(sale_value, 0)), 0)::double precision as amount_total
        from mart_v2.admission_pharmacy_issue
        where (hospital_id, admission_no) in ({pair_placeholders})
        group by hospital_id, admission_no
        """,
        pair_params,
    )
    for hospital_id, admission_no, row_count, quantity_total, amount_total in cur.fetchall():
        target = rollups[(int(hospital_id), str(admission_no))]
        target["issue_source_row_count"] = float(row_count or 0)
        target["issue_source_quantity"] = float(quantity_total or 0)
        target["issue_source_amount"] = float(amount_total or 0)

    cur.execute(
        f"""
        select
            hospital_id,
            admission_no,
            count(*)::double precision as row_count,
            coalesce(sum(coalesce(return_quantity, 0)), 0)::double precision as quantity_total,
            coalesce(sum(coalesce(return_amount, 0)), 0)::double precision as amount_total
        from mart_v2.pharmacy_return_billable
        where (hospital_id, admission_no) in ({pair_placeholders})
        group by hospital_id, admission_no
        """,
        pair_params,
    )
    for hospital_id, admission_no, row_count, quantity_total, amount_total in cur.fetchall():
        target = rollups[(int(hospital_id), str(admission_no))]
        target["return_source_row_count"] = float(row_count or 0)
        target["return_source_quantity"] = float(quantity_total or 0)
        target["return_source_amount"] = float(amount_total or 0)

    return rollups


def _build_fc_actual_audit_results(
    rows: list[dict[str, object]],
    source_rollups: dict[tuple[int, str], dict[str, float]],
    service_by_code: dict[str, dict[str, str]],
    service_by_name: dict[str, dict[str, str]],
    pharmacy_by_code: dict[str, dict[str, str]],
    pharmacy_by_name: dict[str, dict[str, str]],
) -> list[dict[str, object]]:
    audits: list[dict[str, object]] = []
    for row in rows:
        services_json = row["services_json"] if isinstance(row["services_json"], list) else []
        pharmacy_json = row["pharmacy_json"] if isinstance(row["pharmacy_json"], dict) else {}
        key = (int(row["hospital_id"]), str(row["admission_no"]))
        source = source_rollups.get(key, {})
        service_json_amount = sum(as_float(item.get("amount")) for item in services_json)
        issue_items = pharmacy_json.get("items", []) or []
        return_items = pharmacy_json.get("returns", []) or []
        issue_json_amount = sum(as_float(item.get("amount")) for item in issue_items)
        issue_json_quantity = sum(as_float(item.get("quantity")) for item in issue_items)
        return_json_amount = sum(as_float(item.get("return_amount")) for item in return_items)
        return_json_quantity = sum(as_float(item.get("return_quantity") or item.get("quantity")) for item in return_items)
        coverage = audit_mapping_coverage(
            services_json,
            pharmacy_json,
            service_by_code,
            service_by_name,
            pharmacy_by_code,
            pharmacy_by_name,
        )
        failed_checks: list[str] = []
        if int(source.get("service_source_row_count", 0)) != len(services_json):
            failed_checks.append("service_row_count_mismatch")
        if abs(float(source.get("service_source_amount", 0.0)) - service_json_amount) > 0.01:
            failed_checks.append("service_amount_mismatch")
        if abs(float(source.get("issue_source_quantity", 0.0)) - issue_json_quantity) > 0.01:
            failed_checks.append("pharmacy_issue_quantity_mismatch")
        if abs(float(source.get("issue_source_amount", 0.0)) - issue_json_amount) > 0.01:
            failed_checks.append("pharmacy_issue_amount_mismatch")
        if abs(float(source.get("return_source_quantity", 0.0)) - return_json_quantity) > 0.01:
            failed_checks.append("pharmacy_return_quantity_mismatch")
        if abs(float(source.get("return_source_amount", 0.0)) - return_json_amount) > 0.01:
            failed_checks.append("pharmacy_return_amount_mismatch")
        if coverage["unmapped_service_rows"]:
            failed_checks.append("unmapped_service_rows")
        if coverage["ambiguous_service_rows"]:
            failed_checks.append("ambiguous_service_rows")
        if coverage["unmapped_pharmacy_rows"]:
            failed_checks.append("unmapped_pharmacy_rows")
        if coverage["ambiguous_pharmacy_rows"]:
            failed_checks.append("ambiguous_pharmacy_rows")
        audits.append(
            {
                "hospital_id": int(row["hospital_id"]),
                "admission_no": str(row["admission_no"]),
                "patient_name": str(row["patient_name"]),
                "service_json_row_count": len(services_json),
                "service_source_row_count": int(source.get("service_source_row_count", 0)),
                "service_json_amount": service_json_amount,
                "service_source_amount": float(source.get("service_source_amount", 0.0)),
                "issue_json_row_count": len(issue_items),
                "issue_source_row_count": int(source.get("issue_source_row_count", 0)),
                "issue_json_quantity": issue_json_quantity,
                "issue_source_quantity": float(source.get("issue_source_quantity", 0.0)),
                "issue_json_amount": issue_json_amount,
                "issue_source_amount": float(source.get("issue_source_amount", 0.0)),
                "return_json_row_count": len(return_items),
                "return_source_row_count": int(source.get("return_source_row_count", 0)),
                "return_json_quantity": return_json_quantity,
                "return_source_quantity": float(source.get("return_source_quantity", 0.0)),
                "return_json_amount": return_json_amount,
                "return_source_amount": float(source.get("return_source_amount", 0.0)),
                **coverage,
                "failed_checks": failed_checks,
                "passed": not failed_checks,
            }
        )
    return audits


def _compute_fc_actual_updates(
    rows: list[dict[str, object]],
    service_by_code: dict[str, dict[str, str]],
    service_by_name: dict[str, dict[str, str]],
    pharmacy_by_code: dict[str, dict[str, str]],
    pharmacy_by_name: dict[str, dict[str, str]],
) -> list[dict[str, object]]:
    updates: list[dict[str, object]] = []
    for row in rows:
        fc_actuals = compute_fc_actual_bucket_payload(
            row["services_json"] if isinstance(row["services_json"], list) else [],
            row["pharmacy_json"] if isinstance(row["pharmacy_json"], dict) else {},
            service_by_code,
            service_by_name,
            pharmacy_by_code,
            pharmacy_by_name,
            row["cleaned_pharmacy_net_json"] if isinstance(row.get("cleaned_pharmacy_net_json"), dict) else {},
        )
        rounded_bucket_totals = {
            key: round(float(fc_actuals["bucket_totals"][key]), 2)
            for key in FC_ACTUAL_BUCKET_ORDER
        }
        rounded_bucket_totals["pharmacy_total"] = _pharmacy_total_sum(rounded_bucket_totals)
        previous_bucket_totals = row.get("existing_bucket_totals", {}) if isinstance(row.get("existing_bucket_totals"), dict) else {}
        previous_pharmacy_total = round(float(previous_bucket_totals.get("pharmacy_total") or 0.0), 2)
        previous_total = round(float(row.get("existing_total_excluding_fnb_and_returns") or 0.0), 2)
        updates.append(
            {
                "main_table_key": row["main_table_key"],
                "hospital_id": int(row["hospital_id"]),
                "admission_no": str(row["admission_no"]),
                "patient_name": str(row["patient_name"]),
                "bucket_totals": rounded_bucket_totals,
                "total_excluding_fnb_and_returns": _bucket_total_sum(rounded_bucket_totals),
                "reconciliation_delta": round(float(fc_actuals["reconciliation_delta"]), 6),
                "previous_pharmacy_total": previous_pharmacy_total,
                "corrected_pharmacy_total": rounded_bucket_totals["pharmacy_total"],
                "previous_total_excluding_fnb_and_returns": previous_total,
                "corrected_total_excluding_fnb_and_returns": _bucket_total_sum(rounded_bucket_totals),
            }
        )
    return updates


def _bucket_total_sum(bucket_totals: dict[str, object]) -> float:
    return round(
        sum(float(bucket_totals.get(key) or 0.0) for key in FC_ACTUAL_BUCKET_ORDER if key != "pharmacy_total"),
        2,
    )


def _pharmacy_total_sum(bucket_totals: dict[str, object]) -> float:
    return round(
        sum(
            float(bucket_totals.get(key) or 0.0)
            for key in ["ip_drugs", "ip_consumables", "ot_drugs", "ot_consumables", "implants"]
        ),
        2,
    )


def _derive_cleaned_pharmacy_payloads(
    pharmacy_json: dict[str, object],
    pharmacy_by_code: dict[str, dict[str, str]],
    pharmacy_by_name: dict[str, dict[str, str]],
) -> dict[str, object]:
    payloads = build_cleaned_pharmacy_payloads(
        pharmacy_json if isinstance(pharmacy_json, dict) else {},
        pharmacy_by_code,
        pharmacy_by_name,
    )
    return {
        "cleaned_pharmacy_issue_json": payloads["issue_payload"],
        "cleaned_pharmacy_returns_json": payloads["returns_payload"],
        "cleaned_pharmacy_net_json": payloads["net_payload"],
        "raw_issue_amount_total": payloads["raw_issue_amount_total"],
        "reconstructed_issue_amount_total": payloads["reconstructed_issue_amount_total"],
    }


def _validate_main_table_cleaned_pharmacy_updates(
    rows: list[dict[str, object]],
    updates: list[dict[str, object]],
    pharmacy_by_code: dict[str, dict[str, str]],
    pharmacy_by_name: dict[str, dict[str, str]],
) -> dict[str, object]:
    failures: list[dict[str, object]] = []
    for row, update in zip(rows, updates):
        issue_json = update["cleaned_pharmacy_issue_json"] if isinstance(update["cleaned_pharmacy_issue_json"], dict) else {}
        returns_json = update["cleaned_pharmacy_returns_json"] if isinstance(update["cleaned_pharmacy_returns_json"], dict) else {}
        net_json = update["cleaned_pharmacy_net_json"] if isinstance(update["cleaned_pharmacy_net_json"], dict) else {}
        issue_items = issue_json.get("items", []) or []
        return_items = returns_json.get("items", []) or []
        net_items = net_json.get("items", []) or []
        issue_summary = issue_json.get("summary", {}) or {}
        returns_summary = returns_json.get("summary", {}) or {}
        net_summary = net_json.get("summary", {}) or {}
        bucket_totals = net_summary.get("bucket_totals", {}) or {}
        mismatch_types: list[str] = []

        if round(sum(float(item.get("reconstructed_gross_amount") or 0.0) for item in issue_items), 2) != round(float(issue_summary.get("gross_amount_total") or 0.0), 2):
            mismatch_types.append("issue_summary_amount_mismatch")
        if round(sum(float(item.get("reconstructed_return_amount") or 0.0) for item in return_items), 2) != round(float(returns_summary.get("return_amount_total") or 0.0), 2):
            mismatch_types.append("returns_summary_amount_mismatch")
        if round(sum(float(item.get("net_amount") or 0.0) for item in net_items), 2) != round(float(net_summary.get("net_amount_total") or 0.0), 2):
            mismatch_types.append("net_summary_amount_mismatch")
        if round(float(bucket_totals.get("pharmacy_total") or 0.0), 2) != _pharmacy_total_sum(bucket_totals):
            mismatch_types.append("pharmacy_total_bucket_mismatch")

        recomputed = _derive_cleaned_pharmacy_payloads(row.get("pharmacy_json", {}), pharmacy_by_code, pharmacy_by_name)
        if issue_json != recomputed["cleaned_pharmacy_issue_json"]:
            mismatch_types.append("recomputed_issue_payload_mismatch")
        if returns_json != recomputed["cleaned_pharmacy_returns_json"]:
            mismatch_types.append("recomputed_returns_payload_mismatch")
        if net_json != recomputed["cleaned_pharmacy_net_json"]:
            mismatch_types.append("recomputed_net_payload_mismatch")

        if mismatch_types:
            failures.append(
                {
                    "admission_no": row["admission_no"],
                    "patient_name": row["patient_name"],
                    "mismatch_types": mismatch_types,
                }
            )

    return {
        "validated_row_count": len(rows),
        "failed_validation": bool(failures),
        "failure_count": len(failures),
        "sample_failures": failures[:10],
    }


def _summarize_cleaned_pharmacy_updates(
    rows: list[dict[str, object]],
    updates: list[dict[str, object]],
) -> dict[str, object]:
    delta_samples: list[dict[str, object]] = []
    rows_with_issue_payload = 0
    rows_with_returns_payload = 0
    rows_with_net_payload = 0
    raw_issue_amount_total = 0.0
    reconstructed_issue_amount_total = 0.0

    for row, update in zip(rows, updates):
        issue_json = update["cleaned_pharmacy_issue_json"]
        returns_json = update["cleaned_pharmacy_returns_json"]
        net_json = update["cleaned_pharmacy_net_json"]
        if (issue_json.get("items") or []):
            rows_with_issue_payload += 1
        if (returns_json.get("items") or []):
            rows_with_returns_payload += 1
        if (net_json.get("items") or []):
            rows_with_net_payload += 1
        raw_total = float(update["raw_issue_amount_total"])
        reconstructed_total = float(update["reconstructed_issue_amount_total"])
        raw_issue_amount_total += raw_total
        reconstructed_issue_amount_total += reconstructed_total
        delta_samples.append(
            {
                "admission_no": row["admission_no"],
                "patient_name": row["patient_name"],
                "raw_issue_amount_total": round(raw_total, 2),
                "reconstructed_issue_amount_total": round(reconstructed_total, 2),
                "delta": round(raw_total - reconstructed_total, 2),
                "cleaned_issue_summary": issue_json.get("summary", {}),
                "cleaned_net_summary": net_json.get("summary", {}),
            }
        )

    delta_samples.sort(key=lambda sample: abs(float(sample["delta"])), reverse=True)
    return {
        "rows_processed": len(rows),
        "rows_written": len(updates),
        "rows_with_non_empty_cleaned_issue_payload": rows_with_issue_payload,
        "rows_with_non_empty_cleaned_returns_payload": rows_with_returns_payload,
        "rows_with_non_empty_cleaned_net_payload": rows_with_net_payload,
        "gross_issue_amount_total_using_raw_amount": round(raw_issue_amount_total, 2),
        "gross_issue_amount_total_using_reconstructed_quantity_sale_rate": round(reconstructed_issue_amount_total, 2),
        "sample_largest_issue_amount_deltas": delta_samples[:10],
        "sample_corrupted_rows": [sample for sample in delta_samples if abs(float(sample["delta"])) > 1000][:5],
    }


def _validate_fc_actual_stored_values(
    cur: psycopg.Cursor,
    admission_nos: list[str] | None = None,
    limit: int | None = None,
    service_mapping_path: Path = DEFAULT_SERVICE_MAPPING,
    pharmacy_mapping_path: Path = DEFAULT_PHARMACY_MAPPING,
) -> dict[str, object]:
    rows = _fetch_stored_fc_actual_rows(cur, admission_nos=admission_nos, limit=limit)
    service_by_code, service_by_name, pharmacy_by_code, pharmacy_by_name = load_fc_actual_mappings(
        service_mapping_path,
        pharmacy_mapping_path,
    )

    total_vs_bucket_mismatch_count = 0
    pharmacy_total_mismatch_count = 0
    recomputed_vs_stored_mismatch_count = 0
    mismatches: list[dict[str, object]] = []

    for row in rows:
        stored_bucket_totals = {
            key: round(float((row["stored_bucket_totals"] or {}).get(key) or 0.0), 2)
            for key in FC_ACTUAL_BUCKET_ORDER
        }
        stored_total = row["stored_total_excluding_fnb_and_returns"]
        stored_total_rounded = round(float(stored_total or 0.0), 2)
        summed_bucket_total = _bucket_total_sum(stored_bucket_totals)
        stored_pharmacy_total = round(float(stored_bucket_totals.get("pharmacy_total") or 0.0), 2)
        summed_pharmacy_total = _pharmacy_total_sum(stored_bucket_totals)

        recomputed = compute_fc_actual_bucket_payload(
            row["services_json"] if isinstance(row["services_json"], list) else [],
            row["pharmacy_json"] if isinstance(row["pharmacy_json"], dict) else {},
            service_by_code,
            service_by_name,
            pharmacy_by_code,
            pharmacy_by_name,
            row["cleaned_pharmacy_net_json"] if isinstance(row.get("cleaned_pharmacy_net_json"), dict) else {},
        )
        recomputed_bucket_totals = {
            key: round(float(recomputed["bucket_totals"][key]), 2)
            for key in FC_ACTUAL_BUCKET_ORDER
        }
        recomputed_bucket_totals["pharmacy_total"] = _pharmacy_total_sum(recomputed_bucket_totals)
        recomputed_total = _bucket_total_sum(recomputed_bucket_totals)

        mismatch_types: list[str] = []
        if stored_total_rounded != summed_bucket_total:
            total_vs_bucket_mismatch_count += 1
            mismatch_types.append("total_vs_bucket_mismatch")
        if stored_pharmacy_total != summed_pharmacy_total:
            pharmacy_total_mismatch_count += 1
            mismatch_types.append("pharmacy_total_mismatch")
        if stored_bucket_totals != recomputed_bucket_totals or stored_total_rounded != recomputed_total:
            recomputed_vs_stored_mismatch_count += 1
            mismatch_types.append("recomputed_vs_stored_mismatch")

        if mismatch_types:
            mismatches.append(
                {
                    "admission_no": row["admission_no"],
                    "patient_name": row["patient_name"],
                    "mismatch_types": mismatch_types,
                    "stored_total": stored_total_rounded,
                    "summed_bucket_total": summed_bucket_total,
                    "recomputed_total": recomputed_total,
                    "stored_pharmacy_total": stored_pharmacy_total,
                    "summed_pharmacy_total": summed_pharmacy_total,
                    "recomputed_pharmacy_total": recomputed_bucket_totals["pharmacy_total"],
                }
            )

    return {
        "validated_row_count": len(rows),
        "total_vs_bucket_mismatch_count": total_vs_bucket_mismatch_count,
        "pharmacy_total_mismatch_count": pharmacy_total_mismatch_count,
        "recomputed_vs_stored_mismatch_count": recomputed_vs_stored_mismatch_count,
        "sample_failing_admissions": mismatches[:10],
        "failed_validation": bool(mismatches),
    }


def _populate_main_table_fc_actual_buckets(
    cur: psycopg.Cursor,
    admission_nos: list[str] | None = None,
    limit: int | None = None,
    dry_run: bool = False,
    service_mapping_path: Path = DEFAULT_SERVICE_MAPPING,
    pharmacy_mapping_path: Path = DEFAULT_PHARMACY_MAPPING,
) -> dict[str, object]:
    rows = _fetch_target_main_table_rows(cur, admission_nos=admission_nos, limit=limit)
    service_by_code, service_by_name, pharmacy_by_code, pharmacy_by_name = load_fc_actual_mappings(
        service_mapping_path,
        pharmacy_mapping_path,
    )
    source_rollups = _fetch_source_rollups_by_admission(cur, rows)
    audits = _build_fc_actual_audit_results(
        rows,
        source_rollups,
        service_by_code,
        service_by_name,
        pharmacy_by_code,
        pharmacy_by_name,
    )
    failed_audits = [audit for audit in audits if not audit["passed"]]
    if failed_audits:
        raise RuntimeError(
            "FC actual audit failed for admissions: "
            + json.dumps(
                [
                    {
                        "admission_no": audit["admission_no"],
                        "failed_checks": audit["failed_checks"],
                        "unmapped_service_rows": audit["unmapped_service_rows"][:5],
                        "unmapped_pharmacy_rows": audit["unmapped_pharmacy_rows"][:5],
                    }
                    for audit in failed_audits[:10]
                ],
                indent=2,
            )
        )

    updates = _compute_fc_actual_updates(
        rows,
        service_by_code,
        service_by_name,
        pharmacy_by_code,
        pharmacy_by_name,
    )
    if not dry_run and updates:
        cur.executemany(
            """
            update mart.main_table
            set
                fc_actual_bucket_totals_jsonb = %s::jsonb,
                fc_actual_total_excluding_fnb_and_returns = %s
            where main_table_key = %s
            """,
            [
                (
                    json.dumps(update["bucket_totals"]),
                    update["total_excluding_fnb_and_returns"],
                    update["main_table_key"],
                )
                for update in updates
            ],
        )
    reconciliation_values = [abs(float(update["reconciliation_delta"])) for update in updates]
    changed_pharmacy_rows: list[dict[str, object]] = []
    changed_total_rows: list[dict[str, object]] = []
    max_abs_pharmacy_delta = 0.0
    max_abs_total_delta = 0.0
    for update in updates:
        previous_pharmacy_total = round(float(update.get("previous_pharmacy_total") or 0.0), 2)
        corrected_pharmacy_total = round(float(update.get("corrected_pharmacy_total") or 0.0), 2)
        previous_total = round(float(update.get("previous_total_excluding_fnb_and_returns") or 0.0), 2)
        corrected_total = round(float(update.get("corrected_total_excluding_fnb_and_returns") or 0.0), 2)
        if previous_pharmacy_total != corrected_pharmacy_total:
            changed_pharmacy_rows.append(update)
        if previous_total != corrected_total:
            changed_total_rows.append(update)
        max_abs_pharmacy_delta = max(max_abs_pharmacy_delta, abs(corrected_pharmacy_total - previous_pharmacy_total))
        max_abs_total_delta = max(max_abs_total_delta, abs(corrected_total - previous_total))
    correction_samples = [
        {
            "admission_no": str(update["admission_no"]),
            "patient_name": str(update["patient_name"]),
            "old_pharmacy_total": round(float(update.get("previous_pharmacy_total") or 0.0), 2),
            "cleaned_pharmacy_total_used": round(float(update.get("corrected_pharmacy_total") or 0.0), 2),
            "pharmacy_delta": round(
                float(update.get("corrected_pharmacy_total") or 0.0) - float(update.get("previous_pharmacy_total") or 0.0),
                2,
            ),
            "old_total": round(float(update.get("previous_total_excluding_fnb_and_returns") or 0.0), 2),
            "corrected_total": round(float(update.get("corrected_total_excluding_fnb_and_returns") or 0.0), 2),
            "total_delta": round(
                float(update.get("corrected_total_excluding_fnb_and_returns") or 0.0)
                - float(update.get("previous_total_excluding_fnb_and_returns") or 0.0),
                2,
            ),
        }
        for update in updates
    ]
    correction_samples.sort(
        key=lambda sample: abs(float(sample["pharmacy_delta"])) + abs(float(sample["total_delta"])),
        reverse=True,
    )
    return {
        "row_count": len(rows),
        "rows_processed": len(rows),
        "rows_written": 0 if dry_run else len(updates),
        "rows_skipped": 0,
        "failed_audit_count": len(failed_audits),
        "failed_admissions": [audit["admission_no"] for audit in failed_audits],
        "unmapped_service_row_count": sum(len(audit["unmapped_service_rows"]) for audit in audits),
        "unmapped_pharmacy_row_count": sum(len(audit["unmapped_pharmacy_rows"]) for audit in audits),
        "ambiguous_service_row_count": sum(len(audit["ambiguous_service_rows"]) for audit in audits),
        "ambiguous_pharmacy_row_count": sum(len(audit["ambiguous_pharmacy_rows"]) for audit in audits),
        "mean_abs_reconciliation_delta": (
            round(sum(reconciliation_values) / len(reconciliation_values), 6)
            if reconciliation_values
            else 0.0
        ),
        "max_abs_reconciliation_delta": round(max(reconciliation_values), 6) if reconciliation_values else 0.0,
        "rows_with_changed_pharmacy_totals": len(changed_pharmacy_rows),
        "rows_with_changed_base_totals": len(changed_total_rows),
        "max_abs_pharmacy_delta": round(max_abs_pharmacy_delta, 2),
        "max_abs_total_delta": round(max_abs_total_delta, 2),
        "sample_largest_corrections": correction_samples[:10],
        "audit_results": audits,
        "updates": updates,
    }


def _summarize_fc_actual_quality_updates(
    rows: list[dict[str, object]],
    updates: list[dict[str, object]],
) -> dict[str, object]:
    counts_by_level: dict[str, int] = {}
    counts_by_rule: dict[str, int] = {}
    sample_by_rule: dict[str, list[dict[str, object]]] = {}

    for update in updates:
        level = str(update["quality_level"])
        counts_by_level[level] = counts_by_level.get(level, 0) + 1
        quality_flags = update["quality_flags_json"]
        rules = quality_flags.get("rules", []) if isinstance(quality_flags, dict) else []
        for rule in rules:
            code = str(rule.get("code") or "")
            if not code:
                continue
            counts_by_rule[code] = counts_by_rule.get(code, 0) + 1
            bucket = sample_by_rule.setdefault(code, [])
            if len(bucket) < 3:
                bucket.append(
                    {
                        "admission_no": update["admission_no"],
                        "patient_name": update["patient_name"],
                        "quality_level": level,
                        "rule": rule,
                    }
                )

    return {
        "row_count": len(rows),
        "rows_processed": len(rows),
        "rows_written": len(updates),
        "quality_level_change_count": sum(
            1
            for row, update in zip(rows, updates)
            if str(update["quality_level"]) != str(row.get("existing_quality_level") or "ok")
        ),
        "counts_by_level": counts_by_level,
        "counts_by_rule": counts_by_rule,
        "sample_by_rule": sample_by_rule,
    }


def _summarize_normalized_los_updates(
    rows: list[dict[str, object]],
    updates: list[dict[str, object]],
) -> dict[str, object]:
    counts_by_reason: dict[str, int] = {}
    same_day_daycare_style_count = 0
    zero_count = 0
    one_count = 0
    matches_ceil_los_count = 0
    matches_stay_sum_count = 0
    stay_sum_shortfall_count = 0

    for row, update in zip(rows, updates):
        reason = str(update["normalized_billable_stay_reason"])
        counts_by_reason[reason] = counts_by_reason.get(reason, 0) + 1
        normalized_days = update["normalized_billable_stay_days"]
        if update["same_day_daycare_style"]:
            same_day_daycare_style_count += 1
        if normalized_days == 0:
            zero_count += 1
        if normalized_days == 1:
            one_count += 1
        los_days = row.get("los_days")
        if normalized_days is not None and los_days is not None and normalized_days == int(math.ceil(float(los_days))):
            matches_ceil_los_count += 1
        stay_sum = int(round(float(row.get("icu_days") or 0) + float(row.get("ward_days") or 0)))
        if normalized_days is not None and normalized_days == stay_sum:
            matches_stay_sum_count += 1
        if normalized_days is not None and normalized_days > stay_sum:
            stay_sum_shortfall_count += 1

    return {
        "row_count": len(rows),
        "rows_processed": len(rows),
        "rows_written": len(updates),
        "counts_by_reason": counts_by_reason,
        "zero_day_count": zero_count,
        "one_day_count": one_count,
        "same_day_daycare_style_count": same_day_daycare_style_count,
        "comparison_counts": {
            "normalized_equals_ceil_los_count": matches_ceil_los_count,
            "normalized_equals_icu_plus_ward_count": matches_stay_sum_count,
            "normalized_gt_icu_plus_ward_count": stay_sum_shortfall_count,
        },
    }


def _summarize_procedure_duration_updates(
    rows: list[dict[str, object]],
    updates: list[dict[str, object]],
) -> dict[str, object]:
    ot_populated = 0
    cath_populated = 0
    ot_blank_codes: list[dict[str, object]] = []
    cath_blank_codes: list[dict[str, object]] = []
    ot_combo_counts: dict[str, int] = {}
    cath_combo_counts: dict[str, int] = {}
    multiple_ot_examples: list[dict[str, object]] = []
    multiple_cath_examples: list[dict[str, object]] = []

    for row, update in zip(rows, updates):
        ot_hours = update["derived_ot_hours"]
        ot_codes = update["derived_ot_service_codes"]
        cath_hours = update["derived_cath_lab_hours"]
        cath_codes = update["derived_cath_lab_service_codes"]
        if ot_hours is not None:
            ot_populated += 1
            ot_combo_counts[ot_codes] = ot_combo_counts.get(ot_codes, 0) + 1
            if not ot_codes and len(ot_blank_codes) < 10:
                ot_blank_codes.append(
                    {"admission_no": row["admission_no"], "patient_name": row["patient_name"], "derived_ot_hours": ot_hours}
                )
            if ot_codes and " | " in ot_codes and len(multiple_ot_examples) < 10:
                multiple_ot_examples.append(
                    {
                        "admission_no": row["admission_no"],
                        "patient_name": row["patient_name"],
                        "derived_ot_hours": ot_hours,
                        "derived_ot_service_codes": ot_codes,
                    }
                )
        if cath_hours is not None:
            cath_populated += 1
            cath_combo_counts[cath_codes] = cath_combo_counts.get(cath_codes, 0) + 1
            if not cath_codes and len(cath_blank_codes) < 10:
                cath_blank_codes.append(
                    {
                        "admission_no": row["admission_no"],
                        "patient_name": row["patient_name"],
                        "derived_cath_lab_hours": cath_hours,
                    }
                )
            if cath_codes and " | " in cath_codes and len(multiple_cath_examples) < 10:
                multiple_cath_examples.append(
                    {
                        "admission_no": row["admission_no"],
                        "patient_name": row["patient_name"],
                        "derived_cath_lab_hours": cath_hours,
                        "derived_cath_lab_service_codes": cath_codes,
                    }
                )

    return {
        "row_count": len(rows),
        "rows_processed": len(rows),
        "rows_written": len(updates),
        "rows_with_non_null_derived_ot_hours": ot_populated,
        "rows_with_non_null_derived_cath_lab_hours": cath_populated,
        "top_ot_service_code_combinations": sorted(ot_combo_counts.items(), key=lambda item: (-item[1], item[0]))[:10],
        "top_cath_lab_service_code_combinations": sorted(cath_combo_counts.items(), key=lambda item: (-item[1], item[0]))[:10],
        "sample_ot_hours_with_blank_code_list": ot_blank_codes,
        "sample_cath_lab_hours_with_blank_code_list": cath_blank_codes,
        "sample_multiple_ot_hour_candidates": multiple_ot_examples,
        "sample_multiple_cath_lab_codes": multiple_cath_examples,
    }


def _summarize_emergency_mlc_updates(
    rows: list[dict[str, object]],
    updates: list[dict[str, object]],
) -> dict[str, object]:
    emergency_count = 0
    mlc_count = 0
    both_count = 0
    mlc_without_emergency_count = 0
    top_emergency_codes: dict[str, int] = {}
    top_emergency_names: dict[str, int] = {}
    top_mlc_codes: dict[str, int] = {}
    top_mlc_names: dict[str, int] = {}
    sample_payloads: list[dict[str, object]] = []

    for row, update in zip(rows, updates):
        if update["has_emergency_origin"]:
            emergency_count += 1
        if update["has_mlc_charge"]:
            mlc_count += 1
        if update["has_emergency_origin"] and update["has_mlc_charge"]:
            both_count += 1
        if update["has_mlc_charge"] and not update["has_emergency_origin"]:
            mlc_without_emergency_count += 1

        context_json = update["emergency_mlc_context_json"]
        for signal in context_json.get("emergency_signals", []):
            code = str(signal.get("service_code") or "")
            name = str(signal.get("service_name") or "")
            if code:
                top_emergency_codes[code] = top_emergency_codes.get(code, 0) + 1
            if name:
                top_emergency_names[name] = top_emergency_names.get(name, 0) + 1
        for signal in context_json.get("mlc_signals", []):
            code = str(signal.get("service_code") or "")
            name = str(signal.get("service_name") or "")
            if code:
                top_mlc_codes[code] = top_mlc_codes.get(code, 0) + 1
            if name:
                top_mlc_names[name] = top_mlc_names.get(name, 0) + 1

        if (update["has_emergency_origin"] or update["has_mlc_charge"]) and len(sample_payloads) < 10:
            sample_payloads.append(
                {
                    "admission_no": row["admission_no"],
                    "patient_name": row["patient_name"],
                    "has_emergency_origin": update["has_emergency_origin"],
                    "has_mlc_charge": update["has_mlc_charge"],
                    "emergency_mlc_context_json": context_json,
                }
            )

    return {
        "row_count": len(rows),
        "rows_processed": len(rows),
        "rows_written": len(updates),
        "has_emergency_origin_count": emergency_count,
        "has_mlc_charge_count": mlc_count,
        "both_flags_count": both_count,
        "mlc_without_emergency_count": mlc_without_emergency_count,
        "top_emergency_signal_service_codes": sorted(top_emergency_codes.items(), key=lambda item: (-item[1], item[0]))[:10],
        "top_emergency_signal_service_names": sorted(top_emergency_names.items(), key=lambda item: (-item[1], item[0]))[:10],
        "top_mlc_signal_service_codes": sorted(top_mlc_codes.items(), key=lambda item: (-item[1], item[0]))[:10],
        "top_mlc_signal_service_names": sorted(top_mlc_names.items(), key=lambda item: (-item[1], item[0]))[:10],
        "sample_audit_payloads": sample_payloads,
    }


def _summarize_cash_drug_admin_updates(
    rows: list[dict[str, object]],
    updates: list[dict[str, object]],
) -> dict[str, object]:
    cash_row_count = 0
    non_cash_row_count = 0
    non_zero_drug_admin_count = 0
    changed_drug_admin_count = 0
    cash_drug_admin_amounts: list[float] = []
    sample_cash_admissions: list[dict[str, object]] = []

    for row, update in zip(rows, updates):
        is_cash = str(row["payor_bucket"]) == "Cash"
        if is_cash:
            cash_row_count += 1
            cash_drug_admin_amounts.append(float(update["fc_actual_cash_drug_administration_charge"]))
            if len(sample_cash_admissions) < 10:
                bucket_totals = row["fc_actual_bucket_totals_jsonb"]
                sample_cash_admissions.append(
                    {
                        "admission_no": row["admission_no"],
                        "patient_name": row["patient_name"],
                        "pharmacy_total": round(float(bucket_totals.get("pharmacy_total") or 0.0), 2),
                        "base_total": round(float(row["fc_actual_total_excluding_fnb_and_returns"] or 0.0), 2),
                        "drug_admin": update["fc_actual_cash_drug_administration_charge"],
                        "adjusted_total": update["fc_actual_total_excluding_fnb_and_returns_plus_cash_drug_admin"],
                    }
                )
        else:
            non_cash_row_count += 1
        if float(update["fc_actual_cash_drug_administration_charge"]) != 0.0:
            non_zero_drug_admin_count += 1
        if (
            round(float(update["fc_actual_cash_drug_administration_charge"]), 2)
            != round(float(row.get("existing_fc_actual_cash_drug_administration_charge") or 0.0), 2)
            or round(float(update["fc_actual_total_excluding_fnb_and_returns_plus_cash_drug_admin"]), 2)
            != round(
                float(row.get("existing_fc_actual_total_excluding_fnb_and_returns_plus_cash_drug_admin") or 0.0),
                2,
            )
        ):
            changed_drug_admin_count += 1

    return {
        "row_count": len(rows),
        "rows_processed": len(rows),
        "rows_written": len(updates),
        "cash_row_count": cash_row_count,
        "non_cash_row_count": non_cash_row_count,
        "non_zero_drug_admin_count": non_zero_drug_admin_count,
        "changed_drug_admin_count": changed_drug_admin_count,
        "mean_cash_drug_admin_charge": (
            round(sum(cash_drug_admin_amounts) / len(cash_drug_admin_amounts), 2)
            if cash_drug_admin_amounts
            else 0.0
        ),
        "max_cash_drug_admin_charge": round(max(cash_drug_admin_amounts), 2) if cash_drug_admin_amounts else 0.0,
        "sample_cash_admissions": sample_cash_admissions,
    }


def _validate_main_table_procedure_duration_updates(
    rows: list[dict[str, object]],
    updates: list[dict[str, object]],
) -> dict[str, object]:
    failures: list[dict[str, object]] = []
    for row, update in zip(rows, updates):
        recomputed_ot_hours, recomputed_ot_codes = _derive_ot_duration_fields(row["services_json"])
        recomputed_cath_hours, recomputed_cath_codes = _derive_cath_lab_duration_fields(row["services_json"])
        mismatch_types: list[str] = []
        if update["derived_ot_hours"] != recomputed_ot_hours:
            mismatch_types.append("ot_hours_mismatch")
        if update["derived_ot_service_codes"] != recomputed_ot_codes:
            mismatch_types.append("ot_codes_mismatch")
        if update["derived_cath_lab_hours"] != recomputed_cath_hours:
            mismatch_types.append("cath_lab_hours_mismatch")
        if update["derived_cath_lab_service_codes"] != recomputed_cath_codes:
            mismatch_types.append("cath_lab_codes_mismatch")
        if update["derived_ot_service_codes"]:
            ot_codes = update["derived_ot_service_codes"].split(" | ")
            if ot_codes != sorted(set(ot_codes)):
                mismatch_types.append("ot_codes_not_distinct_sorted")
        if update["derived_cath_lab_service_codes"]:
            cath_codes = update["derived_cath_lab_service_codes"].split(" | ")
            if cath_codes != sorted(set(cath_codes)):
                mismatch_types.append("cath_lab_codes_not_distinct_sorted")
        if mismatch_types:
            failures.append(
                {
                    "admission_no": row["admission_no"],
                    "patient_name": row["patient_name"],
                    "mismatch_types": mismatch_types,
                }
            )
    return {
        "validated_row_count": len(rows),
        "failed_validation": bool(failures),
        "failure_count": len(failures),
        "sample_failures": failures[:10],
    }


def _validate_main_table_cash_drug_admin_updates(
    rows: list[dict[str, object]],
    updates: list[dict[str, object]],
) -> dict[str, object]:
    failures: list[dict[str, object]] = []
    for row, update in zip(rows, updates):
        bucket_totals = row["fc_actual_bucket_totals_jsonb"]
        pharmacy_total = round(float(bucket_totals.get("pharmacy_total") or 0.0), 2)
        base_total = round(float(row["fc_actual_total_excluding_fnb_and_returns"] or 0.0), 2)
        is_cash = str(row["payor_bucket"]) == "Cash"
        expected_drug_admin = round(0.125 * pharmacy_total, 2) if is_cash else 0.0
        expected_adjusted_total = round(base_total + expected_drug_admin, 2) if is_cash else base_total
        mismatch_types: list[str] = []
        if round(float(update["fc_actual_cash_drug_administration_charge"]), 2) != expected_drug_admin:
            mismatch_types.append("drug_admin_mismatch")
        if round(float(update["fc_actual_total_excluding_fnb_and_returns_plus_cash_drug_admin"]), 2) != expected_adjusted_total:
            mismatch_types.append("adjusted_total_mismatch")
        if not is_cash and round(float(update["fc_actual_cash_drug_administration_charge"]), 2) != 0.0:
            mismatch_types.append("non_cash_non_zero_drug_admin")
        if mismatch_types:
            failures.append(
                {
                    "admission_no": row["admission_no"],
                    "patient_name": row["patient_name"],
                    "mismatch_types": mismatch_types,
                }
            )
    return {
        "validated_row_count": len(rows),
        "failed_validation": bool(failures),
        "failure_count": len(failures),
        "sample_failures": failures[:10],
    }


def _validate_main_table_emergency_mlc_updates(
    rows: list[dict[str, object]],
    updates: list[dict[str, object]],
) -> dict[str, object]:
    failures: list[dict[str, object]] = []
    for row, update in zip(rows, updates):
        recomputed = _derive_emergency_mlc_flags(row["services_json"])
        context_json = update["emergency_mlc_context_json"]
        mismatch_types: list[str] = []
        if update["has_emergency_origin"] and not context_json.get("emergency_signals"):
            mismatch_types.append("emergency_flag_missing_signals")
        if update["has_mlc_charge"] and not context_json.get("mlc_signals"):
            mismatch_types.append("mlc_flag_missing_signals")
        if update["has_emergency_origin"] != recomputed["has_emergency_origin"]:
            mismatch_types.append("emergency_flag_mismatch")
        if update["has_mlc_charge"] != recomputed["has_mlc_charge"]:
            mismatch_types.append("mlc_flag_mismatch")
        if context_json != recomputed["context_json"]:
            mismatch_types.append("context_json_mismatch")
        if mismatch_types:
            failures.append(
                {
                    "admission_no": row["admission_no"],
                    "patient_name": row["patient_name"],
                    "mismatch_types": mismatch_types,
                }
            )

    return {
        "validated_row_count": len(rows),
        "failed_validation": bool(failures),
        "failure_count": len(failures),
        "sample_failures": failures[:10],
    }


def _populate_main_table_procedure_duration_fields(
    cur: psycopg.Cursor,
    admission_nos: list[str] | None = None,
    limit: int | None = None,
    dry_run: bool = False,
) -> dict[str, object]:
    rows = _fetch_target_main_table_procedure_duration_rows(cur, admission_nos=admission_nos, limit=limit)
    updates: list[dict[str, object]] = []
    for row in rows:
        derived_ot_hours, derived_ot_codes = _derive_ot_duration_fields(row["services_json"])
        derived_cath_hours, derived_cath_codes = _derive_cath_lab_duration_fields(row["services_json"])
        updates.append(
            {
                "main_table_key": row["main_table_key"],
                "admission_no": row["admission_no"],
                "patient_name": row["patient_name"],
                "derived_ot_hours": derived_ot_hours,
                "derived_ot_service_codes": derived_ot_codes,
                "derived_cath_lab_hours": derived_cath_hours,
                "derived_cath_lab_service_codes": derived_cath_codes,
            }
        )

    validation = _validate_main_table_procedure_duration_updates(rows, updates)
    if validation["failed_validation"]:
        raise RuntimeError("Procedure duration validation failed: " + json.dumps(validation["sample_failures"], indent=2))

    if not dry_run and updates:
        cur.executemany(
            """
            update mart.main_table
            set
                derived_ot_hours = %s,
                derived_ot_service_codes = %s,
                derived_cath_lab_hours = %s,
                derived_cath_lab_service_codes = %s
            where main_table_key = %s
            """,
            [
                (
                    update["derived_ot_hours"],
                    update["derived_ot_service_codes"],
                    update["derived_cath_lab_hours"],
                    update["derived_cath_lab_service_codes"],
                    update["main_table_key"],
                )
                for update in updates
            ],
        )

    summary = _summarize_procedure_duration_updates(rows, updates)
    summary["validation"] = validation
    if dry_run:
        summary["rows_written"] = 0
    if len(updates) <= 50:
        summary["updates"] = updates
    else:
        summary["sample_updates"] = updates[:20]
    return summary


def _populate_main_table_emergency_mlc_flags(
    cur: psycopg.Cursor,
    admission_nos: list[str] | None = None,
    limit: int | None = None,
    dry_run: bool = False,
) -> dict[str, object]:
    rows = _fetch_target_main_table_emergency_mlc_rows(cur, admission_nos=admission_nos, limit=limit)
    updates: list[dict[str, object]] = []
    for row in rows:
        derived = _derive_emergency_mlc_flags(row["services_json"])
        updates.append(
            {
                "main_table_key": row["main_table_key"],
                "admission_no": row["admission_no"],
                "patient_name": row["patient_name"],
                "has_emergency_origin": derived["has_emergency_origin"],
                "has_mlc_charge": derived["has_mlc_charge"],
                "emergency_mlc_context_json": derived["context_json"],
            }
        )

    validation = _validate_main_table_emergency_mlc_updates(rows, updates)
    if validation["failed_validation"]:
        raise RuntimeError("Emergency/MLC validation failed: " + json.dumps(validation["sample_failures"], indent=2))

    if not dry_run and updates:
        cur.executemany(
            """
            update mart.main_table
            set
                has_emergency_origin = %s,
                has_mlc_charge = %s,
                emergency_mlc_context_jsonb = %s::jsonb
            where main_table_key = %s
            """,
            [
                (
                    update["has_emergency_origin"],
                    update["has_mlc_charge"],
                    json.dumps(update["emergency_mlc_context_json"]),
                    update["main_table_key"],
                )
                for update in updates
            ],
        )

    summary = _summarize_emergency_mlc_updates(rows, updates)
    summary["validation"] = validation
    if dry_run:
        summary["rows_written"] = 0
    if len(updates) <= 50:
        summary["updates"] = updates
    else:
        summary["sample_updates"] = updates[:20]
    return summary


def _populate_main_table_cash_drug_admin_fields(
    cur: psycopg.Cursor,
    admission_nos: list[str] | None = None,
    limit: int | None = None,
    dry_run: bool = False,
) -> dict[str, object]:
    rows = _fetch_target_main_table_cash_drug_admin_rows(cur, admission_nos=admission_nos, limit=limit)
    updates: list[dict[str, object]] = []
    for row in rows:
        bucket_totals = row["fc_actual_bucket_totals_jsonb"]
        pharmacy_total = round(float(bucket_totals.get("pharmacy_total") or 0.0), 2)
        base_total = round(float(row["fc_actual_total_excluding_fnb_and_returns"] or 0.0), 2)
        is_cash = str(row["payor_bucket"]) == "Cash"
        drug_admin = round(0.125 * pharmacy_total, 2) if is_cash else 0.0
        adjusted_total = round(base_total + drug_admin, 2) if is_cash else base_total
        updates.append(
            {
                "main_table_key": row["main_table_key"],
                "admission_no": row["admission_no"],
                "patient_name": row["patient_name"],
                "fc_actual_cash_drug_administration_charge": drug_admin,
                "fc_actual_total_excluding_fnb_and_returns_plus_cash_drug_admin": adjusted_total,
            }
        )

    validation = _validate_main_table_cash_drug_admin_updates(rows, updates)
    if validation["failed_validation"]:
        raise RuntimeError("Cash drug admin validation failed: " + json.dumps(validation["sample_failures"], indent=2))

    if not dry_run and updates:
        cur.executemany(
            """
            update mart.main_table
            set
                fc_actual_cash_drug_administration_charge = %s,
                fc_actual_total_excluding_fnb_and_returns_plus_cash_drug_admin = %s
            where main_table_key = %s
            """,
            [
                (
                    update["fc_actual_cash_drug_administration_charge"],
                    update["fc_actual_total_excluding_fnb_and_returns_plus_cash_drug_admin"],
                    update["main_table_key"],
                )
                for update in updates
            ],
        )

    summary = _summarize_cash_drug_admin_updates(rows, updates)
    summary["validation"] = validation
    if dry_run:
        summary["rows_written"] = 0
    if len(updates) <= 50:
        summary["updates"] = updates
    else:
        summary["sample_updates"] = updates[:20]
    return summary


def _populate_main_table_cleaned_pharmacy_fields(
    cur: psycopg.Cursor,
    admission_nos: list[str] | None = None,
    limit: int | None = None,
    dry_run: bool = False,
    pharmacy_mapping_path: Path = DEFAULT_PHARMACY_MAPPING,
) -> dict[str, object]:
    rows = _fetch_target_main_table_rows(cur, admission_nos=admission_nos, limit=limit)
    _, _, pharmacy_by_code, pharmacy_by_name = load_fc_actual_mappings(
        DEFAULT_SERVICE_MAPPING,
        pharmacy_mapping_path,
    )
    updates: list[dict[str, object]] = []
    for row in rows:
        derived = _derive_cleaned_pharmacy_payloads(row["pharmacy_json"], pharmacy_by_code, pharmacy_by_name)
        updates.append(
            {
                "main_table_key": row["main_table_key"],
                "admission_no": row["admission_no"],
                "patient_name": row["patient_name"],
                **derived,
            }
        )

    validation = _validate_main_table_cleaned_pharmacy_updates(rows, updates, pharmacy_by_code, pharmacy_by_name)
    if validation["failed_validation"]:
        raise RuntimeError("Cleaned pharmacy validation failed: " + json.dumps(validation["sample_failures"], indent=2))

    if not dry_run and updates:
        cur.executemany(
            """
            update mart.main_table
            set
                cleaned_pharmacy_issue_jsonb = %s::jsonb,
                cleaned_pharmacy_returns_jsonb = %s::jsonb,
                cleaned_pharmacy_net_jsonb = %s::jsonb
            where main_table_key = %s
            """,
            [
                (
                    json.dumps(update["cleaned_pharmacy_issue_json"]),
                    json.dumps(update["cleaned_pharmacy_returns_json"]),
                    json.dumps(update["cleaned_pharmacy_net_json"]),
                    update["main_table_key"],
                )
                for update in updates
            ],
        )

    summary = _summarize_cleaned_pharmacy_updates(rows, updates)
    summary["validation"] = validation
    if dry_run:
        summary["rows_written"] = 0
    if len(updates) <= 10:
        summary["updates"] = updates
    else:
        summary["sample_updates"] = updates[:5]
    return summary


def _validate_main_table_normalized_los_updates(
    rows: list[dict[str, object]],
    updates: list[dict[str, object]],
) -> dict[str, object]:
    failures: list[dict[str, object]] = []
    for row, update in zip(rows, updates):
        normalized_days = update["normalized_billable_stay_days"]
        reason = str(update["normalized_billable_stay_reason"])
        same_day_daycare_style = bool(update["same_day_daycare_style"])
        date_of_admission = row.get("date_of_admission")
        date_of_discharge = row.get("date_of_discharge")
        has_room_charge_signal = _has_room_charge_signal(row.get("services_json") if isinstance(row.get("services_json"), list) else [])
        mismatch_types: list[str] = []

        if same_day_daycare_style and normalized_days != 0:
            mismatch_types.append("same_day_daycare_style_not_zero")
        if date_of_admission is not None and date_of_discharge is not None:
            same_day = date_of_admission.date() == date_of_discharge.date()
            if same_day and has_room_charge_signal and normalized_days == 0:
                mismatch_types.append("same_day_room_based_zero")
            if not same_day and normalized_days is not None and normalized_days < 1:
                mismatch_types.append("cross_day_less_than_one")
        if normalized_days is not None and normalized_days < 0:
            mismatch_types.append("negative_normalized_los")
        if date_of_admission is None or date_of_discharge is None:
            if reason not in {
                "missing_dates_daycare_los_lt_1",
                "missing_dates_fallback_ceil_los",
                "missing_dates_missing_los",
            }:
                mismatch_types.append("invalid_missing_dates_reason")

        if mismatch_types:
            failures.append(
                {
                    "admission_no": row["admission_no"],
                    "patient_name": row["patient_name"],
                    "mismatch_types": mismatch_types,
                    "normalized_billable_stay_days": normalized_days,
                    "normalized_billable_stay_reason": reason,
                    "same_day_daycare_style": same_day_daycare_style,
                }
            )

    return {
        "validated_row_count": len(rows),
        "failed_validation": bool(failures),
        "failure_count": len(failures),
        "sample_failures": failures[:10],
    }


def _populate_main_table_normalized_los(
    cur: psycopg.Cursor,
    admission_nos: list[str] | None = None,
    limit: int | None = None,
    dry_run: bool = False,
) -> dict[str, object]:
    rows = _fetch_target_main_table_normalized_los_rows(cur, admission_nos=admission_nos, limit=limit)
    updates: list[dict[str, object]] = []
    for row in rows:
        normalized_days, reason, same_day_daycare_style = _compute_normalized_billable_stay_days(row)
        updates.append(
            {
                "main_table_key": row["main_table_key"],
                "admission_no": row["admission_no"],
                "patient_name": row["patient_name"],
                "normalized_billable_stay_days": normalized_days,
                "normalized_billable_stay_reason": reason,
                "same_day_daycare_style": same_day_daycare_style,
            }
        )

    validation = _validate_main_table_normalized_los_updates(rows, updates)
    if validation["failed_validation"]:
        raise RuntimeError("Normalized LOS validation failed: " + json.dumps(validation["sample_failures"], indent=2))

    if not dry_run and updates:
        cur.executemany(
            """
            update mart.main_table
            set
                normalized_billable_stay_days = %s,
                normalized_billable_stay_reason = %s,
                same_day_daycare_style = %s
            where main_table_key = %s
            """,
            [
                (
                    update["normalized_billable_stay_days"],
                    update["normalized_billable_stay_reason"],
                    update["same_day_daycare_style"],
                    update["main_table_key"],
                )
                for update in updates
            ],
        )

    summary = _summarize_normalized_los_updates(rows, updates)
    summary["validation"] = validation
    if dry_run:
        summary["rows_written"] = 0
    if len(updates) <= 50:
        summary["updates"] = updates
    else:
        summary["sample_updates"] = updates[:20]
    return summary


def _populate_main_table_fc_actual_quality_flags(
    cur: psycopg.Cursor,
    admission_nos: list[str] | None = None,
    limit: int | None = None,
    dry_run: bool = False,
) -> dict[str, object]:
    rows = _fetch_target_main_table_fc_quality_rows(cur, admission_nos=admission_nos, limit=limit)
    updates: list[dict[str, object]] = []
    for row in rows:
        quality = evaluate_fc_actual_quality(row)
        updates.append(
            {
                "main_table_key": row["main_table_key"],
                "admission_no": row["admission_no"],
                "patient_name": row["patient_name"],
                "quality_level": quality["quality_level"],
                "quality_flags_json": quality["quality_flags_json"],
            }
        )

    if not dry_run and updates:
        cur.executemany(
            """
            update mart.main_table
            set
                fc_actual_quality_level = %s,
                fc_actual_quality_flags_jsonb = %s::jsonb
            where main_table_key = %s
            """,
            [
                (
                    update["quality_level"],
                    json.dumps(update["quality_flags_json"]),
                    update["main_table_key"],
                )
                for update in updates
            ],
        )

    summary = _summarize_fc_actual_quality_updates(rows, updates)
    if dry_run:
        summary["rows_written"] = 0
    if len(updates) <= 50:
        summary["updates"] = updates
    else:
        summary["sample_updates"] = updates[:20]
    return summary


def enrich_main_table_daycare_broad() -> None:
    with connect_db() as conn:
        with conn.cursor() as cur:
            _ensure_main_table_daycare_broad_columns(cur)
            _populate_main_table_daycare_broad(cur)
        conn.commit()


def enrich_main_table_payor_bucket() -> None:
    with connect_db() as conn:
        with conn.cursor() as cur:
            _ensure_main_table_payor_bucket_column(cur)
            _populate_main_table_payor_bucket(cur)
        conn.commit()


def enrich_main_table_short_stay_non_daycare() -> None:
    with connect_db() as conn:
        with conn.cursor() as cur:
            _ensure_main_table_short_stay_column(cur)
            _populate_main_table_short_stay_column(cur)
        conn.commit()


def enrich_main_table_stay_audit_fields() -> None:
    with connect_db() as conn:
        with conn.cursor() as cur:
            _ensure_main_table_stay_audit_columns(cur)
            _populate_main_table_stay_audit_fields(cur)
        conn.commit()


def enrich_main_table_tariff_fields() -> None:
    with connect_db() as conn:
        with conn.cursor() as cur:
            _ensure_main_table_tariff_columns(cur)
            _populate_main_table_tariff_fields(cur)
        conn.commit()


def enrich_main_table_cleaned_pharmacy_fields(
    admission_nos: list[str] | None = None,
    limit: int | None = None,
    dry_run: bool = False,
    batch_size: int = 250,
) -> dict[str, object]:
    targeted = bool(admission_nos) or limit is not None or dry_run
    if targeted:
        with connect_db() as conn:
            with conn.cursor() as cur:
                _ensure_main_table_cleaned_pharmacy_columns(cur)
                summary = _populate_main_table_cleaned_pharmacy_fields(
                    cur,
                    admission_nos=admission_nos,
                    limit=limit,
                    dry_run=dry_run,
                )
            if not dry_run:
                conn.commit()
        return summary

    aggregate = {
        "rows_processed": 0,
        "rows_written": 0,
        "rows_with_non_empty_cleaned_issue_payload": 0,
        "rows_with_non_empty_cleaned_returns_payload": 0,
        "rows_with_non_empty_cleaned_net_payload": 0,
        "gross_issue_amount_total_using_raw_amount": 0.0,
        "gross_issue_amount_total_using_reconstructed_quantity_sale_rate": 0.0,
        "sample_largest_issue_amount_deltas": [],
        "sample_corrupted_rows": [],
    }

    with connect_db() as conn:
        with conn.cursor() as cur:
            _ensure_main_table_cleaned_pharmacy_columns(cur)
            cur.execute(
                """
                select admission_no
                from mart.main_table
                where complete_bill = true
                order by admission_no
                """
            )
            all_admissions = [str(row[0]) for row in cur.fetchall()]

    delta_samples: list[dict[str, object]] = []
    corrupted_samples: list[dict[str, object]] = []
    for start in range(0, len(all_admissions), max(batch_size, 1)):
        chunk = all_admissions[start : start + max(batch_size, 1)]
        with connect_db() as conn:
            with conn.cursor() as cur:
                _ensure_main_table_cleaned_pharmacy_columns(cur)
                summary = _populate_main_table_cleaned_pharmacy_fields(cur, admission_nos=chunk, dry_run=False)
            conn.commit()
        aggregate["rows_processed"] += int(summary["rows_processed"])
        aggregate["rows_written"] += int(summary["rows_written"])
        aggregate["rows_with_non_empty_cleaned_issue_payload"] += int(summary["rows_with_non_empty_cleaned_issue_payload"])
        aggregate["rows_with_non_empty_cleaned_returns_payload"] += int(summary["rows_with_non_empty_cleaned_returns_payload"])
        aggregate["rows_with_non_empty_cleaned_net_payload"] += int(summary["rows_with_non_empty_cleaned_net_payload"])
        aggregate["gross_issue_amount_total_using_raw_amount"] += float(summary["gross_issue_amount_total_using_raw_amount"])
        aggregate["gross_issue_amount_total_using_reconstructed_quantity_sale_rate"] += float(
            summary["gross_issue_amount_total_using_reconstructed_quantity_sale_rate"]
        )
        delta_samples.extend(summary.get("sample_largest_issue_amount_deltas") or [])
        corrupted_samples.extend(summary.get("sample_corrupted_rows") or [])

    delta_samples.sort(key=lambda sample: abs(float(sample["delta"])), reverse=True)
    corrupted_samples.sort(key=lambda sample: abs(float(sample["delta"])), reverse=True)
    aggregate["gross_issue_amount_total_using_raw_amount"] = round(
        float(aggregate["gross_issue_amount_total_using_raw_amount"]),
        2,
    )
    aggregate["gross_issue_amount_total_using_reconstructed_quantity_sale_rate"] = round(
        float(aggregate["gross_issue_amount_total_using_reconstructed_quantity_sale_rate"]),
        2,
    )
    aggregate["sample_largest_issue_amount_deltas"] = delta_samples[:10]
    aggregate["sample_corrupted_rows"] = corrupted_samples[:10]
    return aggregate


def enrich_main_table_cash_drug_admin_fields(
    admission_nos: list[str] | None = None,
    limit: int | None = None,
    dry_run: bool = False,
    batch_size: int = 250,
) -> dict[str, object]:
    targeted = bool(admission_nos) or limit is not None or dry_run
    if targeted:
        with connect_db() as conn:
            with conn.cursor() as cur:
                _ensure_main_table_cash_drug_admin_columns(cur)
                summary = _populate_main_table_cash_drug_admin_fields(
                    cur,
                    admission_nos=admission_nos,
                    limit=limit,
                    dry_run=dry_run,
                )
            if not dry_run:
                conn.commit()
        return summary

    aggregate = {
        "rows_processed": 0,
        "rows_written": 0,
        "cash_row_count": 0,
        "non_cash_row_count": 0,
        "non_zero_drug_admin_count": 0,
        "mean_cash_drug_admin_charge": 0.0,
        "max_cash_drug_admin_charge": 0.0,
        "sample_cash_admissions": [],
    }
    weighted_cash_drug_admin_total = 0.0

    with connect_db() as conn:
        with conn.cursor() as cur:
            _ensure_main_table_cash_drug_admin_columns(cur)
            cur.execute(
                """
                select admission_no
                from mart.main_table
                where complete_bill = true
                order by admission_no
                """
            )
            all_admissions = [str(row[0]) for row in cur.fetchall()]

    for start in range(0, len(all_admissions), max(batch_size, 1)):
        chunk = all_admissions[start : start + max(batch_size, 1)]
        with connect_db() as conn:
            with conn.cursor() as cur:
                _ensure_main_table_cash_drug_admin_columns(cur)
                summary = _populate_main_table_cash_drug_admin_fields(cur, admission_nos=chunk, dry_run=False)
            conn.commit()
        aggregate["rows_processed"] += int(summary["rows_processed"])
        aggregate["rows_written"] += int(summary["rows_written"])
        aggregate["cash_row_count"] += int(summary["cash_row_count"])
        aggregate["non_cash_row_count"] += int(summary["non_cash_row_count"])
        aggregate["non_zero_drug_admin_count"] += int(summary["non_zero_drug_admin_count"])
        aggregate["max_cash_drug_admin_charge"] = max(
            float(aggregate["max_cash_drug_admin_charge"]),
            float(summary["max_cash_drug_admin_charge"]),
        )
        weighted_cash_drug_admin_total += float(summary["mean_cash_drug_admin_charge"]) * int(summary["cash_row_count"])
        for sample in (summary.get("sample_cash_admissions") or []):
            if len(aggregate["sample_cash_admissions"]) < 10:
                aggregate["sample_cash_admissions"].append(sample)

    aggregate["mean_cash_drug_admin_charge"] = (
        round(weighted_cash_drug_admin_total / aggregate["cash_row_count"], 2)
        if aggregate["cash_row_count"]
        else 0.0
    )
    return aggregate


def enrich_main_table_emergency_mlc_flags(
    admission_nos: list[str] | None = None,
    limit: int | None = None,
    dry_run: bool = False,
    batch_size: int = 250,
) -> dict[str, object]:
    targeted = bool(admission_nos) or limit is not None or dry_run
    if targeted:
        with connect_db() as conn:
            with conn.cursor() as cur:
                _ensure_main_table_emergency_mlc_columns(cur)
                summary = _populate_main_table_emergency_mlc_flags(
                    cur,
                    admission_nos=admission_nos,
                    limit=limit,
                    dry_run=dry_run,
                )
            if not dry_run:
                conn.commit()
        return summary

    aggregate = {
        "rows_processed": 0,
        "rows_written": 0,
        "has_emergency_origin_count": 0,
        "has_mlc_charge_count": 0,
        "both_flags_count": 0,
        "mlc_without_emergency_count": 0,
        "top_emergency_signal_service_codes": {},
        "top_emergency_signal_service_names": {},
        "top_mlc_signal_service_codes": {},
        "top_mlc_signal_service_names": {},
        "sample_audit_payloads": [],
    }

    with connect_db() as conn:
        with conn.cursor() as cur:
            _ensure_main_table_emergency_mlc_columns(cur)
            cur.execute(
                """
                select admission_no
                from mart.main_table
                where complete_bill = true
                order by admission_no
                """
            )
            all_admissions = [str(row[0]) for row in cur.fetchall()]

    for start in range(0, len(all_admissions), max(batch_size, 1)):
        chunk = all_admissions[start : start + max(batch_size, 1)]
        with connect_db() as conn:
            with conn.cursor() as cur:
                _ensure_main_table_emergency_mlc_columns(cur)
                summary = _populate_main_table_emergency_mlc_flags(cur, admission_nos=chunk, dry_run=False)
            conn.commit()
        aggregate["rows_processed"] += int(summary["rows_processed"])
        aggregate["rows_written"] += int(summary["rows_written"])
        aggregate["has_emergency_origin_count"] += int(summary["has_emergency_origin_count"])
        aggregate["has_mlc_charge_count"] += int(summary["has_mlc_charge_count"])
        aggregate["both_flags_count"] += int(summary["both_flags_count"])
        aggregate["mlc_without_emergency_count"] += int(summary["mlc_without_emergency_count"])
        for key in [
            "top_emergency_signal_service_codes",
            "top_emergency_signal_service_names",
            "top_mlc_signal_service_codes",
            "top_mlc_signal_service_names",
        ]:
            bucket = aggregate[key]
            for value, count in (summary.get(key) or []):
                bucket[value] = bucket.get(value, 0) + int(count)
        for sample in (summary.get("sample_audit_payloads") or []):
            if len(aggregate["sample_audit_payloads"]) < 10:
                aggregate["sample_audit_payloads"].append(sample)

    for key in [
        "top_emergency_signal_service_codes",
        "top_emergency_signal_service_names",
        "top_mlc_signal_service_codes",
        "top_mlc_signal_service_names",
    ]:
        aggregate[key] = sorted(aggregate[key].items(), key=lambda item: (-item[1], item[0]))[:10]
    return aggregate


def enrich_main_table_procedure_duration_fields(
    admission_nos: list[str] | None = None,
    limit: int | None = None,
    dry_run: bool = False,
    batch_size: int = 250,
) -> dict[str, object]:
    targeted = bool(admission_nos) or limit is not None or dry_run
    if targeted:
        with connect_db() as conn:
            with conn.cursor() as cur:
                _ensure_main_table_procedure_duration_columns(cur)
                summary = _populate_main_table_procedure_duration_fields(
                    cur,
                    admission_nos=admission_nos,
                    limit=limit,
                    dry_run=dry_run,
                )
            if not dry_run:
                conn.commit()
        return summary

    aggregate = {
        "rows_processed": 0,
        "rows_written": 0,
        "rows_with_non_null_derived_ot_hours": 0,
        "rows_with_non_null_derived_cath_lab_hours": 0,
        "top_ot_service_code_combinations": {},
        "top_cath_lab_service_code_combinations": {},
    }
    with connect_db() as conn:
        with conn.cursor() as cur:
            _ensure_main_table_procedure_duration_columns(cur)
            cur.execute(
                """
                select admission_no
                from mart.main_table
                where complete_bill = true
                order by admission_no
                """
            )
            all_admissions = [str(row[0]) for row in cur.fetchall()]

    for start in range(0, len(all_admissions), max(batch_size, 1)):
        chunk = all_admissions[start : start + max(batch_size, 1)]
        with connect_db() as conn:
            with conn.cursor() as cur:
                _ensure_main_table_procedure_duration_columns(cur)
                summary = _populate_main_table_procedure_duration_fields(cur, admission_nos=chunk, dry_run=False)
            conn.commit()
        aggregate["rows_processed"] += int(summary["rows_processed"])
        aggregate["rows_written"] += int(summary["rows_written"])
        aggregate["rows_with_non_null_derived_ot_hours"] += int(summary["rows_with_non_null_derived_ot_hours"])
        aggregate["rows_with_non_null_derived_cath_lab_hours"] += int(summary["rows_with_non_null_derived_cath_lab_hours"])
        for combo, count in summary["top_ot_service_code_combinations"]:
            aggregate["top_ot_service_code_combinations"][combo] = aggregate["top_ot_service_code_combinations"].get(combo, 0) + int(count)
        for combo, count in summary["top_cath_lab_service_code_combinations"]:
            aggregate["top_cath_lab_service_code_combinations"][combo] = aggregate["top_cath_lab_service_code_combinations"].get(combo, 0) + int(count)
    aggregate["top_ot_service_code_combinations"] = sorted(
        aggregate["top_ot_service_code_combinations"].items(),
        key=lambda item: (-item[1], item[0]),
    )[:10]
    aggregate["top_cath_lab_service_code_combinations"] = sorted(
        aggregate["top_cath_lab_service_code_combinations"].items(),
        key=lambda item: (-item[1], item[0]),
    )[:10]
    return aggregate


def enrich_main_table_normalized_los(
    admission_nos: list[str] | None = None,
    limit: int | None = None,
    dry_run: bool = False,
    batch_size: int = 250,
) -> dict[str, object]:
    targeted = bool(admission_nos) or limit is not None or dry_run
    if targeted:
        with connect_db() as conn:
            with conn.cursor() as cur:
                _ensure_main_table_normalized_los_columns(cur)
                summary = _populate_main_table_normalized_los(
                    cur,
                    admission_nos=admission_nos,
                    limit=limit,
                    dry_run=dry_run,
                )
            if not dry_run:
                conn.commit()
        return summary

    aggregate = {
        "rows_processed": 0,
        "rows_written": 0,
        "counts_by_reason": {},
        "zero_day_count": 0,
        "one_day_count": 0,
        "same_day_daycare_style_count": 0,
        "comparison_counts": {
            "normalized_equals_ceil_los_count": 0,
            "normalized_equals_icu_plus_ward_count": 0,
            "normalized_gt_icu_plus_ward_count": 0,
        },
    }

    with connect_db() as conn:
        with conn.cursor() as cur:
            _ensure_main_table_normalized_los_columns(cur)
            cur.execute(
                """
                select admission_no
                from mart.main_table
                where complete_bill = true
                order by admission_no
                """
            )
            all_admissions = [str(row[0]) for row in cur.fetchall()]

    for start in range(0, len(all_admissions), max(batch_size, 1)):
        chunk = all_admissions[start : start + max(batch_size, 1)]
        with connect_db() as conn:
            with conn.cursor() as cur:
                _ensure_main_table_normalized_los_columns(cur)
                summary = _populate_main_table_normalized_los(cur, admission_nos=chunk, dry_run=False)
            conn.commit()
        aggregate["rows_processed"] += int(summary["rows_processed"])
        aggregate["rows_written"] += int(summary["rows_written"])
        aggregate["zero_day_count"] += int(summary["zero_day_count"])
        aggregate["one_day_count"] += int(summary["one_day_count"])
        aggregate["same_day_daycare_style_count"] += int(summary["same_day_daycare_style_count"])
        for reason, count in (summary.get("counts_by_reason") or {}).items():
            aggregate["counts_by_reason"][reason] = aggregate["counts_by_reason"].get(reason, 0) + int(count)
        for key, count in (summary.get("comparison_counts") or {}).items():
            aggregate["comparison_counts"][key] = aggregate["comparison_counts"].get(key, 0) + int(count)
    return aggregate


def enrich_main_table_fc_actual_buckets(
    admission_nos: list[str] | None = None,
    limit: int | None = None,
    dry_run: bool = False,
    batch_size: int = 250,
) -> dict[str, object]:
    targeted = bool(admission_nos) or limit is not None or dry_run
    if targeted:
        with connect_db() as conn:
            with conn.cursor() as cur:
                _ensure_main_table_fc_actual_columns(cur)
                summary = _populate_main_table_fc_actual_buckets(
                    cur,
                    admission_nos=admission_nos,
                    limit=limit,
                    dry_run=dry_run,
                )
                validation_summary = _validate_fc_actual_stored_values(
                    cur,
                    admission_nos=admission_nos,
                    limit=limit,
                ) if not dry_run else None
                quality_summary = None
                cash_summary = None
                if not dry_run:
                    _ensure_main_table_fc_actual_quality_columns(cur)
                    quality_summary = _populate_main_table_fc_actual_quality_flags(
                        cur,
                        admission_nos=admission_nos,
                        limit=limit,
                        dry_run=False,
                    )
                    _ensure_main_table_cash_drug_admin_columns(cur)
                    cash_summary = _populate_main_table_cash_drug_admin_fields(
                        cur,
                        admission_nos=admission_nos,
                        limit=limit,
                        dry_run=False,
                    )
            if not dry_run:
                conn.commit()
        if validation_summary is not None and validation_summary["failed_validation"]:
            raise RuntimeError(
                "FC actual validation failed: "
                + json.dumps(validation_summary["sample_failing_admissions"], indent=2)
            )
        if validation_summary is not None:
            summary["validation"] = validation_summary
        if quality_summary is not None:
            summary["quality_refresh"] = quality_summary
        if cash_summary is not None:
            summary["cash_drug_admin_refresh"] = cash_summary
        return summary

    aggregate = {
        "rows_processed": 0,
        "rows_written": 0,
        "rows_skipped": 0,
        "failed_admissions": [],
        "unmapped_service_row_count": 0,
        "unmapped_pharmacy_row_count": 0,
        "ambiguous_service_row_count": 0,
        "ambiguous_pharmacy_row_count": 0,
        "mean_abs_reconciliation_delta": 0.0,
        "max_abs_reconciliation_delta": 0.0,
        "inline_validation": {
            "validated_row_count": 0,
            "total_vs_bucket_mismatch_count": 0,
            "pharmacy_total_mismatch_count": 0,
            "recomputed_vs_stored_mismatch_count": 0,
            "failed_batches": [],
        },
        "rows_with_changed_pharmacy_totals": 0,
        "rows_with_changed_base_totals": 0,
        "cash_rows_with_changed_drug_admin": 0,
        "max_abs_pharmacy_delta": 0.0,
        "max_abs_total_delta": 0.0,
        "quality_level_change_count": 0,
        "sample_largest_corrections": [],
    }
    weighted_reconciliation_total = 0.0

    with connect_db() as conn:
        with conn.cursor() as cur:
            _ensure_main_table_fc_actual_columns(cur)
            cur.execute(
                """
                select admission_no
                from mart.main_table
                where complete_bill = true
                order by admission_no
                """
            )
            all_admissions = [str(row[0]) for row in cur.fetchall()]

    for start in range(0, len(all_admissions), max(batch_size, 1)):
        chunk = all_admissions[start : start + max(batch_size, 1)]
        with connect_db() as conn:
            with conn.cursor() as cur:
                _ensure_main_table_fc_actual_columns(cur)
                summary = _populate_main_table_fc_actual_buckets(cur, admission_nos=chunk, dry_run=False)
                validation_summary = _validate_fc_actual_stored_values(cur, admission_nos=chunk)
                if validation_summary["failed_validation"]:
                    raise RuntimeError(
                        "FC actual inline validation failed for batch "
                        + json.dumps(
                            {
                                "batch_start_index": start,
                                "batch_end_index": start + len(chunk) - 1,
                                "admission_count": len(chunk),
                                "sample_failing_admissions": validation_summary["sample_failing_admissions"],
                            },
                            indent=2,
                        )
                    )
                _ensure_main_table_fc_actual_quality_columns(cur)
                quality_summary = _populate_main_table_fc_actual_quality_flags(cur, admission_nos=chunk, dry_run=False)
                _ensure_main_table_cash_drug_admin_columns(cur)
                cash_summary = _populate_main_table_cash_drug_admin_fields(cur, admission_nos=chunk, dry_run=False)
            conn.commit()
        aggregate["rows_processed"] += int(summary["rows_processed"])
        aggregate["rows_written"] += int(summary["rows_written"])
        aggregate["rows_skipped"] += int(summary["rows_skipped"])
        aggregate["failed_admissions"].extend(summary["failed_admissions"])
        aggregate["unmapped_service_row_count"] += int(summary["unmapped_service_row_count"])
        aggregate["unmapped_pharmacy_row_count"] += int(summary["unmapped_pharmacy_row_count"])
        aggregate["ambiguous_service_row_count"] += int(summary["ambiguous_service_row_count"])
        aggregate["ambiguous_pharmacy_row_count"] += int(summary["ambiguous_pharmacy_row_count"])
        aggregate["max_abs_reconciliation_delta"] = max(
            float(aggregate["max_abs_reconciliation_delta"]),
            float(summary["max_abs_reconciliation_delta"]),
        )
        weighted_reconciliation_total += float(summary["mean_abs_reconciliation_delta"]) * int(summary["rows_processed"])
        aggregate["inline_validation"]["validated_row_count"] += int(validation_summary["validated_row_count"])
        aggregate["inline_validation"]["total_vs_bucket_mismatch_count"] += int(
            validation_summary["total_vs_bucket_mismatch_count"]
        )
        aggregate["inline_validation"]["pharmacy_total_mismatch_count"] += int(
            validation_summary["pharmacy_total_mismatch_count"]
        )
        aggregate["inline_validation"]["recomputed_vs_stored_mismatch_count"] += int(
            validation_summary["recomputed_vs_stored_mismatch_count"]
        )
        aggregate["rows_with_changed_pharmacy_totals"] += int(summary.get("rows_with_changed_pharmacy_totals", 0))
        aggregate["rows_with_changed_base_totals"] += int(summary.get("rows_with_changed_base_totals", 0))
        aggregate["cash_rows_with_changed_drug_admin"] += int(cash_summary["changed_drug_admin_count"])
        aggregate["quality_level_change_count"] += int(quality_summary.get("quality_level_change_count", 0))
        aggregate["max_abs_pharmacy_delta"] = max(
            float(aggregate["max_abs_pharmacy_delta"]),
            float(summary.get("max_abs_pharmacy_delta", 0.0)),
        )
        aggregate["max_abs_total_delta"] = max(
            float(aggregate["max_abs_total_delta"]),
            float(summary.get("max_abs_total_delta", 0.0)),
        )
        for sample in summary.get("sample_largest_corrections", []):
            if len(aggregate["sample_largest_corrections"]) < 10:
                aggregate["sample_largest_corrections"].append(sample)

    aggregate["mean_abs_reconciliation_delta"] = (
        round(weighted_reconciliation_total / aggregate["rows_processed"], 6)
        if aggregate["rows_processed"]
        else 0.0
    )
    with connect_db() as conn:
        with conn.cursor() as cur:
            aggregate["final_validation"] = _validate_fc_actual_stored_values(cur)
    return aggregate


def enrich_main_table_fc_actual_quality_flags(
    admission_nos: list[str] | None = None,
    limit: int | None = None,
    dry_run: bool = False,
    batch_size: int = 250,
) -> dict[str, object]:
    targeted = bool(admission_nos) or limit is not None or dry_run
    if targeted:
        with connect_db() as conn:
            with conn.cursor() as cur:
                _ensure_main_table_fc_actual_quality_columns(cur)
                summary = _populate_main_table_fc_actual_quality_flags(
                    cur,
                    admission_nos=admission_nos,
                    limit=limit,
                    dry_run=dry_run,
                )
            if not dry_run:
                conn.commit()
        return summary

    aggregate = {
        "rows_processed": 0,
        "rows_written": 0,
        "counts_by_level": {},
        "counts_by_rule": {},
        "sample_by_rule": {},
    }

    with connect_db() as conn:
        with conn.cursor() as cur:
            _ensure_main_table_fc_actual_quality_columns(cur)
            cur.execute(
                """
                select admission_no
                from mart.main_table
                where complete_bill = true
                order by admission_no
                """
            )
            all_admissions = [str(row[0]) for row in cur.fetchall()]

    for start in range(0, len(all_admissions), max(batch_size, 1)):
        chunk = all_admissions[start : start + max(batch_size, 1)]
        with connect_db() as conn:
            with conn.cursor() as cur:
                _ensure_main_table_fc_actual_quality_columns(cur)
                summary = _populate_main_table_fc_actual_quality_flags(cur, admission_nos=chunk, dry_run=False)
            conn.commit()
        aggregate["rows_processed"] += int(summary["rows_processed"])
        aggregate["rows_written"] += int(summary["rows_written"])
        for level, count in (summary.get("counts_by_level") or {}).items():
            aggregate["counts_by_level"][level] = aggregate["counts_by_level"].get(level, 0) + int(count)
        for code, count in (summary.get("counts_by_rule") or {}).items():
            aggregate["counts_by_rule"][code] = aggregate["counts_by_rule"].get(code, 0) + int(count)
        for code, samples in (summary.get("sample_by_rule") or {}).items():
            bucket = aggregate["sample_by_rule"].setdefault(code, [])
            for sample in samples:
                if len(bucket) < 3:
                    bucket.append(sample)
    return aggregate


def refresh_ip_case_review() -> None:
    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute("select mart.refresh_ip_case_review()")
        conn.commit()


def refresh_normalized_mart_v2() -> None:
    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute("select mart_v2.refresh_normalized_mart()")
        conn.commit()


def refresh_main_table() -> None:
    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute("select mart.refresh_main_table()")
            _ensure_main_table_daycare_broad_columns(cur)
            _populate_main_table_daycare_broad(cur)
            _ensure_main_table_payor_bucket_column(cur)
            _populate_main_table_payor_bucket(cur)
            _ensure_main_table_short_stay_column(cur)
            _populate_main_table_short_stay_column(cur)
            _ensure_main_table_stay_audit_columns(cur)
            _populate_main_table_stay_audit_fields(cur)
            _ensure_main_table_tariff_columns(cur)
            _populate_main_table_tariff_fields(cur)
        conn.commit()
    enrich_main_table_procedure_duration_fields()
    enrich_main_table_normalized_los()
    enrich_main_table_cleaned_pharmacy_fields()
    enrich_main_table_fc_actual_buckets()
    enrich_main_table_fc_actual_quality_flags()
    enrich_main_table_cash_drug_admin_fields()
    enrich_main_table_emergency_mlc_flags()


def refresh_main_table_organization_codes() -> None:
    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute("select mart.refresh_main_table_organization_codes()")
        conn.commit()


def refresh_billing_catalog() -> None:
    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute("select mart.refresh_billing_catalog()")
        conn.commit()


def refresh_template_registry() -> None:
    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute("select curation.refresh_template_registry()")
        conn.commit()


def refresh_template_registry_phase2() -> None:
    raise RuntimeError(
        "curation.refresh_template_registry_phase2() is deprecated. "
        "Use scripts/etl/populate_template_registry_phase2.py instead."
    )
