from __future__ import annotations

import argparse
import csv
import json
import subprocess
import sys
from pathlib import Path

from fc_payer_basis_resolution import build_cash_fallback_resolution_rows, write_resolution_csv
from scripts.etl.fc_estimate.variant_manifest import get_variant


VARIANT = get_variant("general_medical_management_cash")
REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = VARIANT.output_dir
DEFAULT_OUTPUT = REPO_ROOT / "output" / "fc_estimate_builder_general_medical_management_cash_tr1.xlsx"
DEFAULT_PHASE1 = REPO_ROOT / "scripts" / "export_general_medical_management_cash_fc_phase1.py"
DEFAULT_TARIFF_EXPORT = REPO_ROOT / "scripts" / "export_tariff_rate_csv.py"
DEFAULT_BUILDER = REPO_ROOT / "scripts" / "build_general_medical_management_cash_fc_estimate_builder.py"
DEFAULT_CATH_LAB_EXPORT = REPO_ROOT / "scripts" / "export_cath_lab_family_metrics.py"
DEFAULT_CATH_LAB_SLOT_EXPORT = REPO_ROOT / "scripts" / "export_cath_lab_slot_rate_csv.py"
DEFAULT_PF_ANALYSIS = REPO_ROOT / "scripts" / "export_fc_professional_fee_analysis.py"
DEFAULT_ACTUALS_EXPORT = REPO_ROOT / "scripts" / "export_general_medical_management_all_cash_fc_rollup_reconciled.py"
DEFAULT_COHORT_AUDIT = REPO_ROOT / "scripts" / "export_fc_cohort_audit.py"
DEFAULT_SHORT_STAY_IMPACT_AUDIT = REPO_ROOT / "scripts" / "export_short_stay_non_daycare_impact_audit.py"
DEFAULT_SHORT_STAY_SUMMARY = REPO_ROOT / "scripts" / "export_short_stay_non_daycare_summary.py"
DEFAULT_PAYER_BASIS_RESOLUTION = DEFAULT_OUTPUT_DIR / "30_payer_basis_resolution_summary.csv"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build the General Medical Management cash/TR1 FC estimate workbook."
    )
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--python-bin", default=sys.executable)
    return parser.parse_args()


