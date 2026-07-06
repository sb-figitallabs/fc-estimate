from __future__ import annotations

import argparse
import csv
import json
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from export_chemotherapy_services_phase1 import (
    build_case_filter_clause,
    connect_db,
    fetch_service_metric_rows,
    format_number,
    normalize,
    normalize_code,
)
from professional_fee_review_workbook import inclusive_quartiles


REPO_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_ROOT = REPO_ROOT / "output" / "fc_professional_fee_analysis"
DEFAULT_SERVICE_MAPPING = REPO_ROOT / "output" / "reference" / "service_fc_estimate_bucket_mapping.csv"

SURGICAL_SUBHEAD_HINTS = {
    "ORTHOPAEDICS",
    "OPERATIONS",
    "SURGICAL ONCOLOGY",
    "SURGICAL GASTRO ENTEROLOGY\\GENERAL SURGERY",
    "SURGICAL GASTROENTEROLOGY\\GENERAL SURGERY",
    "GENERAL SURGERY",
    "UROLOGY",
    "NEUROSURGERY",
    "ENT",
    "VASCULAR SURGERY",
    "PLASTIC SURGERY",
    "CARDIO THORACIC SURGERY",
    "CARDIOTHORACIC SURGERY",
    "OBSTETRICS & GYNAECOLOGY",
    "OBSTETRICS & GYNECOLOGY",
}

ASSISTANT_SURGEON_SIGNALS = {
    "ASST. SURGEON",
    "ASSISTANT SURGEON",
}
ASSISTANT_ANESTHETIST_SIGNALS = {
    "ASSISTANT ANESTHETIST",
    "ASST ANESTHETIST",
    "ASST. ANESTHETIST",
}
PAYOR_BUCKET_ORDER = [
    "Cash",
    "GIPSA Insurance",
    "Non-GIPSA Insurance",
    "Corporate",
]


@dataclass(frozen=True)
class TemplateConfig:
    key: str
    template_name: str
    template_registry_id: str
    management_type_filter: str
    daycare_mode: str
    require_complete_bill: bool
    require_surgical_medical: bool
    modeled_pf_compare: bool
    pharmacy_per_ip_path: Path | None
    estimate_behavior: str


