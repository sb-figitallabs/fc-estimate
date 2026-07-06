from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path
from typing import Any


AUTO_BASIS = "Auto (Recommended)"
PAYER_BASIS_OPTIONS = [
    "Cash",
    "GIPSA Insurance",
    "Non-GIPSA Insurance",
    "Corporate",
    "Insurance All",
    "All Payers",
]
TARGET_PAYOR_BUCKETS = [
    "Cash",
    "GIPSA Insurance",
    "Non-GIPSA Insurance",
    "Corporate",
]
COMPONENT_SERVICE = "service_basis"
COMPONENT_PHARMACY = "pharmacy_basis"
COMPONENT_PF = "pf_basis"
COMPONENTS = [COMPONENT_SERVICE, COMPONENT_PHARMACY, COMPONENT_PF]


def normalize_text(value: Any) -> str:
    return " ".join(str(value or "").strip().split())


def as_float(value: Any) -> float:
    text = normalize_text(value)
    if not text:
        return 0.0
    try:
        return float(text)
    except ValueError:
        return 0.0


def safe_ratio(numerator: float, denominator: float) -> float:
    if abs(denominator) < 1e-9:
        return 0.0
    return numerator / denominator


def clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


@dataclass
class BasisStat:
    basis: str
    case_count: int
    anchor_p25: float
    anchor_p50: float
    anchor_p75: float
    variability_score: float
    spread_vs_insurance_all: float
    spread_vs_all_payers: float


def family_exact_threshold(family_kind: str) -> int:
    normalized = normalize_text(family_kind).lower()
    if normalized in {"surgical", "daycare"}:
        return 15
    return 20


def fallback_count_threshold() -> int:
    return 25


def build_basis_stat(
    basis: str,
    case_count: Any,
    anchor_p25: Any,
    anchor_p50: Any,
    anchor_p75: Any,
    insurance_all_p50: float,
    all_payers_p50: float,
) -> BasisStat:
    p25 = as_float(anchor_p25)
    p50 = as_float(anchor_p50)
    p75 = as_float(anchor_p75)
    variability_score = abs(safe_ratio(p75 - p25, p50 if p50 else (p75 or p25 or 1.0)))
    return BasisStat(
        basis=basis,
        case_count=int(as_float(case_count)),
        anchor_p25=p25,
        anchor_p50=p50,
        anchor_p75=p75,
        variability_score=variability_score,
        spread_vs_insurance_all=abs(safe_ratio(p50 - insurance_all_p50, insurance_all_p50 or 1.0)),
        spread_vs_all_payers=abs(safe_ratio(p50 - all_payers_p50, all_payers_p50 or 1.0)),
    )


def choose_basis(
    target_payor_bucket: str,
    family_kind: str,
    component: str,
    stats_by_basis: dict[str, BasisStat],
) -> tuple[str, str, str, int]:
    exact_threshold = family_exact_threshold(family_kind)
    fallback_threshold = fallback_count_threshold()
    target = normalize_text(target_payor_bucket)

    def basis_count(label: str) -> int:
        return stats_by_basis.get(label, BasisStat(label, 0, 0, 0, 0, 0, 0, 0)).case_count

    def basis_spread(label: str) -> float:
        stat = stats_by_basis.get(label)
        return max((stat.spread_vs_insurance_all if stat else 0.0), (stat.spread_vs_all_payers if stat else 0.0))

    if target in {"GIPSA Insurance", "Non-GIPSA Insurance", "Corporate", "Cash"}:
        exact_count = basis_count(target)
        if exact_count >= exact_threshold:
            status = "recommended_exact"
            confidence = "high" if exact_count >= exact_threshold * 2 else "medium"
            reason = f"{target} has {exact_count} cases for {component} and meets the exact-basis threshold."
            return target, status, confidence, exact_count

    if target in {"GIPSA Insurance", "Non-GIPSA Insurance"}:
        insurance_all_count = basis_count("Insurance All")
        if insurance_all_count >= fallback_threshold:
            spread = basis_spread(target)
            status = "recommended_fallback_insurance_all"
            confidence = "medium" if spread <= 0.2 else "low"
            reason = (
                f"{target} exact cohort is below threshold; Insurance All has {insurance_all_count} cases and is used as the "
                f"next insurance-specific fallback for {component}."
            )
            return "Insurance All", status, confidence, insurance_all_count

    all_payers_count = basis_count("All Payers")
    if all_payers_count >= fallback_threshold:
        status = "recommended_fallback_all_payers"
        confidence = "medium"
        reason = f"All Payers has {all_payers_count} cases and is the best stable fallback for {component}."
        return "All Payers", status, confidence, all_payers_count

    cash_count = basis_count("Cash")
    status = "recommended_fallback_cash"
    confidence = "medium" if cash_count >= exact_threshold else "low"
    reason = f"Cash is used as the last fallback for {component} because broader cohorts are too small."
    return "Cash", status, confidence, cash_count