def run_command(args: list[str]) -> None:
    subprocess.run(args, check=True, cwd=REPO_ROOT)


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def load_csv_rows(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8-sig") as handle:
        return list(csv.DictReader(handle))


def main() -> None:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    run_command(
        [
            args.python_bin,
            str(DEFAULT_PHASE1),
            "--include-services",
            "--include-room-metrics",
            "--output-dir",
            str(args.output_dir),
        ]
    )

    rate_output = args.output_dir / "tr1_cash_rates_general_medical_management_full_codes.csv"
    cath_lab_metrics_output = args.output_dir / "17_cath_lab_metrics_cash.json"
    cath_lab_slot_output = args.output_dir / "18_cath_lab_slot_rates_tr1.csv"
    pf_output_dir = REPO_ROOT / "output" / "fc_professional_fee_analysis" / "general_medical_management"
    cleaned_services = args.output_dir / "11_clean_chemo_services_template_for_fc_cash.csv"
    run_command(
        [
            args.python_bin,
            str(DEFAULT_TARIFF_EXPORT),
            "--tariff-code",
            "TR1",
            "--output",
            str(rate_output),
            "--codes-csv",
            str(cleaned_services),
            "--item-code",
            "ROM0001",
            "--item-code",
            "ROM0024",
            "--item-code",
            "ROM0036",
            "--item-code",
            "ROM5009",
            "--item-code",
            "ROM5189",
            "--item-code",
            "ROM0093",
            "--item-code",
            "HSP5013",
            "--item-code",
            "ICC0001",
            "--item-code",
            "ICC0002",
            "--item-code",
            "EME0019",
        ]
    )

    run_command(
        [
            args.python_bin,
            str(DEFAULT_CATH_LAB_EXPORT),
            "--template-registry-id",
            VARIANT.template_registry_id,
            "--template-name",
            VARIANT.template_name,
            "--payor-bucket",
            "Cash",
            "--daycare-mode",
            "exclude" if VARIANT.stay_type == "non_daycare" else "all",
            "--management-type-filter",
            VARIANT.management_type,
            "--require-complete-bill",
            "--require-surgical-medical",
            "--summary-output",
            str(cath_lab_metrics_output),
            "--per-ip-output",
            str(args.output_dir / "19_cath_lab_per_ip_cash.csv"),
        ]
    )

    run_command(
        [
            args.python_bin,
            str(DEFAULT_CATH_LAB_SLOT_EXPORT),
            "--tariff-code",
            "TR1",
            "--output",
            str(cath_lab_slot_output),
        ]
    )

    run_command(
        [
            args.python_bin,
            str(DEFAULT_PF_ANALYSIS),
            "--template-key",
            "general_medical_management",
        ]
    )

    run_command(
        [
            args.python_bin,
            str(DEFAULT_COHORT_AUDIT),
            "--template-registry-id",
            VARIANT.template_registry_id,
            "--template-name",
            VARIANT.template_name,
            "--payor-bucket",
            "Cash",
            "--stay-type-filter",
            "non_daycare",
            "--management-type-filter",
            VARIANT.management_type,
            "--require-complete-bill",
            "--require-surgical-medical",
            "--output",
            str(args.output_dir / "00_fc_cohort_audit_non_daycare_medical_cash.json"),
        ]
    )

    run_command(
        [
            args.python_bin,
            str(DEFAULT_ACTUALS_EXPORT),
            "--output-dir",
            str(args.output_dir),
        ]
    )

    run_command(
        [
            args.python_bin,
            str(DEFAULT_SHORT_STAY_IMPACT_AUDIT),
            "--rollup-csv",
            str(args.output_dir / "18a_all_cash_patients_fc_bucket_rollup_reconciled.csv"),
            "--template-name",
            VARIANT.template_name,
            "--output-csv",
            str(args.output_dir / "31_short_stay_non_daycare_impact_audit.csv"),
            "--output-json",
            str(args.output_dir / "31_short_stay_non_daycare_impact_audit.json"),
        ]
    )

    run_command(
        [
            args.python_bin,
            str(DEFAULT_SHORT_STAY_SUMMARY),
        ]
    )

    service_line_payload = load_json(args.output_dir / "14_service_line_count_metrics_cash.json")
    ip_pharmacy_rows = load_csv_rows(args.output_dir / "05_ip_bucket_los_normalized_percentiles_cash.csv")
    pf_rows = load_csv_rows(pf_output_dir / "02_pf_payor_summary_general_medical_management.csv")
    service_anchor = float((service_line_payload.get("cleaned_distinct_service_line_count") or {}).get("p50") or 0.0)
    pharmacy_anchor = 0.0
    for row in ip_pharmacy_rows:
        if str(row.get("metric") or "").strip() == "ip_drugs_per_day":
            pharmacy_anchor = float(row.get("p50") or 0.0)
            break
    pf_anchor = 0.0
    for row in pf_rows:
        if str(row.get("payor_bucket") or "").strip() == "Cash":
            pf_anchor = float(row.get("pf_collectible_historical_total_p50") or 0.0)
            break
    write_resolution_csv(
        DEFAULT_PAYER_BASIS_RESOLUTION,
        build_cash_fallback_resolution_rows(
            template_name=VARIANT.template_name,
            family_kind=VARIANT.management_type.lower(),
            cash_case_count=int(service_line_payload.get("cohort_size") or 0),
            service_anchor_p50=service_anchor,
            pharmacy_anchor_p50=pharmacy_anchor,
            pf_anchor_p50=pf_anchor,
        ),
    )

    run_command(
        [
            args.python_bin,
            str(DEFAULT_BUILDER),
            "--pharmacy-template",
            str(args.output_dir / "01_clean_chemo_pharmacy_template_cash.csv"),
            "--pharmacy-per-patient",
            str(args.output_dir / "02_per_patient_pharmacy_bucket_totals_cash.csv"),
            "--ip-pharmacy-per-day",
            str(args.output_dir / "05_ip_bucket_los_normalized_percentiles_cash.csv"),
            "--services-template",
            str(args.output_dir / "10_clean_chemo_services_template_cash.csv"),
            "--cleaned-services",
            str(cleaned_services),
            "--default-services",
            str(args.output_dir / "12_default_included_services_cash.csv"),
            "--optional-services",
            str(args.output_dir / "13_optional_service_add_ons_cash.csv"),
            "--service-line-count",
            str(args.output_dir / "14_service_line_count_metrics_cash.json"),
            "--room-metrics",
            str(args.output_dir / "16_los_icu_ward_room_metrics_cash.json"),
            "--rate-csv",
            str(rate_output),
            "--cath-lab-metrics",
            str(cath_lab_metrics_output),
            "--payer-basis-resolution-csv",
            str(DEFAULT_PAYER_BASIS_RESOLUTION),
            "--ip-actuals-csv",
            str(args.output_dir / "18a_all_cash_patients_fc_bucket_rollup_reconciled.csv"),
            "--pf-payor-summary-csv",
            str(pf_output_dir / "02_pf_payor_summary_general_medical_management.csv"),
            "--pf-shape-review-json",
            str(pf_output_dir / "04_pf_shape_review_general_medical_management.json"),
            "--output",
            str(args.output),
        ]
    )

    print(f"output={args.output}")


if __name__ == "__main__":
    main()