TEMPLATE_CONFIGS: dict[str, TemplateConfig] = {
    "robotic_tkr_unilateral_right": TemplateConfig(
        key="robotic_tkr_unilateral_right",
        template_name="ROBOTIC TKR - UNILATERAL - RIGHT",
        template_registry_id="0c4d7425-20e5-46a5-bed0-210c4745aba5",
        management_type_filter="Surgical",
        daycare_mode="exclude",
        require_complete_bill=True,
        require_surgical_medical=True,
        modeled_pf_compare=True,
        pharmacy_per_ip_path=REPO_ROOT / "output" / "robotic_tkr_unilateral_right_three_csvs" / "09_per_ip_bucket_totals_from_classification.csv",
        estimate_behavior="Cash formula in estimate body; historical PF shown as review context.",
    ),
    "robotic_tkr_unilateral_left": TemplateConfig(
        key="robotic_tkr_unilateral_left",
        template_name="ROBOTIC TKR - UNILATERAL - LEFT",
        template_registry_id="271bed2c-1778-4654-8696-f23b9e1c5709",
        management_type_filter="Surgical",
        daycare_mode="exclude",
        require_complete_bill=True,
        require_surgical_medical=True,
        modeled_pf_compare=True,
        pharmacy_per_ip_path=REPO_ROOT / "output" / "robotic_tkr_unilateral_left_three_csvs" / "09_per_ip_bucket_totals_from_classification.csv",
        estimate_behavior="Cash formula in estimate body; historical PF shown as review context.",
    ),
    "robotic_tkr_bilateral": TemplateConfig(
        key="robotic_tkr_bilateral",
        template_name="ROBOTIC TKR - BILATERAL",
        template_registry_id="6648973a-0982-4aec-b672-9c2b3a72ae79",
        management_type_filter="Surgical",
        daycare_mode="exclude",
        require_complete_bill=True,
        require_surgical_medical=True,
        modeled_pf_compare=True,
        pharmacy_per_ip_path=REPO_ROOT / "output" / "robotic_tkr_bilateral_three_csvs" / "09_per_ip_bucket_totals_from_classification.csv",
        estimate_behavior="Cash formula in estimate body; historical PF shown as review context.",
    ),
    "total_hip_replacement_thr_hemiarthroplasty": TemplateConfig(
        key="total_hip_replacement_thr_hemiarthroplasty",
        template_name="Total Hip Replacement (THR) / Hemiarthroplasty",
        template_registry_id="a23d8aef-1b18-4c7c-98a2-f3d13e27e20b",
        management_type_filter="Surgical",
        daycare_mode="exclude",
        require_complete_bill=True,
        require_surgical_medical=True,
        modeled_pf_compare=True,
        pharmacy_per_ip_path=REPO_ROOT / "output" / "total_hip_replacement_thr_hemiarthroplasty_fc" / "09_per_ip_bucket_totals_from_classification.csv",
        estimate_behavior="Cash formula in estimate body; historical PF shown as review context.",
    ),
    "general_medical_management": TemplateConfig(
        key="general_medical_management",
        template_name="General Medical Management",
        template_registry_id="8a462ef1-514a-4649-a2db-7b062b295bfe",
        management_type_filter="Medical",
        daycare_mode="exclude",
        require_complete_bill=True,
        require_surgical_medical=True,
        modeled_pf_compare=False,
        pharmacy_per_ip_path=None,
        estimate_behavior="PF kept review-only; no derived PF branch in estimate body.",
    ),
    "chemotherapy_systemic_therapy_infusion": TemplateConfig(
        key="chemotherapy_systemic_therapy_infusion",
        template_name="Chemotherapy / Systemic Therapy Infusion",
        template_registry_id="38cb53d6-8b4c-4118-bff4-0a641743edcd",
        management_type_filter="Medical",
        daycare_mode="exclude",
        require_complete_bill=True,
        require_surgical_medical=True,
        modeled_pf_compare=False,
        pharmacy_per_ip_path=None,
        estimate_behavior="PF kept review-only; service-driven/historical insight only.",
    ),
    "chemotherapy_systemic_therapy_infusion_daycare_surgical": TemplateConfig(
        key="chemotherapy_systemic_therapy_infusion_daycare_surgical",
        template_name="Chemotherapy / Systemic Therapy Infusion",
        template_registry_id="38cb53d6-8b4c-4118-bff4-0a641743edcd",
        management_type_filter="Surgical",
        daycare_mode="only",
        require_complete_bill=True,
        require_surgical_medical=True,
        modeled_pf_compare=False,
        pharmacy_per_ip_path=None,
        estimate_behavior="PF kept review-only for surgical day-care cohort.",
    ),
    "chemotherapy_systemic_therapy_infusion_daycare_medical": TemplateConfig(
        key="chemotherapy_systemic_therapy_infusion_daycare_medical",
        template_name="Chemotherapy / Systemic Therapy Infusion",
        template_registry_id="38cb53d6-8b4c-4118-bff4-0a641743edcd",
        management_type_filter="Medical",
        daycare_mode="only",
        require_complete_bill=True,
        require_surgical_medical=True,
        modeled_pf_compare=False,
        pharmacy_per_ip_path=None,
        estimate_behavior="PF kept review-only for medical day-care cohort.",
    ),
    "chemotherapy_systemic_therapy_infusion_daycare_all": TemplateConfig(
        key="chemotherapy_systemic_therapy_infusion_daycare_all",
        template_name="Chemotherapy / Systemic Therapy Infusion",
        template_registry_id="38cb53d6-8b4c-4118-bff4-0a641743edcd",
        management_type_filter="All",
        daycare_mode="only",
        require_complete_bill=True,
        require_surgical_medical=True,
        modeled_pf_compare=False,
        pharmacy_per_ip_path=None,
        estimate_behavior="PF kept review-only for all day-care cohort.",
    ),
    "coronary_angio_cag_cat_1_daycare_surgical": TemplateConfig(
        key="coronary_angio_cag_cat_1_daycare_surgical",
        template_name="CORONARY ANGIOGRAM (CAG) - CAT - 1",
        template_registry_id="d3437aaa-7ad7-4fc6-a065-c9176694d637",
        management_type_filter="Surgical",
        daycare_mode="only",
        require_complete_bill=True,
        require_surgical_medical=True,
        modeled_pf_compare=False,
        pharmacy_per_ip_path=None,
        estimate_behavior="PF kept review-only for cath-lab day-care cohort.",
    ),
    "coronary_angio_cag_cat_1_daycare_all": TemplateConfig(
        key="coronary_angio_cag_cat_1_daycare_all",
        template_name="CORONARY ANGIOGRAM (CAG) - CAT - 1",
        template_registry_id="d3437aaa-7ad7-4fc6-a065-c9176694d637",
        management_type_filter="All",
        daycare_mode="only",
        require_complete_bill=True,
        require_surgical_medical=True,
        modeled_pf_compare=False,
        pharmacy_per_ip_path=None,
        estimate_behavior="PF kept review-only for cath-lab day-care cohort.",
    ),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export professional-fee analytics for FC builders.")
    parser.add_argument(
        "--template-key",
        action="append",
        choices=sorted(TEMPLATE_CONFIGS.keys()),
        help="Specific template key to export. Repeat to export multiple templates. Defaults to all first-rollout templates.",
    )
    parser.add_argument("--template-registry-id", default="")
    parser.add_argument("--template-name", default="")
    parser.add_argument("--output-key", default="")
    parser.add_argument("--management-type-filter", default="Surgical", choices=["All", "Surgical", "Medical"])
    parser.add_argument("--daycare-mode", default="exclude", choices=["exclude", "only", "include"])
    parser.add_argument("--pharmacy-per-ip-path", type=Path)
    parser.add_argument("--estimate-behavior", default="Cash formula in estimate body; historical PF shown as review context.")
    parser.add_argument("--modeled-pf-compare", action="store_true")
    parser.add_argument("--no-modeled-pf-compare", action="store_true")
    parser.add_argument("--require-complete-bill", action="store_true")
    parser.add_argument("--no-require-complete-bill", action="store_true")
    parser.add_argument("--require-surgical-medical", action="store_true")
    parser.add_argument("--no-require-surgical-medical", action="store_true")
    parser.add_argument("--output-root", type=Path, default=OUTPUT_ROOT)
    parser.add_argument("--service-mapping", type=Path, default=DEFAULT_SERVICE_MAPPING)
    return parser.parse_args()


def load_csv_rows(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8-sig") as handle:
        return list(csv.DictReader(handle))


def write_csv(path: Path, fieldnames: list[str], rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def load_service_mapping(path: Path) -> tuple[dict[str, dict[str, str]], dict[str, dict[str, str]]]:
    by_code: dict[str, dict[str, str]] = {}
    by_name: dict[str, dict[str, str]] = {}
    for row in load_csv_rows(path):
        payload = {
            "fc_estimate_bucket": normalize(row.get("FC_Estimate_Bucket")),
            "grouping": normalize(row.get("Grouping")),
        }
        code = normalize_code(row.get("item_code"))
        name = normalize(row.get("item_name"))
        if code:
            by_code[code] = payload
        if name:
            by_name[name] = payload
    return by_code, by_name


def fetch_case_contexts(config: TemplateConfig) -> list[dict[str, Any]]:
    where_clause, filter_params = build_case_filter_clause(
        mt_alias="mt",
        payor_expr="src.payor_bucket",
        payor_bucket="",
        payor_basis="All Payers",
        daycare_mode=config.daycare_mode,
        management_type_filter=config.management_type_filter,
        require_complete_bill=config.require_complete_bill,
        require_surgical_medical=config.require_surgical_medical,
    )
    query = f"""
    select distinct
        src.admission_no,
        mt.patient_name,
        coalesce(trim(mt.payor_bucket), '') as payor_bucket,
        coalesce(trim(mt.organization_cd), '') as organization_cd,
        coalesce(trim(mt.surgical_medical), '') as surgical_medical,
        coalesce(mt.is_daycare_broad, false) as is_daycare_broad,
        coalesce(trim(mt.room_category), '') as room_category,
        coalesce(mt.los_days, 0)::float8 as los_days
    from curation.template_export_case_fast_source src
    join mart.main_table mt
      on mt.admission_no = src.admission_no
    where src.template_registry_id = %s::uuid
      and {where_clause}
    order by src.admission_no
    """
    params: list[Any] = [config.template_registry_id, *filter_params]
    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute(query, params)
            rows = cur.fetchall()
    return [
        {
            "admission_no": normalize(row[0]),
            "patient_name": normalize(row[1]),
            "payor_bucket": normalize(row[2]),
            "organization_cd": normalize_code(row[3]),
            "surgical_medical": normalize(row[4]),
            "is_daycare_broad": bool(row[5]),
            "room_category": normalize(row[6]),
            "los_days": float(row[7] or 0),
        }
        for row in rows
    ]


def classify_pf_family(
    *,
    fc_bucket: str,
    item_code: str,
    item_name: str,
    sub_head: str,
) -> str:
    bucket = normalize(fc_bucket)
    name_upper = normalize(item_name).upper()
    sub_head_upper = normalize(sub_head).upper()
    assistant_surgeon = any(signal in name_upper for signal in ASSISTANT_SURGEON_SIGNALS) or item_code == "D000005"
    assistant_anesthetist = any(signal in name_upper for signal in ASSISTANT_ANESTHETIST_SIGNALS) or item_code == "DM140"

    if bucket == "Anesthetist - General - Needed":
        return "anesthetist_general_needed"
    if bucket == "Doctors & Professionals - General - Needed":
        return "professional_general_needed"
    if bucket == "Anesthetist - General - Remove":
        if assistant_anesthetist:
            return "assistant_anesthetist_named"
        return "anesthetist_general_remove"
    if bucket == "Doctors & Professionals - General - Remove":
        if assistant_surgeon:
            return "assistant_surgeon_named"
        return "professional_general_remove"
    if bucket == "Anesthetist - Name Wise - Remove":
        if assistant_anesthetist:
            return "assistant_anesthetist_named"
        return "anesthetist_named"
    if bucket == "Doctors & Professionals - Name Wise - Remove":
        if assistant_surgeon:
            return "assistant_surgeon_named"
        if sub_head_upper in SURGICAL_SUBHEAD_HINTS:
            return "surgeon_named"
        return "consultant_or_physician_named"
    return "non_pf_service"


def classify_pf_shape(row: dict[str, float | str]) -> str:
    pf_total = float(row.get("pf_total_all_rows", 0) or 0)
    pf_named = float(row.get("pf_named_total", 0) or 0)
    pf_general_needed = float(row.get("pf_general_needed_total", 0) or 0)
    surgeon = float(row.get("surgeon_named_total", 0) or 0)
    assistant_surgeon = float(row.get("assistant_surgeon_named_total", 0) or 0)
    anesthetist = float(row.get("anesthetist_named_total", 0) or 0)
    assistant_anesthetist = float(row.get("assistant_anesthetist_named_total", 0) or 0)
    consultant = float(row.get("consultant_or_physician_named_total", 0) or 0)
    payor_bucket = normalize(row.get("payor_bucket"))

    if pf_total <= 0:
        return "no_pf_rows"
    if payor_bucket != "Cash" and surgeon <= 0 and anesthetist <= 0 and pf_general_needed > 0:
        return "insurance_sparse_pf"
    if surgeon > 0 and anesthetist > 0 and assistant_surgeon > 0 and assistant_anesthetist > 0:
        return "cash_formula_like"
    if pf_named > (pf_general_needed * 2) and pf_named > 0:
        return "named_doctor_heavy"
    if pf_general_needed > 0 and pf_named <= 0:
        return "general_professional_only"
    if consultant > 0 and surgeon <= 0 and anesthetist <= 0 and pf_general_needed <= 0:
        return "consultation_only"
    return "mixed_pf_shape"


def build_pharmacy_lookup(path: Path | None) -> dict[str, float]:
    if not path or not path.exists():
        return {}
    lookup: dict[str, float] = {}
    for row in load_csv_rows(path):
        admission_no = normalize(row.get("admission_no"))
        if not admission_no:
            continue
        pharmacy_total = sum(
            float(normalize(row.get(field)) or 0)
            for field in [
                "ip_drugs_amount_net",
                "ip_treatment_supplies_amount_net",
                "ot_drugs_amount_net",
                "ot_treatment_supplies_amount_net",
                "implants_amount_net",
            ]
        )
        lookup[admission_no] = pharmacy_total
    return lookup


def rounded_pct(numerator: float, denominator: int) -> str:
    if denominator <= 0:
        return "0"
    return format_number((numerator / denominator) * 100.0)


def percentile_row(values: list[float]) -> tuple[str, str, str]:
    q1, q2, q3 = inclusive_quartiles(values)
    return format_number(q1), format_number(q2), format_number(q3)


def build_outputs_for_template(
    config: TemplateConfig,
    *,
    output_root: Path,
    service_mapping_by_code: dict[str, dict[str, str]],
    service_mapping_by_name: dict[str, dict[str, str]],
) -> dict[str, Any]:
    context_rows = fetch_case_contexts(config)
    context_by_admission = {row["admission_no"]: row for row in context_rows}
    service_rows = fetch_service_metric_rows(
        config.template_registry_id,
        "",
        "All Payers",
        config.daycare_mode,
        config.management_type_filter,
        config.require_complete_bill,
        config.require_surgical_medical,
    )
    pharmacy_lookup = build_pharmacy_lookup(config.pharmacy_per_ip_path)
    per_ip: dict[str, dict[str, Any]] = {}

    for context in context_rows:
        admission_no = context["admission_no"]
        pharmacy_total = pharmacy_lookup.get(admission_no, 0.0)
        drug_admin = 0.125 * pharmacy_total if config.modeled_pf_compare else 0.0
        per_ip[admission_no] = {
            "admission_no": admission_no,
            "patient_name": context["patient_name"],
            "display_name": config.template_name,
            "template_registry_id": config.template_registry_id,
            "payor_bucket": context["payor_bucket"],
            "organization_cd": context["organization_cd"],
            "surgical_medical": context["surgical_medical"],
            "is_daycare_broad": "Yes" if context["is_daycare_broad"] else "No",
            "room_category": context["room_category"],
            "los_days": format_number(context["los_days"]),
            "surgeon_named_total": 0.0,
            "assistant_surgeon_named_total": 0.0,
            "anesthetist_named_total": 0.0,
            "assistant_anesthetist_named_total": 0.0,
            "consultant_or_physician_named_total": 0.0,
            "professional_general_needed_component": 0.0,
            "anesthetist_general_needed_component": 0.0,
            "professional_general_remove_component": 0.0,
            "anesthetist_general_remove_component": 0.0,
            "pf_named_total": 0.0,
            "pf_general_needed_total": 0.0,
            "pf_general_remove_total": 0.0,
            "pf_collectible_historical_total": 0.0,
            "pf_non_collectible_total": 0.0,
            "pf_total_all_rows": 0.0,
            "pre_pf_non_pharmacy_subtotal_actual": 0.0,
            "pre_pf_builder_subtotal_actual": 0.0,
            "modeled_pf_cash_formula": "",
            "service_pf_row_count": 0,
            "pf_shape_label": "",
            "_shape_counts": Counter(),
        }

    for row in service_rows:
        context = context_by_admission.get(row.admission_no)
        if not context:
            continue
        mapped = service_mapping_by_code.get(row.item_code) or service_mapping_by_name.get(row.item_name) or {}
        family = classify_pf_family(
            fc_bucket=mapped.get("fc_estimate_bucket", ""),
            item_code=row.item_code,
            item_name=row.item_name,
            sub_head=row.sub_head,
        )
        target = per_ip[row.admission_no]
        amount = float(row.amount or 0)
        if family == "non_pf_service":
            target["pre_pf_non_pharmacy_subtotal_actual"] += amount
            if "cross consult" not in normalize(row.item_name).lower() and not row.item_code.startswith("CC"):
                target["pre_pf_builder_subtotal_actual"] += amount
            continue
        target["service_pf_row_count"] += 1
        target["_shape_counts"][family] += 1
        target["pf_total_all_rows"] += amount
        if family == "surgeon_named":
            target["surgeon_named_total"] += amount
        elif family == "assistant_surgeon_named":
            target["assistant_surgeon_named_total"] += amount
        elif family == "anesthetist_named":
            target["anesthetist_named_total"] += amount
        elif family == "assistant_anesthetist_named":
            target["assistant_anesthetist_named_total"] += amount
        elif family == "consultant_or_physician_named":
            target["consultant_or_physician_named_total"] += amount
        elif family == "professional_general_needed":
            target["professional_general_needed_component"] += amount
        elif family == "anesthetist_general_needed":
            target["anesthetist_general_needed_component"] += amount
        elif family == "professional_general_remove":
            target["professional_general_remove_component"] += amount
        elif family == "anesthetist_general_remove":
            target["anesthetist_general_remove_component"] += amount

    for admission_no, target in per_ip.items():
        target["pre_pf_builder_subtotal_actual"] += pharmacy_lookup.get(admission_no, 0.0)
        if config.modeled_pf_compare:
            target["pre_pf_builder_subtotal_actual"] += 0.125 * pharmacy_lookup.get(admission_no, 0.0)
        target["pf_named_total"] = (
            target["surgeon_named_total"]
            + target["assistant_surgeon_named_total"]
            + target["anesthetist_named_total"]
            + target["assistant_anesthetist_named_total"]
            + target["consultant_or_physician_named_total"]
        )
        target["pf_general_needed_total"] = (
            target["professional_general_needed_component"]
            + target["anesthetist_general_needed_component"]
        )
        target["pf_general_remove_total"] = (
            target["professional_general_remove_component"]
            + target["anesthetist_general_remove_component"]
        )
        target["pf_collectible_historical_total"] = target["pf_named_total"] + target["pf_general_needed_total"]
        target["pf_non_collectible_total"] = target["pf_general_remove_total"]
        target["pf_shape_label"] = classify_pf_shape(target)
        if config.modeled_pf_compare:
            modeled_pf = 0.365625 * float(target["pre_pf_builder_subtotal_actual"] or 0.0)
            target["modeled_pf_cash_formula"] = format_number(modeled_pf)

    per_ip_rows: list[dict[str, Any]] = []
    modeled_vs_actual_rows: list[dict[str, Any]] = []
    payor_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)

    for admission_no in sorted(per_ip):
        row = per_ip[admission_no]
        output_row = {
            "admission_no": row["admission_no"],
            "patient_name": row["patient_name"],
            "display_name": row["display_name"],
            "template_registry_id": row["template_registry_id"],
            "payor_bucket": row["payor_bucket"],
            "organization_cd": row["organization_cd"],
            "surgical_medical": row["surgical_medical"],
            "is_daycare_broad": row["is_daycare_broad"],
            "room_category": row["room_category"],
            "los_days": row["los_days"],
            "pf_named_total": format_number(row["pf_named_total"]),
            "pf_general_needed_total": format_number(row["pf_general_needed_total"]),
            "pf_general_remove_total": format_number(row["pf_general_remove_total"]),
            "pf_collectible_historical_total": format_number(row["pf_collectible_historical_total"]),
            "pf_non_collectible_total": format_number(row["pf_non_collectible_total"]),
            "surgeon_named_total": format_number(row["surgeon_named_total"]),
            "assistant_surgeon_named_total": format_number(row["assistant_surgeon_named_total"]),
            "anesthetist_named_total": format_number(row["anesthetist_named_total"]),
            "assistant_anesthetist_named_total": format_number(row["assistant_anesthetist_named_total"]),
            "consultant_or_physician_named_total": format_number(row["consultant_or_physician_named_total"]),
            "professional_general_needed_component": format_number(row["professional_general_needed_component"]),
            "anesthetist_general_needed_component": format_number(row["anesthetist_general_needed_component"]),
            "professional_general_remove_component": format_number(row["professional_general_remove_component"]),
            "anesthetist_general_remove_component": format_number(row["anesthetist_general_remove_component"]),
            "pre_pf_non_pharmacy_subtotal_actual": format_number(row["pre_pf_non_pharmacy_subtotal_actual"]),
            "pre_pf_builder_subtotal_actual": format_number(row["pre_pf_builder_subtotal_actual"]),
            "service_pf_row_count": str(int(row["service_pf_row_count"] or 0)),
            "pf_shape_label": row["pf_shape_label"],
        }
        if config.modeled_pf_compare:
            actual_pf = float(row["pf_collectible_historical_total"] or 0.0)
            modeled_pf = float(normalize(row["modeled_pf_cash_formula"]) or 0.0)
            diff = actual_pf - modeled_pf
            pct_diff = (diff / actual_pf * 100.0) if actual_pf else 0.0
            output_row["modeled_pf_cash_formula"] = format_number(modeled_pf)
            modeled_vs_actual_rows.append(
                {
                    "admission_no": row["admission_no"],
                    "patient_name": row["patient_name"],
                    "payor_bucket": row["payor_bucket"],
                    "pre_pf_builder_subtotal_actual": format_number(row["pre_pf_builder_subtotal_actual"]),
                    "modeled_pf_cash_formula": format_number(modeled_pf),
                    "actual_pf_collectible_historical_total": format_number(actual_pf),
                    "difference": format_number(diff),
                    "pct_difference_vs_actual": format_number(pct_diff),
                }
            )
        per_ip_rows.append(output_row)
        payor_groups[row["payor_bucket"]].append(row)

    summary_rows: list[dict[str, Any]] = []
    for payor_bucket in PAYOR_BUCKET_ORDER:
        summary_rows.append(summarize_payor_rows(config, payor_bucket, payor_groups.get(payor_bucket, [])))
    insurance_rows = payor_groups.get("GIPSA Insurance", []) + payor_groups.get("Non-GIPSA Insurance", [])
    summary_rows.append(summarize_payor_rows(config, "Insurance All", insurance_rows))
    summary_rows.append(summarize_payor_rows(config, "All Payers", list(per_ip.values())))

    dominant_shapes = {row["payor_bucket"]: row["dominant_pf_shape"] for row in summary_rows if row["admission_count"] not in {"0", ""}}
    collectible_medians = {
        row["payor_bucket"]: float(normalize(row.get("pf_collectible_historical_total_p50")) or 0.0)
        for row in summary_rows
        if row["payor_bucket"] not in {"Insurance All"} and int(float(normalize(row["admission_count"]) or 0)) >= 5
    }
    payer_sensitive = "No"
    if len(collectible_medians) >= 2:
        median_values = [value for value in collectible_medians.values() if value > 0]
        if len(median_values) >= 2:
            spread = max(median_values) - min(median_values)
            denom = max(1.0, statistics_median(median_values))
            payer_sensitive = "Yes" if (spread / denom) >= 0.25 else "No"
    distinct_shapes = {shape for shape in dominant_shapes.values() if shape}
    mixed_billing_shape = "Yes" if len(distinct_shapes) > 1 else "No"
    stable_across_payers = "Yes" if payer_sensitive == "No" and len(distinct_shapes) <= 1 else "No"
    shape_review = {
        "template_key": config.key,
        "template_name": config.template_name,
        "estimate_behavior": config.estimate_behavior,
        "cohort_filters": {
            "daycare_mode": config.daycare_mode,
            "management_type_filter": config.management_type_filter,
            "require_complete_bill": config.require_complete_bill,
            "require_surgical_medical": config.require_surgical_medical,
        },
        "overall": {
            "payer_sensitive": payer_sensitive,
            "mixed_billing_shape": mixed_billing_shape,
            "stable_across_payers": stable_across_payers,
            "package_override_expected_later": "Yes",
            "note": "PF insight is review-only in this pass; package-level PF handling remains a later layer.",
        },
        "payor_reviews": [
            {
                "payor_bucket": row["payor_bucket"],
                "admission_count": row["admission_count"],
                "dominant_pf_shape": row["dominant_pf_shape"],
                "pf_collectible_historical_total_p50": row["pf_collectible_historical_total_p50"],
            }
            for row in summary_rows
        ],
    }

    template_output_dir = output_root / config.key
    write_csv(
        template_output_dir / f"01_pf_actuals_per_ip_{config.key}.csv",
        list(per_ip_rows[0].keys()) if per_ip_rows else [
            "admission_no",
            "patient_name",
            "display_name",
            "template_registry_id",
            "payor_bucket",
            "organization_cd",
            "surgical_medical",
            "is_daycare_broad",
            "room_category",
            "los_days",
        ],
        per_ip_rows,
    )
    write_csv(
        template_output_dir / f"02_pf_payor_summary_{config.key}.csv",
        list(summary_rows[0].keys()) if summary_rows else ["payor_bucket", "admission_count"],
        summary_rows,
    )
    if config.modeled_pf_compare:
        write_csv(
            template_output_dir / f"03_pf_modeled_vs_actual_{config.key}.csv",
            list(modeled_vs_actual_rows[0].keys()) if modeled_vs_actual_rows else ["admission_no", "modeled_pf_cash_formula", "actual_pf_collectible_historical_total"],
            modeled_vs_actual_rows,
        )
    (template_output_dir / f"04_pf_shape_review_{config.key}.json").write_text(
        json.dumps(shape_review, indent=2),
        encoding="utf-8",
    )
    return {
        "config": config,
        "summary_rows": summary_rows,
        "shape_review": shape_review,
    }


def summarize_payor_rows(config: TemplateConfig, payor_bucket: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
    admission_count = len(rows)

    def values(field: str) -> list[float]:
        return [float(row.get(field, 0) or 0.0) for row in rows]

    def prevalence(field: str) -> str:
        positive = sum(1 for row in rows if float(row.get(field, 0) or 0.0) > 0)
        return rounded_pct(positive, admission_count)

    named_q1, named_q2, named_q3 = percentile_row(values("pf_named_total"))
    general_q1, general_q2, general_q3 = percentile_row(values("pf_general_needed_total"))
    collectible_q1, collectible_q2, collectible_q3 = percentile_row(values("pf_collectible_historical_total"))
    non_collect_q1, non_collect_q2, non_collect_q3 = percentile_row(values("pf_non_collectible_total"))
    surgeon_q1, surgeon_q2, surgeon_q3 = percentile_row(values("surgeon_named_total"))
    assistant_surgeon_q1, assistant_surgeon_q2, assistant_surgeon_q3 = percentile_row(values("assistant_surgeon_named_total"))
    anesth_q1, anesth_q2, anesth_q3 = percentile_row(values("anesthetist_named_total"))
    assistant_anesth_q1, assistant_anesth_q2, assistant_anesth_q3 = percentile_row(values("assistant_anesthetist_named_total"))
    consultant_q1, consultant_q2, consultant_q3 = percentile_row(values("consultant_or_physician_named_total"))
    dominant_shape = Counter(str(row.get("pf_shape_label") or "") for row in rows).most_common(1)
    return {
        "template_key": config.key,
        "template_name": config.template_name,
        "template_registry_id": config.template_registry_id,
        "payor_bucket": payor_bucket,
        "admission_count": str(admission_count),
        "pf_named_total_p25": named_q1,
        "pf_named_total_p50": named_q2,
        "pf_named_total_p75": named_q3,
        "pf_general_needed_total_p25": general_q1,
        "pf_general_needed_total_p50": general_q2,
        "pf_general_needed_total_p75": general_q3,
        "pf_collectible_historical_total_p25": collectible_q1,
        "pf_collectible_historical_total_p50": collectible_q2,
        "pf_collectible_historical_total_p75": collectible_q3,
        "pf_non_collectible_total_p25": non_collect_q1,
        "pf_non_collectible_total_p50": non_collect_q2,
        "pf_non_collectible_total_p75": non_collect_q3,
        "surgeon_named_total_p25": surgeon_q1,
        "surgeon_named_total_p50": surgeon_q2,
        "surgeon_named_total_p75": surgeon_q3,
        "assistant_surgeon_named_total_p25": assistant_surgeon_q1,
        "assistant_surgeon_named_total_p50": assistant_surgeon_q2,
        "assistant_surgeon_named_total_p75": assistant_surgeon_q3,
        "anesthetist_named_total_p25": anesth_q1,
        "anesthetist_named_total_p50": anesth_q2,
        "anesthetist_named_total_p75": anesth_q3,
        "assistant_anesthetist_named_total_p25": assistant_anesth_q1,
        "assistant_anesthetist_named_total_p50": assistant_anesth_q2,
        "assistant_anesthetist_named_total_p75": assistant_anesth_q3,
        "consultant_or_physician_named_total_p25": consultant_q1,
        "consultant_or_physician_named_total_p50": consultant_q2,
        "consultant_or_physician_named_total_p75": consultant_q3,
        "surgeon_row_prevalence_pct": prevalence("surgeon_named_total"),
        "assistant_surgeon_row_prevalence_pct": prevalence("assistant_surgeon_named_total"),
        "anesthetist_row_prevalence_pct": prevalence("anesthetist_named_total"),
        "assistant_anesthetist_row_prevalence_pct": prevalence("assistant_anesthetist_named_total"),
        "consultant_or_physician_row_prevalence_pct": prevalence("consultant_or_physician_named_total"),
        "any_pf_row_prevalence_pct": prevalence("pf_total_all_rows"),
        "dominant_pf_shape": dominant_shape[0][0] if dominant_shape else "",
    }


def statistics_median(values: list[float]) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    mid = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return float(ordered[mid])
    return float((ordered[mid - 1] + ordered[mid]) / 2.0)


def build_master_summary(output_root: Path) -> None:
    rows: list[dict[str, Any]] = []
    for config in TEMPLATE_CONFIGS.values():
        summary_path = output_root / config.key / f"02_pf_payor_summary_{config.key}.csv"
        shape_path = output_root / config.key / f"04_pf_shape_review_{config.key}.json"
        shape_review = json.loads(shape_path.read_text(encoding="utf-8")) if shape_path.exists() else {}
        overall = shape_review.get("overall") or {}
        for row in load_csv_rows(summary_path) if summary_path.exists() else []:
            rows.append(
                {
                    **row,
                    "payer_sensitive": overall.get("payer_sensitive", ""),
                    "mixed_billing_shape": overall.get("mixed_billing_shape", ""),
                    "stable_across_payers": overall.get("stable_across_payers", ""),
                    "package_override_expected_later": overall.get("package_override_expected_later", ""),
                }
            )
    if not rows:
        return
    write_csv(output_root / "pf_payor_comparison_master.csv", list(rows[0].keys()), rows)


def build_template_config_from_args(args: argparse.Namespace) -> TemplateConfig | None:
    template_registry_id = normalize(args.template_registry_id)
    template_name = normalize(args.template_name)
    if not template_registry_id and not template_name:
        return None
    output_key = normalize(args.output_key) or normalize(template_name).lower().replace(" ", "_").replace("/", "_")
    require_complete_bill = True
    if args.no_require_complete_bill:
        require_complete_bill = False
    elif args.require_complete_bill:
        require_complete_bill = True
    require_surgical_medical = True
    if args.no_require_surgical_medical:
        require_surgical_medical = False
    elif args.require_surgical_medical:
        require_surgical_medical = True
    modeled_pf_compare = True if args.modeled_pf_compare else False
    if args.no_modeled_pf_compare:
        modeled_pf_compare = False
    return TemplateConfig(
        key=output_key,
        template_name=template_name,
        template_registry_id=template_registry_id,
        management_type_filter=args.management_type_filter,
        daycare_mode=args.daycare_mode,
        require_complete_bill=require_complete_bill,
        require_surgical_medical=require_surgical_medical,
        modeled_pf_compare=modeled_pf_compare,
        pharmacy_per_ip_path=args.pharmacy_per_ip_path,
        estimate_behavior=normalize(args.estimate_behavior),
    )


def main() -> None:
    args = parse_args()
    service_mapping_by_code, service_mapping_by_name = load_service_mapping(args.service_mapping)
    args.output_root.mkdir(parents=True, exist_ok=True)
    arg_config = build_template_config_from_args(args)
    if arg_config is not None:
        build_outputs_for_template(
            arg_config,
            output_root=args.output_root,
            service_mapping_by_code=service_mapping_by_code,
            service_mapping_by_name=service_mapping_by_name,
        )
    else:
        selected_keys = args.template_key or list(TEMPLATE_CONFIGS.keys())
        for key in selected_keys:
            build_outputs_for_template(
                TEMPLATE_CONFIGS[key],
                output_root=args.output_root,
                service_mapping_by_code=service_mapping_by_code,
                service_mapping_by_name=service_mapping_by_name,
            )
        build_master_summary(args.output_root)
    print(f"output_root={args.output_root}")


if __name__ == "__main__":
    main()