def write_resolution_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    fieldnames = [
        "template_name",
        "family_kind",
        "component",
        "target_payor_bucket",
        "basis",
        "case_count",
        "anchor_p25",
        "anchor_p50",
        "anchor_p75",
        "variability_score",
        "spread_vs_insurance_all",
        "spread_vs_all_payers",
        "recommended_status",
        "selected_basis",
        "selected_case_count",
        "confidence",
        "selection_reason",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def build_cash_fallback_resolution_rows(
    *,
    template_name: str,
    family_kind: str,
    cash_case_count: int,
    service_anchor_p50: float = 0.0,
    pharmacy_anchor_p50: float = 0.0,
    pf_anchor_p50: float = 0.0,
) -> list[dict[str, Any]]:
    component_anchor_map = {
        COMPONENT_SERVICE: service_anchor_p50,
        COMPONENT_PHARMACY: pharmacy_anchor_p50,
        COMPONENT_PF: pf_anchor_p50,
    }
    rows: list[dict[str, Any]] = []
    for component in COMPONENTS:
        anchor_p50 = component_anchor_map.get(component, 0.0)
        for target_payor_bucket in TARGET_PAYOR_BUCKETS:
            selected_basis = "Cash"
            exact_for_cash = target_payor_bucket == "Cash" and cash_case_count >= family_exact_threshold(family_kind)
            if exact_for_cash:
                recommended_status = "recommended_exact"
                confidence = "medium" if cash_case_count >= family_exact_threshold(family_kind) else "low"
                selection_reason = (
                    f"Cash selected for {component} against {target_payor_bucket}; "
                    f"recommended exact with {cash_case_count} cases."
                )
            else:
                recommended_status = "recommended_fallback_cash"
                confidence = "low" if cash_case_count < family_exact_threshold(family_kind) else "medium"
                selection_reason = (
                    f"Cash selected for {component} against {target_payor_bucket}; "
                    f"cash is the available fallback basis with {cash_case_count} cases."
                )
            rows.append(
                {
                    "template_name": template_name,
                    "family_kind": family_kind,
                    "component": component,
                    "target_payor_bucket": target_payor_bucket,
                    "basis": "Cash",
                    "case_count": cash_case_count,
                    "anchor_p25": 0.0,
                    "anchor_p50": anchor_p50,
                    "anchor_p75": 0.0,
                    "variability_score": 0.0,
                    "spread_vs_insurance_all": 0.0,
                    "spread_vs_all_payers": 0.0,
                    "recommended_status": recommended_status,
                    "selected_basis": selected_basis,
                    "selected_case_count": cash_case_count,
                    "confidence": confidence,
                    "selection_reason": selection_reason,
                }
            )
    return rows


def load_resolution_rows(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8-sig") as handle:
        return list(csv.DictReader(handle))


def selection_lookup_formula(
    component_ref: str,
    target_payor_ref: str,
    return_col_letter: str,
    start_row: int = 2,
    end_row: int = 500,
    component_col: str = "A",
    target_payor_col: str = "B",
) -> str:
    return (
        f'=IFERROR(INDEX(Reference!${return_col_letter}${start_row}:${return_col_letter}${end_row},'
        f'MATCH(1,(Reference!${component_col}${start_row}:${component_col}${end_row}={component_ref})*'
        f'(Reference!${target_payor_col}${start_row}:${target_payor_col}${end_row}={target_payor_ref}),0)),"")'
    )


def supported_basis_options_from_resolution_rows(rows: list[dict[str, Any]]) -> list[str]:
    supported: list[str] = []
    for label in PAYER_BASIS_OPTIONS:
        for row in rows:
            basis = normalize_text(row.get("basis") or row.get("selected_basis"))
            if basis != label:
                continue
            if as_float(row.get("case_count")) > 0 or as_float(row.get("selected_case_count")) > 0:
                supported.append(label)
                break
    return supported or ["Cash"]
