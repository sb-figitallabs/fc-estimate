from __future__ import annotations

import csv
import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

try:
    from common.supabase_db import connect_db, repo_root
except ModuleNotFoundError:  # pragma: no cover
    from scripts.etl.common.supabase_db import connect_db, repo_root

from bill_audit.assembly import (
    AuditCaseContext,
    classify_payor_bucket,
    fetch_case_context,
    fetch_active_guidelines as fetch_bill_audit_guidelines,
)
from bill_audit.package_audit import (
    infer_cash_package_match_name,
    resolve_cash_package_details,
    resolve_insurance_package_details,
)
from fc_estimate.config import load_treatment_resolver


GUIDELINE_SCOPE = "fc_estimate"
GIPSA_ORGANIZATION_CODES = frozenset({"ORG55", "ORG56", "ORG54", "ORG1063", "ORG53"})
TEMPLATE_RELIABILITY_PATH = repo_root() / "outputs" / "template_reliability" / "template_reliability.csv"
PACKAGE_FAMILY_BOOST = 120
CANONICAL_FAMILY_BOOST = 90


@dataclass(frozen=True)
class EstimateContext:
    hospital_id: int
    admission_no: str | None
    admission_key: str | None
    umr_no: str | None
    patient_name: str | None
    organization_name: str | None
    patient_type: str | None
    organization_cd: str | None
    department_name: str | None
    doctor_name: str | None
    package_code: str | None
    package_name: str | None
    payor_bucket: str
    tariff_code: str | None = None
    tariff_name: str | None = None
    surgical_medical: str | None = None
    is_daycare_broad: bool | None = None

    def as_json(self) -> dict[str, Any]:
        return {
            "hospital_id": self.hospital_id,
            "admission_no": self.admission_no,
            "admission_key": self.admission_key,
            "umr_no": self.umr_no,
            "patient_name": self.patient_name,
            "organization_name": self.organization_name,
            "patient_type": self.patient_type,
            "organization_cd": self.organization_cd,
            "department_name": self.department_name,
            "doctor_name": self.doctor_name,
            "package_code": self.package_code,
            "package_name": self.package_name,
            "payor_bucket": self.payor_bucket,
            "tariff_code": self.tariff_code,
            "tariff_name": self.tariff_name,
            "surgical_medical": self.surgical_medical,
            "is_daycare_broad": self.is_daycare_broad,
        }


def audit_context_to_estimate_context(context: AuditCaseContext) -> EstimateContext:
    return EstimateContext(
        hospital_id=context.hospital_id,
        admission_no=context.admission_no,
        admission_key=context.admission_key,
        umr_no=context.umr_no,
        patient_name=context.patient_name,
        organization_name=context.organization_name,
        patient_type=context.patient_type,
        organization_cd=context.organization_cd,
        department_name=context.department_name,
        doctor_name=context.doctor_name,
        package_code=context.package_code,
        package_name=context.package_name,
        payor_bucket=context.payor_bucket,
        tariff_code=None,
        tariff_name=None,
    )


def resolve_context_tariff(
    *,
    payor_bucket: str | None,
    organization_cd: str | None,
    organization_name: str | None,
) -> tuple[str | None, str | None, str]:
    normalized_org_name = " ".join((organization_name or "").strip().split())
    normalized_org_cd = normalize_text(organization_cd).replace(" ", "").upper()
    normalized_payor = normalize_text(payor_bucket)
    if normalized_payor == "cash" or normalized_org_name in {"General Patients", "GENERAL"}:
        return "TR1", "KIMS", "default_cash_name"
    query = """
    with org_code_unique as (
        select
            upper(trim(organization_cd)) as organization_cd,
            min(trim(tariff_cd)) as tariff_cd,
            min(trim(tariff_name)) as tariff_name
        from staging.tariff_org_map
        where upper(coalesce(priority_type, '')) = 'IPPRIORITY1'
          and nullif(trim(organization_cd), '') is not null
          and nullif(trim(tariff_cd), '') is not null
        group by upper(trim(organization_cd))
        having count(distinct trim(tariff_cd)) = 1
    ),
    org_name_unique as (
        select
            staging.normalize_organization_name(trim(organization_name)) as normalized_organization_name,
            min(trim(tariff_cd)) as tariff_cd,
            min(trim(tariff_name)) as tariff_name
        from staging.tariff_org_map
        where upper(coalesce(priority_type, '')) = 'IPPRIORITY1'
          and nullif(trim(organization_name), '') is not null
          and nullif(trim(tariff_cd), '') is not null
        group by staging.normalize_organization_name(trim(organization_name))
        having count(distinct trim(tariff_cd)) = 1
    )
    select source_kind, tariff_cd, tariff_name
    from (
        select 'organization_cd_ippriority1'::text as source_kind, tariff_cd, tariff_name
        from org_code_unique
        where organization_cd = %s
        union all
        select 'organization_name_ippriority1'::text as source_kind, tariff_cd, tariff_name
        from org_name_unique
        where normalized_organization_name = staging.normalize_organization_name(%s)
    ) matches
    limit 1
    """
    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute(query, (normalized_org_cd, normalized_org_name))
            row = cur.fetchone()
    if row:
        return row[1] or None, row[2] or None, row[0] or "resolved"
    return None, None, "unresolved"


def build_pre_admission_context(
    *,
    hospital_id: int,
    payor_bucket: str | None,
    organization_cd: str | None,
    department_name: str | None,
    patient_name: str | None = None,
    doctor_name: str | None = None,
    package_code: str | None = None,
    package_name: str | None = None,
    management_type: str | None = None,
    stay_type: str | None = None,
) -> EstimateContext:
    resolved_payor = payor_bucket or classify_payor_bucket(None, None, organization_cd)
    if resolved_payor == "unknown" and organization_cd:
        resolved_payor = "gipsa_insurance" if organization_cd in GIPSA_ORGANIZATION_CODES else "non_gipsa_insurance"
    tariff_code, tariff_name, _ = resolve_context_tariff(
        payor_bucket=resolved_payor,
        organization_cd=organization_cd,
        organization_name=None,
    )
    return EstimateContext(
        hospital_id=hospital_id,
        admission_no=None,
        admission_key=None,
        umr_no=None,
        patient_name=patient_name,
        organization_name=None,
        patient_type="Insurance" if resolved_payor in {"gipsa_insurance", "non_gipsa_insurance"} else None,
        organization_cd=organization_cd,
        department_name=department_name,
        doctor_name=doctor_name,
        package_code=package_code,
        package_name=package_name,
        payor_bucket=resolved_payor,
        tariff_code=tariff_code,
        tariff_name=tariff_name,
        surgical_medical=management_type,
        is_daycare_broad=True if normalize_text(stay_type) == "daycare" else False if normalize_text(stay_type) == "non daycare" else None,
    )


def enrich_context_from_main_table(context: EstimateContext) -> EstimateContext:
    if not context.admission_no:
        return context
    query = """
    select
        mt.surgical_medical,
        mt.is_daycare_broad,
        mt.tariff_code,
        mt.tariff_name
    from mart.main_table mt
    where mt.hospital_id = %s
      and mt.admission_no = %s
    limit 1
    """
    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute(query, (context.hospital_id, context.admission_no))
            row = cur.fetchone()
    if not row:
        return context
    return EstimateContext(
        hospital_id=context.hospital_id,
        admission_no=context.admission_no,
        admission_key=context.admission_key,
        umr_no=context.umr_no,
        patient_name=context.patient_name,
        organization_name=context.organization_name,
        patient_type=context.patient_type,
        organization_cd=context.organization_cd,
        department_name=context.department_name,
        doctor_name=context.doctor_name,
        package_code=context.package_code,
        package_name=context.package_name,
        payor_bucket=context.payor_bucket,
        tariff_code=row[2] or context.tariff_code,
        tariff_name=row[3] or context.tariff_name,
        surgical_medical=row[0] or context.surgical_medical,
        is_daycare_broad=row[1] if row[1] is not None else context.is_daycare_broad,
    )


def read_json_input(value: str | None) -> Any:
    if not value:
        return None
    stripped = value.strip()
    if stripped.startswith("{") or stripped.startswith("["):
        return json.loads(stripped)
    path = Path(value)
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return json.loads(stripped)


