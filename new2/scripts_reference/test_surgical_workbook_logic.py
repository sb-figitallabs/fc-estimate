from __future__ import annotations

import unittest

from scripts.export_robotic_tkr_fc_estimate_builder import (
    build_ot_consumables_piecewise_formula,
    build_actual_basis_metric_rows,
    build_grouped_residual_candidates,
    compute_robotic_charge_presence_rate,
    is_robotic_service_row,
    grouped_residual_parent_bucket,
    prioritize_optional_service_rows,
    resolve_robotic_default_selection,
    resolve_ot_consumables_band_value,
    snap_to_supported_ot_slot_hours,
)
from scripts.export_total_hip_replacement_thr_hemiarthroplasty_fc_estimate_builder import (
    resolve_procedure_row,
)


class SurgicalWorkbookLogicTests(unittest.TestCase):
    def test_snap_to_supported_ot_slot_hours_rounds_to_nearest_supported_value(self) -> None:
        supported = [2.0, 2.5, 3.0, 3.5, 4.0]
        self.assertEqual(snap_to_supported_ot_slot_hours(3.625, supported), 3.5)
        self.assertEqual(snap_to_supported_ot_slot_hours(3.75, supported), 4.0)
        self.assertEqual(snap_to_supported_ot_slot_hours(0.0, supported), 0.0)

    def test_grouped_residual_parent_bucket_routes_consultation_out_of_ot(self) -> None:
        row = {
            "grouping": "Consultation Charges",
            "sample_fc_estimate_bucket": "Physiotherapy",
        }
        self.assertEqual(grouped_residual_parent_bucket(row), "Professional Fees")

    def test_thr_resolve_procedure_row_prefers_non_robotic_candidate(self) -> None:
        rows = [
            {
                "item_code": "EQP0001",
                "item_name": "ROBO (THR) - UNILATERAL",
                "fc_estimate_bucket": "OT",
                "case_presence_rate": "21.54",
                "amount_cash_typical": "100000",
            },
            {
                "item_code": "OTI0098",
                "item_name": "THR UNILATERAL",
                "fc_estimate_bucket": "OT",
                "case_presence_rate": "65",
                "amount_cash_typical": "15000",
            },
        ]
        self.assertEqual(resolve_procedure_row(rows), ("OTI0098", "THR UNILATERAL"))

    def test_actual_basis_metric_rows_include_insurance_all_bucket(self) -> None:
        actual_rows = [
            {"payor_bucket": "Cash", "room_charges": 10},
            {"payor_bucket": "GIPSA Insurance", "room_charges": 20},
            {"payor_bucket": "Non-GIPSA Insurance", "room_charges": 30},
        ]
        rows = build_actual_basis_metric_rows(actual_rows)
        insurance_all = [
            row for row in rows
            if row["basis_label"] == "Insurance All" and row["field_key"] == "room_charges"
        ]
        self.assertEqual(len(insurance_all), 1)
        self.assertEqual(insurance_all[0]["p50"], 25.0)

    def test_prioritize_optional_service_rows_prefers_expected_contribution(self) -> None:
        rows = [
            {
                "item_code": "B",
                "item_name": "Lower Impact",
                "grouping": "Misc",
                "case_presence_rate": "90",
                "quantity_p50": "1",
                "amount_cash_typical": "500",
            },
            {
                "item_code": "A",
                "item_name": "Higher Impact",
                "grouping": "Misc",
                "case_presence_rate": "50",
                "quantity_p50": "2",
                "amount_cash_typical": "2000",
            },
        ]
        ranked = prioritize_optional_service_rows(rows, {})
        self.assertEqual([row["item_code"] for row in ranked], ["A", "B"])

    def test_resolve_ot_consumables_band_value_uses_piecewise_thresholds(self) -> None:
        self.assertEqual(resolve_ot_consumables_band_value(10, 20, 30, 0.0), 10)
        self.assertEqual(resolve_ot_consumables_band_value(10, 20, 30, 0.30), 10)
        self.assertEqual(resolve_ot_consumables_band_value(10, 20, 30, 0.31), 20)
        self.assertEqual(resolve_ot_consumables_band_value(10, 20, 30, 0.50), 20)
        self.assertEqual(resolve_ot_consumables_band_value(10, 20, 30, 0.51), 30)

    def test_build_ot_consumables_piecewise_formula_contains_threshold_bands(self) -> None:
        formula = build_ot_consumables_piecewise_formula(
            p25_ref="B5",
            p50_ref="C5",
            p75_ref="D5",
            selected_flag_range="H8:H17",
            expected_contribution_range="F8:F17",
        )
        self.assertIn('SUMIF(H8:H17,"Include",F8:F17)', formula)
        self.assertIn("<=0.3", formula)
        self.assertIn("<=0.5", formula)

    def test_build_grouped_residual_candidates_promotes_high_presence_investigation_groups(self) -> None:
        rows = [
            {
                "grouping": "Coagulation Tests",
                "sample_fc_estimate_bucket": "Investigations",
                "group_residual_band": "",
                "group_presence_rate": "61.54",
                "suggested_group_residual_p50": "5590",
                "group_amount_left_out_vs_p50": "5590",
                "optional_child_count": "1",
            },
            {
                "grouping": "Hormone Tests",
                "sample_fc_estimate_bucket": "Investigations",
                "group_residual_band": "",
                "group_presence_rate": "38.46",
                "suggested_group_residual_p50": "3260",
                "group_amount_left_out_vs_p50": "3260",
                "optional_child_count": "1",
            },
        ]
        candidates = build_grouped_residual_candidates(rows)
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["grouping"], "Coagulation Tests")
        self.assertEqual(candidates[0]["group_residual_band"], "auto")

    def test_is_robotic_service_row_detects_robotic_charge_rows(self) -> None:
        self.assertTrue(
            is_robotic_service_row(
                {
                    "item_code": "EQP0001",
                    "item_name": "ROBO (THR) - UNILATERAL",
                    "grouping": "Robotic Equipment Charges",
                }
            )
        )
        self.assertFalse(
            is_robotic_service_row(
                {
                    "item_code": "OTI0018",
                    "item_name": "Instrument Charges (Major)",
                    "grouping": "OT Charges",
                }
            )
        )

    def test_compute_robotic_charge_presence_rate_uses_max_rate(self) -> None:
        rows = [
            {"case_presence_rate": "21.54"},
            {"case_presence_rate": "95"},
        ]
        self.assertEqual(compute_robotic_charge_presence_rate(rows), 95.0)

    def test_resolve_robotic_default_selection_obeys_mode_and_threshold(self) -> None:
        self.assertEqual(
            resolve_robotic_default_selection(default_mode="yes", presence_rate=10, presence_threshold=90),
            "Yes",
        )
        self.assertEqual(
            resolve_robotic_default_selection(default_mode="no", presence_rate=99, presence_threshold=90),
            "No",
        )
        self.assertEqual(
            resolve_robotic_default_selection(default_mode="auto", presence_rate=95, presence_threshold=90),
            "Yes",
        )
        self.assertEqual(
            resolve_robotic_default_selection(default_mode="auto", presence_rate=40, presence_threshold=90),
            "",
        )


if __name__ == "__main__":
    unittest.main()