def build_diagnosis_sources(
    *,
    doctor_diagnosis_json: Any = None,
    soap_text: str | None = None,
    prescription_extraction_json: Any = None,
    admission_note_text: str | None = None,
) -> dict[str, Any]:
    sources = {
        "doctor_diagnosis": {
            "present": doctor_diagnosis_json is not None,
            "content": doctor_diagnosis_json,
        },
        "soap_notes": {
            "present": bool((soap_text or "").strip()),
            "content": (soap_text or "").strip() or None,
        },
        "prescription_extraction": {
            "present": prescription_extraction_json is not None,
            "content": prescription_extraction_json,
        },
        "admission_note": {
            "present": bool((admission_note_text or "").strip()),
            "content": (admission_note_text or "").strip() or None,
        },
    }
    sources["missing_sources"] = [
        key for key, value in sources.items()
        if isinstance(value, dict) and not value["present"]
    ]
    return sources


def diagnosis_text(diagnosis_sources: dict[str, Any]) -> str:
    parts = []
    for key in ("doctor_diagnosis", "soap_notes", "prescription_extraction", "admission_note"):
        value = (diagnosis_sources.get(key) or {}).get("content")
        if value is None:
            continue
        if isinstance(value, str):
            parts.append(value)
        else:
            parts.append(json.dumps(value, ensure_ascii=True, sort_keys=True))
    return "\n".join(parts)


def normalize_text(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def token_set(value: Any) -> set[str]:
    return {token for token in normalize_text(value).split() if len(token) > 1}


def prettify_payor_bucket(value: str | None) -> str:
    mapping = {
        "cash": "Cash",
        "gipsa_insurance": "GIPSA Insurance",
        "non_gipsa_insurance": "Non-GIPSA Insurance",
        "corporate": "Corporate",
        "unknown": "Unknown",
    }
    return mapping.get(normalize_text(value).replace(" ", "_"), value or "Unknown")


def normalize_management_type(value: str | None) -> str | None:
    normalized = normalize_text(value)
    if normalized.startswith("surgical"):
        return "Surgical"
    if normalized.startswith("medical"):
        return "Medical"
    if normalized in {"all", "either"}:
        return "All"
    return None


def normalize_stay_type(value: str | None) -> str | None:
    normalized = normalize_text(value)
    if normalized in {"daycare", "day care"}:
        return "daycare"
    if normalized in {"non daycare", "non day care", "inpatient", "non_daycare"}:
        return "non_daycare"
    if normalized in {"all", "either"}:
        return "either"
    return None


def normalize_catalog_type(value: str | None) -> str | None:
    normalized = normalize_text(value)
    if normalized == "package":
        return "package"
    if normalized in {"non package", "nonpackage", "non_package"}:
        return "non_package"
    if normalized in {"all", "either"}:
        return "either"
    return None


@lru_cache(maxsize=1)
def treatment_resolver_config() -> dict[str, Any]:
    payload = load_treatment_resolver()
    families = payload.get("families") or []
    by_key: dict[str, dict[str, Any]] = {}
    package_code_index: dict[str, list[str]] = {}
    for family in families:
        key = family["canonical_treatment_family"]
        normalized_aliases = sorted(
            {normalize_text(alias) for alias in family.get("aliases") or [] if normalize_text(alias)},
            key=len,
            reverse=True,
        )
        family["normalized_aliases"] = normalized_aliases
        by_key[key] = family
        for package_code in family.get("package_codes") or []:
            package_code_index.setdefault(normalize_text(package_code).replace(" ", ""), []).append(key)
    payload["families_by_key"] = by_key
    payload["package_code_index"] = package_code_index
    return payload


@lru_cache(maxsize=1)
def template_reliability_index() -> dict[str, dict[str, Any]]:
    if not TEMPLATE_RELIABILITY_PATH.exists():
        return {}
    rows: dict[str, dict[str, Any]] = {}
    with TEMPLATE_RELIABILITY_PATH.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            template_id = (row.get("template_registry_id") or "").strip()
            if not template_id:
                continue
            reason_json = {}
            raw_reason = row.get("template_reliability_reason_json") or ""
            if raw_reason.strip():
                try:
                    reason_json = json.loads(raw_reason)
                except json.JSONDecodeError:
                    reason_json = {}
            rows[template_id] = {
                "template_reliability_tag": (row.get("template_reliability_tag") or "").strip() or "unknown",
                "cross_department_similarity_verdict": reason_json.get("cross_department_similarity_verdict"),
                "training_bill_count": int(row.get("training_bill_count") or 0),
                "reason_json": reason_json,
            }
    return rows


def alias_occurrences(text: str, aliases: list[str]) -> list[str]:
    matches: list[str] = []
    for alias in aliases:
        if not alias:
            continue
        pattern = rf"(?<![a-z0-9]){re.escape(alias)}(?![a-z0-9])"
        if re.search(pattern, text):
            matches.append(alias)
    return matches


def extract_clinical_modifiers(text: str) -> dict[str, Any]:
    normalized = normalize_text(text)
    laterality = None
    if " right " in f" {normalized} ":
        laterality = "right"
    elif " left " in f" {normalized} ":
        laterality = "left"

    sidedness = "none"
    if "bilateral" in normalized or "both sides" in normalized:
        sidedness = "bilateral"
    elif "unilateral" in normalized:
        sidedness = "unilateral"
    elif "single" in normalized:
        sidedness = "single"

    approach = "standard"
    if "robot" in normalized or "robo" in normalized:
        approach = "robotic"
    elif any(term in normalized for term in ("laparoscopic", "laparoscopy", "lap ")):
        approach = "lap"
    elif "open" in normalized:
        approach = "open"
    elif any(term in normalized for term in ("endoscopy", "endoscopic", "ursl", "rirs", "pcnl", "turp")):
        approach = "endoscopic"
    elif any(term in normalized for term in ("cag", "ptca", "angiogram", "angioplasty", "cath")):
        approach = "cath_lab"

    vessel_count = "none"
    vessel_patterns = [
        ("3", ("triple vessel", "three vessel", "3 vessel")),
        ("2", ("double vessel", "two vessel", "2 vessel")),
        ("1", ("single vessel", "one vessel", "1 vessel")),
    ]
    for value, phrases in vessel_patterns:
        if any(phrase in normalized for phrase in phrases):
            vessel_count = value
            break

    adjunct_variant = "none"
    if "without dj" in normalized or "no dj" in normalized:
        adjunct_variant = "without_dj_stenting"
    elif "with dj" in normalized or "dj stent" in normalized or "dj stenting" in normalized:
        adjunct_variant = "with_dj_stenting"

    return {
        "laterality": laterality or "none",
        "sidedness": sidedness,
        "approach": approach,
        "vessel_count": vessel_count,
        "adjunct_variant": adjunct_variant,
    }


def infer_management_type(text: str, context: EstimateContext, explicit: str | None) -> str:
    if explicit and explicit != "All":
        return explicit
    context_management = normalize_management_type(context.surgical_medical)
    if context_management and context_management != "All":
        return context_management
    normalized = normalize_text(text)
    if any(term in normalized for term in ("management", "fever", "infection", "medical", "chemotherapy", "infusion")):
        return "Medical"
    if any(term in normalized for term in ("replacement", "surgery", "ectomy", "angioplasty", "angiogram", "arthroplasty", "insertion", "endoscopy", "biopsy")):
        return "Surgical"
    return "Unknown"


def infer_stay_type(text: str, context: EstimateContext, explicit: str | None) -> str:
    if explicit and explicit != "either":
        return explicit
    if context.is_daycare_broad is True:
        return "daycare"
    if context.is_daycare_broad is False:
        return "non_daycare"
    normalized = normalize_text(text)
    if any(term in normalized for term in ("daycare", "day care", "cat 1", "infusion", "endoscopy", "chemoport")):
        return "daycare"
    return "non_daycare"


def infer_catalog_type(text: str, context: EstimateContext, explicit: str | None) -> str:
    if explicit and explicit != "either":
        return explicit
    if context.package_code or context.package_name:
        return "package"
    normalized = normalize_text(text)
    if "package" in normalized:
        return "package"
    return "either"


def resolve_canonical_family(text: str, context: EstimateContext) -> dict[str, Any]:
    config = treatment_resolver_config()
    normalized = normalize_text(" ".join([text, context.package_name or "", context.package_code or ""]))
    package_code_key = normalize_text(context.package_code).replace(" ", "")
    family_scores: list[tuple[int, str, list[str]]] = []

    for family in config.get("families") or []:
        score = 0
        reasons: list[str] = []
        if package_code_key and package_code_key in config["package_code_index"]:
            if family["canonical_treatment_family"] in config["package_code_index"][package_code_key]:
                score += PACKAGE_FAMILY_BOOST
                reasons.append(f"package_code:{context.package_code}")
        alias_matches = alias_occurrences(normalized, family.get("normalized_aliases") or [])
        if alias_matches:
            score += max(1, len(alias_matches)) * 18 + max(len(match.split()) for match in alias_matches)
            reasons.extend(f"alias:{match}" for match in alias_matches[:3])
        if score > 0:
            family_scores.append((score, family["canonical_treatment_family"], reasons))

    family_scores.sort(key=lambda item: item[0], reverse=True)
    selected_family = family_scores[0][1] if family_scores else None
    return {
        "canonical_treatment_family": selected_family,
        "family_candidates": [
            {
                "canonical_treatment_family": family_key,
                "score": score,
                "reasons": reasons,
            }
            for score, family_key, reasons in family_scores[:5]
        ],
    }


def infer_candidate_canonical_family(candidate: dict[str, Any]) -> str | None:
    config = treatment_resolver_config()
    candidate_blob = normalize_text(
        " ".join(
            [
                candidate.get("template_name") or "",
                " ".join(candidate.get("supporting_package_codes") or []),
                " ".join(candidate.get("supporting_canonical_names") or []),
            ]
        )
    )
    for family in config.get("families") or []:
        package_codes = {normalize_text(code).replace(" ", "") for code in family.get("package_codes") or []}
        if package_codes & {normalize_text(code).replace(" ", "") for code in candidate.get("supporting_package_codes") or []}:
            return family["canonical_treatment_family"]
    best_family = None
    best_score = 0
    for family in config.get("families") or []:
        alias_matches = alias_occurrences(candidate_blob, family.get("normalized_aliases") or [])
        if alias_matches:
            score = len(alias_matches) * 10 + max(len(match.split()) for match in alias_matches)
            if score > best_score:
                best_score = score
                best_family = family["canonical_treatment_family"]
    return best_family


def infer_candidate_stay_type(candidate: dict[str, Any], candidate_family: str | None) -> str:
    normalized = normalize_text(candidate.get("template_name"))
    if "daycare" in normalized or "day care" in normalized:
        return "daycare"
    if candidate_family:
        family = treatment_resolver_config()["families_by_key"].get(candidate_family) or {}
        default_stay = family.get("default_stay_type")
        if default_stay in {"daycare", "non_daycare"}:
            return default_stay
    return "either"


def infer_candidate_modifiers(candidate: dict[str, Any]) -> dict[str, Any]:
    return extract_clinical_modifiers(
        " ".join(
            [
                candidate.get("template_name") or "",
                " ".join(candidate.get("supporting_canonical_names") or []),
            ]
        )
    )


def reliability_boost(tag: str | None) -> int:
    if tag == "high":
        return 6
    if tag == "medium":
        return 3
    if tag == "low":
        return 0
    return 1


def skim_template_export(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    items = payload.get("items") if isinstance(payload.get("items"), list) else []
    billing_heads = payload.get("billing_heads") if isinstance(payload.get("billing_heads"), list) else []
    sub_billing_heads = payload.get("sub_billing_heads") if isinstance(payload.get("sub_billing_heads"), list) else []
    return {
        "template_name": payload.get("template_name") or payload.get("display_name"),
        "catalog_type": payload.get("catalog_type"),
        "department_name": payload.get("department_name"),
        "treatment_type": payload.get("treatment_type") or payload.get("dominant_surgical_medical"),
        "los_metrics": payload.get("los_metrics") or payload.get("los_section"),
        "billing_heads": billing_heads[:40],
        "sub_billing_heads": sub_billing_heads[:80],
        "items": items[:160],
        "cash_package_details": payload.get("cash_package_details"),
    }


def infer_department(text: str) -> str | None:
    normalized = normalize_text(text)
    if any(term in normalized for term in ("tkr", "knee", "orthopedic", "orthopaedic", "fracture", "arthroscopy")):
        return "ORTHOPAEDICS"
    if any(term in normalized for term in ("cag", "ptca", "angioplasty", "cardiac", "coronary")):
        return "CARDIOLOGY"
    if any(term in normalized for term in ("tonsil", "adenoid", "septoplasty", "ent")):
        return "ENT"
    return None


def infer_package_name_from_diagnosis(text: str) -> str | None:
    normalized = normalize_text(text)
    if "robot" in normalized and ("tkr" in normalized or ("knee" in normalized and "replacement" in normalized)):
        if "bilateral" in normalized:
            return "ROBOTIC TKR - BILATERAL"
        if "left" in normalized:
            return "ROBOTIC TKR - UNILATERAL - LEFT"
        if "right" in normalized:
            return "ROBOTIC TKR - UNILATERAL - RIGHT"
        return "ROBOTIC TKR - UNILATERAL"
    if "tkr" in normalized or ("knee" in normalized and "replacement" in normalized):
        if "bilateral" in normalized:
            return "TOTAL KNEE REPLACEMENT- BILATERAL"
        if "left" in normalized:
            return "TOTAL KNEE REPLACEMENT (TKR) - LEFT"
        if "right" in normalized:
            return "TOTAL KNEE REPLACEMENT (TKR) - RIGHT"
        return "TOTAL KNEE REPLACEMENT- UNILATERAL"
    return None


def fetch_fc_guidelines(guideline_set_key: str | None = None) -> dict[str, Any]:
    if guideline_set_key:
        set_where = "guideline_set_key = %s"
        params: tuple[Any, ...] = (guideline_set_key,)
    else:
        set_where = "guideline_scope = %s and is_active = true"
        params = (GUIDELINE_SCOPE,)
    query = f"""
    select
        guideline_set_id::text,
        guideline_set_key,
        title,
        version,
        payload_jsonb
    from fc_estimate.guideline_sets
    where {set_where}
    order by imported_at desc
    limit 1
    """
    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute(query, params)
            set_row = cur.fetchone()
            if not set_row:
                return {}
            cur.execute(
                """
                select
                    source_rule_id,
                    rule_type,
                    title,
                    severity,
                    content_text,
                    content_jsonb,
                    evidence_hint
                from fc_estimate.guideline_rules
                where guideline_set_id = %s::uuid
                order by rule_order, title
                """,
                (set_row[0],),
            )
            rules = cur.fetchall()
    return {
        "guideline_set_id": set_row[0],
        "guideline_set_key": set_row[1],
        "title": set_row[2],
        "version": set_row[3],
        "payload": set_row[4],
        "rules": [
            {
                "source_rule_id": row[0],
                "rule_type": row[1],
                "title": row[2],
                "severity": row[3],
                "content_text": row[4],
                "content": row[5],
                "evidence_hint": row[6],
            }
            for row in rules
        ],
    }


def fetch_template_by_id(template_registry_id: str) -> dict[str, Any] | None:
    query = """
    select
        tr.template_registry_id::text,
        tr.display_name,
        tr.catalog_type,
        tr.department_name,
        tr.admission_count,
        tr.dominant_surgical_medical,
        coalesce(tr.supporting_package_codes_jsonb, '[]'::jsonb),
        coalesce(tr.supporting_canonical_names_jsonb, '[]'::jsonb),
        coalesce(tr.supporting_template_codes_jsonb, '[]'::jsonb),
        trp.template_export_jsonb
    from curation.template_registry tr
    left join curation.template_registry_profile trp
      on trp.template_registry_id = tr.template_registry_id
    where tr.template_registry_id = %s::uuid
    limit 1
    """
    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute(query, (template_registry_id,))
            row = cur.fetchone()
    if not row:
        return None
    return template_row(row)


def fetch_template_candidates(
    *,
    hospital_id: int,
    department_name: str | None,
    diagnosis: str,
    catalog_type: str | None = None,
    limit: int = 25,
) -> list[dict[str, Any]]:
    filters = ["tr.hospital_id = %s", "tr.registry_status = 'active'"]
    params: list[Any] = [hospital_id]
    if catalog_type and catalog_type != "either":
        filters.append("tr.catalog_type = %s")
        params.append(catalog_type)
    query = f"""
    select
        tr.template_registry_id::text,
        tr.display_name,
        tr.catalog_type,
        tr.department_name,
        tr.admission_count,
        tr.dominant_surgical_medical,
        coalesce(tr.supporting_package_codes_jsonb, '[]'::jsonb),
        coalesce(tr.supporting_canonical_names_jsonb, '[]'::jsonb),
        coalesce(tr.supporting_template_codes_jsonb, '[]'::jsonb),
        trp.template_export_jsonb
    from curation.template_registry tr
    left join curation.template_registry_profile trp
      on trp.template_registry_id = tr.template_registry_id
    where {' and '.join(filters)}
    order by
        case tr.catalog_type when 'package' then 0 else 1 end,
        tr.admission_count desc,
        tr.display_name
    limit %s
    """
    params.append(max(limit * 4, 50))
    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute(query, params)
            rows = cur.fetchall()

    diagnosis_tokens = token_set(diagnosis)
    scored = []
    for row in rows:
        candidate = template_row(row)
        name_tokens = token_set(candidate["template_name"])
        overlap = len(diagnosis_tokens & name_tokens)
        synonym_boost = synonym_score(diagnosis, candidate["template_name"])
        package_boost = 3 if candidate["catalog_type"] == "package" and synonym_boost > 0 else 0
        department_boost = 1 if department_name and normalize_text(candidate["department_name"]) == normalize_text(department_name) else 0
        score = overlap + synonym_boost + package_boost + department_boost
        if score > 0:
            candidate["match_score"] = score
            candidate["match_reasons"] = match_reasons(diagnosis, candidate["template_name"], overlap, synonym_boost)
            scored.append(candidate)
    if not scored:
        scored = [template_row(row) | {"match_score": 0, "match_reasons": ["department_popularity"]} for row in rows[:limit]]
    return sorted(scored, key=lambda item: (item["match_score"], item["admission_count"] or 0), reverse=True)[:limit]


def template_row(row: Any) -> dict[str, Any]:
    reliability = template_reliability_index().get(row[0], {})
    return {
        "template_registry_id": row[0],
        "template_name": row[1],
        "catalog_type": row[2],
        "department_name": row[3],
        "admission_count": int(row[4] or 0),
        "dominant_surgical_medical": row[5],
        "supporting_package_codes": [str(item) for item in (row[6] or [])],
        "supporting_canonical_names": [str(item) for item in (row[7] or [])],
        "supporting_template_codes": [str(item) for item in (row[8] or [])],
        "template_reliability_tag": reliability.get("template_reliability_tag"),
        "cross_department_similarity_verdict": reliability.get("cross_department_similarity_verdict"),
        "skimmed_template_export": skim_template_export(row[9] or {}),
    }


def synonym_score(diagnosis: str, template_name: str) -> int:
    diagnosis_norm = normalize_text(diagnosis)
    template_norm = normalize_text(template_name)
    score = 0
    if ("tkr" in diagnosis_norm or "knee replacement" in diagnosis_norm) and (
        "tkr" in template_norm or "knee replacement" in template_norm
    ):
        score += 6
    if "robot" in diagnosis_norm and "robot" in template_norm:
        score += 4
    if "bilateral" in diagnosis_norm and "bilateral" in template_norm:
        score += 3
    if "unilateral" in diagnosis_norm and ("unilateral" in template_norm or "single" in template_norm):
        score += 3
    if "right" in diagnosis_norm and "right" in template_norm:
        score += 2
    if "left" in diagnosis_norm and "left" in template_norm:
        score += 2
    return score


def match_reasons(diagnosis: str, template_name: str, overlap: int, synonym_boost: int) -> list[str]:
    reasons = []
    if overlap:
        reasons.append(f"token_overlap:{overlap}")
    if synonym_boost:
        reasons.append("deterministic_procedure_synonym")
    if not reasons:
        reasons.append("department_popularity")
    return reasons


def build_treatment_resolution(
    *,
    context: EstimateContext,
    diagnosis: str,
    management_type: str | None = None,
    stay_type: str | None = None,
    catalog_type: str | None = None,
) -> dict[str, Any]:
    family_resolution = resolve_canonical_family(diagnosis, context)
    canonical_family = family_resolution.get("canonical_treatment_family")
    modifiers = extract_clinical_modifiers(
        " ".join([diagnosis, context.package_name or "", context.package_code or "", context.department_name or ""])
    )
    resolved_management_type = infer_management_type(
        diagnosis,
        context,
        normalize_management_type(management_type),
    )
    resolved_stay_type = infer_stay_type(
        diagnosis,
        context,
        normalize_stay_type(stay_type),
    )
    resolved_catalog_type = infer_catalog_type(
        diagnosis,
        context,
        normalize_catalog_type(catalog_type),
    )
    family_def = treatment_resolver_config()["families_by_key"].get(canonical_family or "", {})
    if resolved_management_type == "Unknown" and family_def.get("default_management_type"):
        resolved_management_type = family_def["default_management_type"]
    if resolved_stay_type == "non_daycare" and family_def.get("default_stay_type") == "daycare" and normalize_stay_type(stay_type) is None:
        resolved_stay_type = "daycare"
    if resolved_catalog_type == "either" and family_def.get("default_catalog_type") in {"package", "non_package"}:
        resolved_catalog_type = family_def["default_catalog_type"]
    return {
        "canonical_treatment_family": canonical_family,
        "resolved_modifiers": modifiers,
        "resolved_care_context": {
            "catalog_type": resolved_catalog_type,
            "stay_type": resolved_stay_type,
            "management_type": resolved_management_type,
        },
        "family_candidates": family_resolution.get("family_candidates") or [],
        "pricing_context": {
            "payor_bucket": context.payor_bucket,
            "organization_cd": context.organization_cd,
            "organization_name": context.organization_name,
            "payor_bucket_label": prettify_payor_bucket(context.payor_bucket),
        },
    }


def modifier_match_points(expected: dict[str, Any], observed: dict[str, Any]) -> tuple[int, list[str]]:
    score = 0
    reasons: list[str] = []
    for field in ("laterality", "sidedness", "approach", "vessel_count", "adjunct_variant"):
        expected_value = expected.get(field) or "none"
        observed_value = observed.get(field) or "none"
        if expected_value == "none":
            continue
        if expected_value == observed_value:
            score += 12 if field in {"laterality", "sidedness", "vessel_count"} else 8
            reasons.append(f"{field}:{expected_value}")
        elif observed_value != "none":
            score -= 10
            reasons.append(f"{field}_mismatch:{observed_value}")
    return score, reasons


def applicability_confidence(case_count: int, *, current_master_match: bool, family_known: bool) -> str:
    if not family_known:
        return "low"
    if current_master_match and case_count >= 2:
        return "high"
    if case_count >= 5:
        return "high"
    if case_count >= 2:
        return "medium"
    return "low"


@lru_cache(maxsize=1)
def current_cash_package_index() -> set[tuple[str, str]]:
    query = """
    select distinct
        coalesce(trim(package_code), '') as package_code,
        coalesce(trim(package_name), '') as package_name
    from staging.v_cash_packages_current_packages
    """
    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute(query)
            return {
                (normalize_text(row[0]).replace(" ", ""), normalize_text(row[1]))
                for row in cur.fetchall()
            }


@lru_cache(maxsize=1)
def current_insurance_package_index() -> set[tuple[str, str, str]]:
    query = """
    select distinct
        coalesce(trim(organization_cd), '') as organization_cd,
        coalesce(trim(package_id), '') as package_id,
        coalesce(trim(package_name), '') as package_name
    from staging.v_insurance_package_current_packages_by_organization
    """
    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute(query)
            return {
                (
                    normalize_text(row[0]).replace(" ", ""),
                    normalize_text(row[1]).replace(" ", ""),
                    normalize_text(row[2]),
                )
                for row in cur.fetchall()
            }


def current_master_match(
    *,
    payor_bucket: str,
    organization_cd: str | None,
    package_code: str | None,
    package_name: str | None,
) -> bool:
    package_code_key = normalize_text(package_code).replace(" ", "")
    package_name_key = normalize_text(package_name)
    if normalize_text(payor_bucket) == "cash":
        if not package_code_key and not package_name_key:
            return False
        return (package_code_key, package_name_key) in current_cash_package_index()
    org_key = normalize_text(organization_cd).replace(" ", "")
    if not org_key or (not package_code_key and not package_name_key):
        return False
    return (org_key, package_code_key, package_name_key) in current_insurance_package_index()


def is_placeholder_package_identity(package_code: str | None, package_name: str | None) -> bool:
    code_key = normalize_text(package_code)
    name_key = normalize_text(package_name)
    placeholders = {"n a", "na", "n", "n a", "n a ", "n a a", "n a#", ""}
    placeholder_names = {"n a", "na", "", "n a ", "n a a", "n a#", "n a n a"}
    raw_name = str(package_name or "").strip().upper()
    if raw_name in {"#N/A", "N/A", "NA", "#NA"}:
        return True
    return code_key in placeholders and name_key in placeholder_names


@lru_cache(maxsize=1)
def fetch_commercial_route_observation_rows() -> list[dict[str, Any]]:
    query = """
    with package_rows as (
        select
            mt.admission_no,
            coalesce(trim(mt.payor_bucket), '') as payor_bucket,
            coalesce(trim(mt.organization_cd), '') as organization_cd,
            coalesce(trim(mt.organization_name), '') as organization_name,
            coalesce(trim(mt.tariff_code), '') as tariff_code,
            coalesce(trim(mt.tariff_name), '') as tariff_name,
            coalesce(trim(mt.department_name), '') as department_name,
            coalesce(trim(mt.surgical_medical), '') as surgical_medical,
            coalesce(mt.is_daycare_broad, false) as is_daycare_broad,
            coalesce(trim(mt.package_code), '') as package_code,
            coalesce(trim(mt.package_name), '') as package_name,
            ''::text as template_name,
            'package'::text as catalog_type_path
        from mart.main_table mt
        where mt.complete_bill = true
          and nullif(trim(coalesce(mt.surgical_medical, '')), '') is not null
          and (
            nullif(trim(coalesce(mt.package_code, '')), '') is not null
            or nullif(trim(coalesce(mt.package_name, '')), '') is not null
          )
    ),
    non_package_rows as (
        select
            mt.admission_no,
            coalesce(trim(mt.payor_bucket), '') as payor_bucket,
            coalesce(trim(mt.organization_cd), '') as organization_cd,
            coalesce(trim(mt.organization_name), '') as organization_name,
            coalesce(trim(mt.tariff_code), '') as tariff_code,
            coalesce(trim(mt.tariff_name), '') as tariff_name,
            coalesce(trim(mt.department_name), '') as department_name,
            coalesce(trim(mt.surgical_medical), '') as surgical_medical,
            coalesce(mt.is_daycare_broad, false) as is_daycare_broad,
            ''::text as package_code,
            ''::text as package_name,
            jsonb_array_elements_text(mt.curated_template_names_jsonb) as template_name,
            'non_package'::text as catalog_type_path
        from mart.main_table mt
        where mt.complete_bill = true
          and nullif(trim(coalesce(mt.surgical_medical, '')), '') is not null
          and coalesce(nullif(trim(coalesce(mt.package_code, '')), ''), nullif(trim(coalesce(mt.package_name, '')), '')) is null
          and mt.curated_template_names_jsonb is not null
          and mt.curated_template_names_jsonb <> '[]'::jsonb
    )
    select *
    from package_rows
    union all
    select *
    from non_package_rows
    """
    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute(query)
            rows = cur.fetchall()

    observations: list[dict[str, Any]] = []
    for (
        admission_no,
        payor_bucket,
        organization_cd,
        organization_name,
        tariff_code,
        tariff_name,
        department_name,
        surgical_medical,
        is_daycare_broad,
        package_code,
        package_name,
        template_name,
        catalog_type_path,
    ) in rows:
        normalized_payor = normalize_text(payor_bucket) or "corporate"
        row_context = EstimateContext(
            hospital_id=1,
            admission_no=str(admission_no or ""),
            admission_key=None,
            umr_no=None,
            patient_name=None,
            organization_name=organization_name or None,
            patient_type=None,
            organization_cd=organization_cd or None,
            department_name=department_name or None,
            doctor_name=None,
            package_code=package_code or None,
            package_name=package_name or None,
            payor_bucket=normalized_payor,
            tariff_code=tariff_code or None,
            tariff_name=tariff_name or None,
            surgical_medical=surgical_medical or None,
            is_daycare_broad=bool(is_daycare_broad),
        )
        source_text = " ".join(
            [
                package_code or "",
                package_name or "",
                template_name or "",
                department_name or "",
            ]
        )
        if catalog_type_path == "package" and is_placeholder_package_identity(package_code, package_name):
            continue
        family = resolve_canonical_family(source_text, row_context).get("canonical_treatment_family")
        modifiers = extract_clinical_modifiers(source_text)
        stay_type = "daycare" if is_daycare_broad else "non_daycare"
        current_match = False
        if catalog_type_path == "package":
            current_match = current_master_match(
                payor_bucket=normalized_payor,
                organization_cd=organization_cd,
                package_code=package_code,
                package_name=package_name,
            )
        observations.append(
            {
                "admission_no": str(admission_no or ""),
                "payor_bucket": normalized_payor,
                "organization_cd": normalize_text(organization_cd).replace(" ", ""),
                "organization_name": organization_name or "",
                "tariff_code": normalize_text(tariff_code).replace(" ", "").upper(),
                "tariff_name": tariff_name or "",
                "department_name": department_name or "",
                "dominant_surgical_medical": normalize_management_type(surgical_medical) or (surgical_medical or ""),
                "stay_type": stay_type,
                "catalog_type_path": catalog_type_path,
                "package_code": package_code or "",
                "package_name": package_name or "",
                "template_name": template_name or "",
                "canonical_treatment_family": family or "",
                "laterality": modifiers["laterality"],
                "sidedness": modifiers["sidedness"],
                "approach": modifiers["approach"],
                "vessel_count": modifiers["vessel_count"],
                "adjunct_variant": modifiers["adjunct_variant"],
                "current_master_match": current_match,
            }
        )
    return observations


def aggregate_commercial_route_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[tuple[Any, ...], dict[str, Any]] = {}
    for row in rows:
        key = (
            row.get("payor_bucket") or "",
            row.get("tariff_code") or "",
            row.get("tariff_name") or "",
            row.get("canonical_treatment_family") or "",
            row.get("catalog_type_path") or "",
            row.get("package_code") or "",
            row.get("package_name") or "",
            row.get("department_name") or "",
            row.get("dominant_surgical_medical") or "",
            row.get("stay_type") or "",
            row.get("laterality") or "none",
            row.get("sidedness") or "none",
            row.get("approach") or "standard",
            row.get("vessel_count") or "none",
            row.get("adjunct_variant") or "none",
        )
        current = grouped.setdefault(
            key,
            {
                "payor_bucket": row.get("payor_bucket") or "",
                "organization_cd": row.get("organization_cd") or "",
                "organization_name": row.get("organization_name") or "",
                "tariff_code": row.get("tariff_code") or "",
                "tariff_name": row.get("tariff_name") or "",
                "canonical_treatment_family": row.get("canonical_treatment_family") or "",
                "catalog_type_path": row.get("catalog_type_path") or "",
                "package_code": row.get("package_code") or "",
                "package_name": row.get("package_name") or "",
                "department_name": row.get("department_name") or "",
                "dominant_surgical_medical": row.get("dominant_surgical_medical") or "",
                "stay_type": row.get("stay_type") or "",
                "laterality": row.get("laterality") or "none",
                "sidedness": row.get("sidedness") or "none",
                "approach": row.get("approach") or "standard",
                "vessel_count": row.get("vessel_count") or "none",
                "adjunct_variant": row.get("adjunct_variant") or "none",
                "case_count": 0,
                "template_name_set": set(),
                "package_name_set": set(),
                "current_master_match_any": False,
            },
        )
        current["case_count"] += 1
        if row.get("template_name"):
            current["template_name_set"].add(row["template_name"])
        if row.get("package_name"):
            current["package_name_set"].add(row["package_name"])
        current["current_master_match_any"] = bool(current["current_master_match_any"] or row.get("current_master_match"))

    results: list[dict[str, Any]] = []
    for record in grouped.values():
        family_known = bool(record["canonical_treatment_family"])
        confidence = applicability_confidence(
            int(record["case_count"]),
            current_master_match=bool(record["current_master_match_any"]),
            family_known=family_known,
        )
        basis = (
            "observed_historical_package_usage"
            if record["catalog_type_path"] == "package"
            else "observed_historical_non_package_usage"
        )
        if record["catalog_type_path"] == "package" and record["current_master_match_any"]:
            basis += "_current_master_confirmed"
        ambiguity_group_key = "|".join(
            [
                record["payor_bucket"] or "unknown",
                record["tariff_code"] or "unknown_tariff",
                record["canonical_treatment_family"] or "unknown_family",
                record["laterality"] or "none",
                record["sidedness"] or "none",
                record["approach"] or "standard",
                record["vessel_count"] or "none",
                record["adjunct_variant"] or "none",
                record["dominant_surgical_medical"] or "unknown",
                record["stay_type"] or "either",
            ]
        )
        results.append(
            {
                **{k: v for k, v in record.items() if not k.endswith("_set")},
                "template_registry_id_count": len(record["template_name_set"]),
                "package_name_variant_count": len(record["package_name_set"]),
                "applicability_confidence": confidence,
                "applicability_basis": basis,
                "ambiguity_group_key": ambiguity_group_key,
                "current_master_match": "yes" if record["current_master_match_any"] else "no",
                "last_seen_date": "",
            }
        )
    return results


@lru_cache(maxsize=1)
def aggregated_commercial_route_rows() -> list[dict[str, Any]]:
    return aggregate_commercial_route_rows(fetch_commercial_route_observation_rows())


def score_commercial_package_candidate(
    *,
    context: EstimateContext,
    treatment_resolution: dict[str, Any],
    candidate: dict[str, Any],
) -> dict[str, Any]:
    score = 0
    reasons: list[str] = []
    package_code_key = normalize_text(context.package_code).replace(" ", "")
    candidate_package_code_key = normalize_text(candidate.get("package_code")).replace(" ", "")
    if package_code_key and package_code_key == candidate_package_code_key:
        score += 500
        reasons.append(f"exact_package_code:{context.package_code}")
    package_name_key = normalize_text(context.package_name)
    if package_name_key and package_name_key == normalize_text(candidate.get("package_name")):
        score += 35
        reasons.append(f"exact_package_name:{context.package_name}")
    score += int(candidate.get("case_count") or 0) * 4
    if candidate.get("current_master_match") == "yes":
        score += 10
        reasons.append("current_master_match")
    confidence = candidate.get("applicability_confidence")
    if confidence == "high":
        score += 8
    elif confidence == "medium":
        score += 4
    context_tariff = normalize_text(context.tariff_code).replace(" ", "").upper()
    candidate_tariff = normalize_text(candidate.get("tariff_code")).replace(" ", "").upper()
    if context_tariff and context_tariff == candidate_tariff:
        score += 40
        reasons.append(f"tariff_code:{context.tariff_code}")
    modifier_score, modifier_reasons = modifier_match_points(
        treatment_resolution.get("resolved_modifiers") or {},
        candidate,
    )
    score += modifier_score
    reasons.extend(modifier_reasons)
    care_context = treatment_resolution.get("resolved_care_context") or {}
    if normalize_management_type(candidate.get("dominant_surgical_medical")) == care_context.get("management_type"):
        score += 8
        reasons.append(f"management_type:{care_context.get('management_type')}")
    elif candidate.get("dominant_surgical_medical"):
        score -= 6
    if candidate.get("stay_type") == care_context.get("stay_type"):
        score += 6
        reasons.append(f"stay_type:{care_context.get('stay_type')}")
    elif candidate.get("stay_type") and candidate.get("stay_type") != "either":
        score -= 6
    if context.department_name and normalize_text(candidate.get("department_name")) == normalize_text(context.department_name):
        score += 3
        reasons.append(f"department:{candidate.get('department_name')}")
    ranked = dict(candidate)
    ranked["route_candidate_score"] = score
    ranked["route_candidate_reasons"] = reasons
    return ranked


def resolve_commercial_route(
    *,
    context: EstimateContext,
    diagnosis: str,
    treatment_resolution: dict[str, Any] | None = None,
    observed_rows: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    resolved = treatment_resolution or build_treatment_resolution(context=context, diagnosis=diagnosis)
    care_context = resolved.get("resolved_care_context") or {}
    family = resolved.get("canonical_treatment_family") or ""
    if not family:
        selected_catalog_type = care_context.get("catalog_type") if care_context.get("catalog_type") in {"package", "non_package"} else "non_package"
        return {
            "payor_bucket": context.payor_bucket,
            "organization_cd": context.organization_cd,
            "organization_name": context.organization_name,
            "tariff_code": context.tariff_code,
            "tariff_name": context.tariff_name,
            "canonical_treatment_family": family,
            "resolved_modifiers": resolved.get("resolved_modifiers") or {},
            "resolved_care_context": care_context,
            "commercial_route": "non_package",
            "route_confidence": "low",
            "route_reason": "Canonical treatment family could not be resolved, so package applicability was not inferred",
            "package_candidates": [],
            "selected_catalog_type": selected_catalog_type,
            "selected_package_anchor": None,
            "selected_non_package_basis": {"case_count": 0, "department_names": []},
            "candidate_templates": [],
            "package_case_count": 0,
            "non_package_case_count": 0,
        }
    requested_catalog_type = care_context.get("catalog_type") or "either"
    scoped_rows = observed_rows if observed_rows is not None else aggregated_commercial_route_rows()

    def row_matches(row: dict[str, Any]) -> bool:
        if family and row.get("canonical_treatment_family") != family:
            return False
        row_payor = normalize_text(row.get("payor_bucket"))
        context_tariff = normalize_text(context.tariff_code).replace(" ", "").upper()
        row_tariff = normalize_text(row.get("tariff_code")).replace(" ", "").upper()
        if context_tariff:
            if row_tariff != context_tariff:
                return False
        elif normalize_text(context.payor_bucket) == "cash":
            if row_payor != "cash":
                return False
        else:
            if normalize_text(row.get("organization_cd")).replace(" ", "").upper() != normalize_text(context.organization_cd).replace(" ", "").upper():
                return False
            if row_payor != normalize_text(context.payor_bucket):
                return False
        management = care_context.get("management_type")
        if management and management not in {"All", "Unknown"}:
            row_management = normalize_management_type(row.get("dominant_surgical_medical")) or row.get("dominant_surgical_medical")
            if row_management and row_management != management:
                return False
        stay_type = care_context.get("stay_type")
        if stay_type and stay_type != "either":
            row_stay = row.get("stay_type") or "either"
            if row_stay not in {stay_type, "either"}:
                return False
        return True

    family_rows = [row for row in scoped_rows if row_matches(row)]
    package_rows = [row for row in family_rows if row.get("catalog_type_path") == "package"]
    non_package_rows = [row for row in family_rows if row.get("catalog_type_path") == "non_package"]
    ranked_packages = sorted(
        [
            score_commercial_package_candidate(
                context=context,
                treatment_resolution=resolved,
                candidate=row,
            )
            for row in package_rows
        ],
        key=lambda item: (item.get("route_candidate_score") or 0, item.get("case_count") or 0),
        reverse=True,
    )
    top_package = ranked_packages[0] if ranked_packages else None
    second_package = ranked_packages[1] if len(ranked_packages) > 1 else None
    package_case_total = sum(int(row.get("case_count") or 0) for row in package_rows)
    non_package_case_total = sum(int(row.get("case_count") or 0) for row in non_package_rows)

    route = "non_package"
    route_reason = "No observed package history for this family and payer/org context"
    route_confidence = "medium" if non_package_case_total else "low"
    selected_catalog_type = "non_package"

    if requested_catalog_type == "package":
        selected_catalog_type = "package"
        if ranked_packages:
            gap = (top_package.get("route_candidate_score") or 0) - ((second_package or {}).get("route_candidate_score") or 0)
            route = "package" if gap >= 25 or len(ranked_packages) == 1 else "ambiguous_package_candidates"
            route_reason = "Explicit package catalog_type requested"
            route_confidence = "high" if route == "package" else "medium"
        else:
            route = "non_package"
            route_reason = "Explicit package requested, but no observed package history was found"
            route_confidence = "low"
    elif requested_catalog_type == "non_package":
        route = "non_package"
        selected_catalog_type = "non_package"
        route_reason = "Explicit non-package catalog_type requested"
        route_confidence = "high"
    elif ranked_packages:
        selected_catalog_type = "package"
        gap = (top_package.get("route_candidate_score") or 0) - ((second_package or {}).get("route_candidate_score") or 0)
        if package_case_total > max(0, non_package_case_total) and (gap >= 25 or len(ranked_packages) == 1):
            route = "package"
            route_reason = "Observed package history is stronger than non-package history for this payer/org and family"
            route_confidence = "high" if package_case_total >= max(2, non_package_case_total + 1) else "medium"
        elif package_case_total == 0:
            route = "non_package"
            selected_catalog_type = "non_package"
        elif non_package_case_total > package_case_total and not context.package_code:
            route = "non_package"
            selected_catalog_type = "non_package"
            route_reason = "Observed non-package history is stronger than package history for this payer/org and family"
            route_confidence = "medium"
        else:
            route = "ambiguous_package_candidates"
            route_reason = "Observed package history exists, but multiple package variants remain viable"
            route_confidence = "medium"

    return {
        "payor_bucket": context.payor_bucket,
        "organization_cd": context.organization_cd,
        "organization_name": context.organization_name,
        "tariff_code": context.tariff_code,
        "tariff_name": context.tariff_name,
        "canonical_treatment_family": family,
        "resolved_modifiers": resolved.get("resolved_modifiers") or {},
        "resolved_care_context": care_context,
        "commercial_route": route,
        "route_confidence": route_confidence,
        "route_reason": route_reason,
        "package_candidates": ranked_packages[:5],
        "selected_catalog_type": selected_catalog_type,
        "selected_package_anchor": {
            "tariff_code": (top_package or {}).get("tariff_code"),
            "tariff_name": (top_package or {}).get("tariff_name"),
            "package_code": (top_package or {}).get("package_code"),
            "package_name": (top_package or {}).get("package_name"),
            "case_count": (top_package or {}).get("case_count"),
        }
        if top_package
        else None,
        "selected_non_package_basis": {
            "case_count": non_package_case_total,
            "department_names": sorted({row.get("department_name") for row in non_package_rows if row.get("department_name")})[:10],
        },
        "candidate_templates": [],
        "package_case_count": package_case_total,
        "non_package_case_count": non_package_case_total,
    }


def score_template_candidate(
    *,
    context: EstimateContext,
    diagnosis: str,
    candidate: dict[str, Any],
    resolution: dict[str, Any],
) -> dict[str, Any]:
    score = int(candidate.get("match_score") or 0)
    reasons = list(candidate.get("match_reasons") or [])
    candidate_family = infer_candidate_canonical_family(candidate)
    candidate_modifiers = infer_candidate_modifiers(candidate)
    candidate_management = normalize_management_type(candidate.get("dominant_surgical_medical")) or "Unknown"
    candidate_stay_type = infer_candidate_stay_type(candidate, candidate_family)
    resolved_family = resolution.get("canonical_treatment_family")
    resolved_modifiers = resolution.get("resolved_modifiers") or {}
    care_context = resolution.get("resolved_care_context") or {}
    resolved_catalog_type = care_context.get("catalog_type")
    resolved_management_type = care_context.get("management_type")
    resolved_stay_type = care_context.get("stay_type")

    package_code = normalize_text(context.package_code).replace(" ", "")
    candidate_package_codes = {normalize_text(code).replace(" ", "") for code in candidate.get("supporting_package_codes") or []}
    if package_code and package_code in candidate_package_codes:
        score += PACKAGE_FAMILY_BOOST
        reasons.append(f"exact_package_code:{context.package_code}")

    if resolved_family and candidate_family == resolved_family:
        score += CANONICAL_FAMILY_BOOST
        reasons.append(f"canonical_family:{resolved_family}")
    elif resolved_family and candidate_family:
        score -= 20
        reasons.append(f"canonical_family_mismatch:{candidate_family}")

    if resolved_catalog_type and resolved_catalog_type != "either":
        if candidate.get("catalog_type") == resolved_catalog_type:
            score += 12
            reasons.append(f"catalog_type:{resolved_catalog_type}")
        else:
            score -= 18
            reasons.append(f"catalog_type_mismatch:{candidate.get('catalog_type')}")

    if resolved_management_type and resolved_management_type not in {"All", "Unknown"}:
        if candidate_management == resolved_management_type:
            score += 12
            reasons.append(f"management_type:{resolved_management_type}")
        elif candidate_management != "Unknown":
            score -= 12
            reasons.append(f"management_type_mismatch:{candidate_management}")

    if resolved_stay_type and resolved_stay_type != "either":
        if candidate_stay_type == resolved_stay_type:
            score += 8
            reasons.append(f"stay_type:{resolved_stay_type}")
        elif candidate_stay_type != "either":
            score -= 10
            reasons.append(f"stay_type_mismatch:{candidate_stay_type}")

    for field in ("laterality", "sidedness", "approach", "vessel_count", "adjunct_variant"):
        resolved_value = resolved_modifiers.get(field)
        candidate_value = candidate_modifiers.get(field)
        if not resolved_value or resolved_value == "none":
            continue
        if candidate_value == resolved_value:
            score += 9
            reasons.append(f"{field}:{resolved_value}")
        elif candidate_value and candidate_value != "none":
            score -= 9
            reasons.append(f"{field}_mismatch:{candidate_value}")

    if context.department_name:
        if normalize_text(context.department_name) == normalize_text(candidate.get("department_name")):
            score += 4
            reasons.append(f"department:{candidate.get('department_name')}")
        else:
            reasons.append(f"department_tiebreak:{candidate.get('department_name')}")

    reliability_tag = candidate.get("template_reliability_tag")
    score += reliability_boost(reliability_tag)
    if reliability_tag:
        reasons.append(f"reliability:{reliability_tag}")

    score += min(8, int((candidate.get("admission_count") or 0) / 25))
    candidate_copy = dict(candidate)
    candidate_copy.update(
        {
            "canonical_treatment_family": candidate_family,
            "resolved_modifier_defaults": candidate_modifiers,
            "dominant_surgical_medical": candidate.get("dominant_surgical_medical"),
            "candidate_stay_type": candidate_stay_type,
            "resolver_score": score,
            "resolver_reasons": reasons,
        }
    )
    return candidate_copy


def resolve_template_candidates(
    *,
    context: EstimateContext,
    diagnosis: str,
    candidates: list[dict[str, Any]],
    management_type: str | None = None,
    stay_type: str | None = None,
    catalog_type: str | None = None,
) -> dict[str, Any]:
    resolution = build_treatment_resolution(
        context=context,
        diagnosis=diagnosis,
        management_type=management_type,
        stay_type=stay_type,
        catalog_type=catalog_type,
    )
    ranked = [
        score_template_candidate(
            context=context,
            diagnosis=diagnosis,
            candidate=candidate,
            resolution=resolution,
        )
        for candidate in candidates
    ]
    ranked = sorted(
        ranked,
        key=lambda item: (item.get("resolver_score") or 0, item.get("admission_count") or 0),
        reverse=True,
    )
    selected = ranked[0] if ranked else None
    top_score = selected.get("resolver_score") if selected else None
    second_score = ranked[1].get("resolver_score") if len(ranked) > 1 else None
    confidence = "low"
    if top_score is not None:
        gap = top_score - (second_score or 0)
        if top_score >= 170 or gap >= 60:
            confidence = "high"
        elif top_score >= 110 or gap >= 30:
            confidence = "medium"
    selection_reason = None
    if selected:
        selection_reason = "; ".join((selected.get("resolver_reasons") or [])[:6])
    return {
        "status": "selected" if selected else "not_found",
        "selection_method": "canonical_resolver",
        "selected_template": selected,
        "candidates": ranked[:10],
        "reason": None if selected else "No template candidates found after canonical-family resolution",
        "selection_confidence": confidence,
        "selection_reason": selection_reason,
        "canonical_treatment_family": resolution.get("canonical_treatment_family"),
        "resolved_modifiers": resolution.get("resolved_modifiers"),
        "resolved_care_context": resolution.get("resolved_care_context"),
        "pricing_context": resolution.get("pricing_context"),
        "family_candidates": resolution.get("family_candidates") or [],
    }


def select_template(
    *,
    context: EstimateContext,
    diagnosis: str,
    template_registry_id: str | None = None,
    management_type: str | None = None,
    stay_type: str | None = None,
    catalog_type: str | None = None,
) -> dict[str, Any]:
    if template_registry_id:
        selected = fetch_template_by_id(template_registry_id)
        if not selected:
            return {
                "status": "not_found",
                "selection_method": "override",
                "selected_template": None,
                "candidates": [],
                "reason": f"Template override not found: {template_registry_id}",
                "selection_confidence": "high",
            }
        return {
            "status": "selected",
            "selection_method": "override",
            "selected_template": selected,
            "candidates": [selected],
            "reason": None,
            "selection_confidence": "high",
        }

    resolution = build_treatment_resolution(
        context=context,
        diagnosis=diagnosis,
        management_type=management_type,
        stay_type=stay_type,
        catalog_type=catalog_type,
    )
    department = context.department_name or infer_department(diagnosis)
    candidates = fetch_template_candidates(
        hospital_id=context.hospital_id,
        department_name=department,
        diagnosis=diagnosis,
        catalog_type=(resolution.get("resolved_care_context") or {}).get("catalog_type"),
    )
    return resolve_template_candidates(
        context=context,
        diagnosis=diagnosis,
        candidates=candidates,
        management_type=management_type,
        stay_type=stay_type,
        catalog_type=catalog_type,
    )


def resolve_estimate_package_details(context: EstimateContext, diagnosis: str, selected_template: dict[str, Any] | None) -> dict[str, Any]:
    package_name = context.package_name or infer_package_name_from_diagnosis(diagnosis)
    package_code = context.package_code
    if not package_name and selected_template and selected_template.get("catalog_type") == "package":
        package_name = selected_template.get("template_name")

    if context.payor_bucket == "cash":
        resolution = resolve_cash_package_details(package_name=package_name, package_code=package_code)
    elif context.payor_bucket in {"gipsa_insurance", "non_gipsa_insurance"}:
        resolution = resolve_insurance_package_details(
            organization_cd=context.organization_cd,
            package_name=package_name,
            package_code=package_code,
        )
    else:
        resolution = {
            "status": "not_found",
            "payor_bucket": context.payor_bucket,
            "match_confidence": "none",
            "package_details": None,
            "candidates": [],
            "reason": "Unsupported or unknown payor bucket for package detail resolution",
        }

    resolution["diagnosis_inferred_package_name"] = package_name
    resolution["cash_synonym_name"] = infer_cash_package_match_name(package_name, package_code)
    return resolution


def build_fc_estimate_input_bundle(
    *,
    hospital_id: int,
    admission_no: str | None = None,
    doctor_diagnosis_json: Any = None,
    soap_text: str | None = None,
    prescription_extraction_json: Any = None,
    admission_note_text: str | None = None,
    payor_bucket: str | None = None,
    organization_cd: str | None = None,
    department_name: str | None = None,
    patient_name: str | None = None,
    doctor_name: str | None = None,
    package_code: str | None = None,
    package_name: str | None = None,
    management_type: str | None = None,
    stay_type: str | None = None,
    catalog_type: str | None = None,
    template_registry_id: str | None = None,
    guideline_set_key: str | None = None,
) -> dict[str, Any]:
    if admission_no:
        context = enrich_context_from_main_table(audit_context_to_estimate_context(fetch_case_context(hospital_id, admission_no)))
    else:
        context = build_pre_admission_context(
            hospital_id=hospital_id,
            payor_bucket=payor_bucket,
            organization_cd=organization_cd,
            department_name=department_name,
            patient_name=patient_name,
            doctor_name=doctor_name,
            package_code=package_code,
            package_name=package_name,
            management_type=management_type,
            stay_type=stay_type,
        )
    diagnosis_sources = build_diagnosis_sources(
        doctor_diagnosis_json=doctor_diagnosis_json,
        soap_text=soap_text,
        prescription_extraction_json=prescription_extraction_json,
        admission_note_text=admission_note_text,
    )
    combined_diagnosis = diagnosis_text(diagnosis_sources)
    treatment_resolution = build_treatment_resolution(
        context=context,
        diagnosis=combined_diagnosis,
        management_type=management_type,
        stay_type=stay_type,
        catalog_type=catalog_type,
    )
    commercial_resolution = resolve_commercial_route(
        context=context,
        diagnosis=combined_diagnosis,
        treatment_resolution=treatment_resolution,
    )
    selection_context = context
    selected_package_anchor = commercial_resolution.get("selected_package_anchor") or {}
    if commercial_resolution.get("selected_catalog_type") == "package" and (
        selected_package_anchor.get("package_code") or selected_package_anchor.get("package_name")
    ):
        selection_context = EstimateContext(
            hospital_id=context.hospital_id,
            admission_no=context.admission_no,
            admission_key=context.admission_key,
            umr_no=context.umr_no,
            patient_name=context.patient_name,
            organization_name=context.organization_name,
            patient_type=context.patient_type,
            organization_cd=context.organization_cd,
            department_name=context.department_name,
            doctor_name=context.doctor_name,
            package_code=selected_package_anchor.get("package_code") or context.package_code,
            package_name=selected_package_anchor.get("package_name") or context.package_name,
            payor_bucket=context.payor_bucket,
            tariff_code=context.tariff_code,
            tariff_name=context.tariff_name,
            surgical_medical=context.surgical_medical,
            is_daycare_broad=context.is_daycare_broad,
        )
    template_selection = select_template(
        context=selection_context,
        diagnosis=combined_diagnosis,
        template_registry_id=template_registry_id,
        management_type=management_type,
        stay_type=stay_type,
        catalog_type=commercial_resolution.get("selected_catalog_type") or catalog_type,
    )
    selected_template = template_selection.get("selected_template")
    package_resolution = resolve_estimate_package_details(selection_context, combined_diagnosis, selected_template)
    guidelines = fetch_fc_guidelines(guideline_set_key)

    template_snapshot = selected_template or {}
    resolved_care_context = treatment_resolution.get("resolved_care_context") or template_selection.get("resolved_care_context") or {
        "management_type": normalize_management_type(management_type) or normalize_management_type(context.surgical_medical) or "Unknown",
        "stay_type": normalize_stay_type(stay_type) or ("daycare" if context.is_daycare_broad else "non_daycare" if context.is_daycare_broad is False else "either"),
        "catalog_type": normalize_catalog_type(catalog_type) or ("package" if context.package_code or context.package_name else "either"),
    }
    treatment_resolution = {
        "canonical_treatment_family": treatment_resolution.get("canonical_treatment_family") or template_selection.get("canonical_treatment_family"),
        "resolved_modifiers": treatment_resolution.get("resolved_modifiers") or template_selection.get("resolved_modifiers") or {},
        "resolved_care_context": resolved_care_context,
        "candidate_templates": template_selection.get("candidates") or [],
        "selected_template": selected_template,
        "selection_reason": template_selection.get("selection_reason") or template_selection.get("reason"),
        "selection_confidence": template_selection.get("selection_confidence"),
        "pricing_context": template_selection.get("pricing_context")
        or {
            "payor_bucket": context.payor_bucket,
            "organization_cd": context.organization_cd,
            "organization_name": context.organization_name,
            "tariff_code": context.tariff_code,
            "tariff_name": context.tariff_name,
            "payor_bucket_label": prettify_payor_bucket(context.payor_bucket),
        },
        "package_detail_resolution": package_resolution,
        "family_candidates": template_selection.get("family_candidates") or [],
    }
    return {
        "workflow": "fc_estimate",
        "context": context.as_json(),
        "diagnosis_sources": diagnosis_sources,
        "template_registry_id": (selected_template or {}).get("template_registry_id"),
        "template_selection": template_selection,
        "treatment_resolution": treatment_resolution,
        "commercial_resolution": {
            **commercial_resolution,
            "candidate_templates": template_selection.get("candidates") or [],
            "downstream_package_detail_resolution": package_resolution,
        },
        "template_snapshot": template_snapshot,
        "package_detail_resolution": package_resolution,
        "guidelines": guidelines,
        "input_manifest": {
            "has_admission_context": admission_no is not None,
            "has_doctor_diagnosis_json": diagnosis_sources["doctor_diagnosis"]["present"],
            "has_soap_notes": diagnosis_sources["soap_notes"]["present"],
            "has_prescription_extraction": diagnosis_sources["prescription_extraction"]["present"],
            "has_admission_note": diagnosis_sources["admission_note"]["present"],
            "missing_diagnosis_sources": diagnosis_sources["missing_sources"],
            "has_any_diagnosis_source": bool(combined_diagnosis.strip()),
            "template_selection_status": template_selection.get("status"),
            "template_selection_method": template_selection.get("selection_method"),
            "has_template_snapshot": bool(template_snapshot),
            "package_details_status": package_resolution.get("status"),
            "has_package_details": package_resolution.get("status") == "matched",
            "has_guidelines": bool(guidelines),
            "canonical_treatment_family": treatment_resolution.get("canonical_treatment_family"),
            "resolved_management_type": (treatment_resolution.get("resolved_care_context") or {}).get("management_type"),
            "resolved_stay_type": (treatment_resolution.get("resolved_care_context") or {}).get("stay_type"),
            "resolved_catalog_type": (treatment_resolution.get("resolved_care_context") or {}).get("catalog_type"),
            "commercial_route": commercial_resolution.get("commercial_route"),
            "commercial_route_confidence": commercial_resolution.get("route_confidence"),
            "selected_catalog_type": commercial_resolution.get("selected_catalog_type"),
            "resolved_tariff_code": context.tariff_code,
            "uses_ehr_or_case_file_extraction": False,
        },
    }


def write_bundle(bundle: dict[str, Any], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(bundle, indent=2, ensure_ascii=True), encoding="utf-8")


def _keep_import_reference() -> Any:
    # Helps static readers discover the shared guideline fetcher used by bill audit;
    # FC has a separate table and fetcher, but the shape intentionally mirrors it.
    return fetch_bill_audit_guidelines
