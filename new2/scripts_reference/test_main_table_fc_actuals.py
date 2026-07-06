from __future__ import annotations

from datetime import datetime, timezone
import unittest
from unittest.mock import patch

from scripts.etl import fc_actuals
from scripts.etl import fc_actual_quality
from scripts.etl.common import supabase_db
from scripts.export_robotic_tkr_per_ip_bucket_totals import DRUG_CLASS, SUPPLY_CLASS


class MainTableFcActualTests(unittest.TestCase):
    def test_ot_row_populates_derived_ot_hours(self) -> None:
        hours, codes = supabase_db._derive_ot_duration_fields(
            [
                {
                    "service_code": "OT001",
                    "service_name": "OT - 2 1/2 HOURS",
                    "service_group_name": "OT CHARGES",
                }
            ]
        )

        self.assertEqual(hours, 2.5)
        self.assertEqual(codes, "OT001")

    def test_ot_uses_first_parsed_row_but_stores_all_distinct_codes(self) -> None:
        hours, codes = supabase_db._derive_ot_duration_fields(
            [
                {
                    "service_code": "OT002",
                    "service_name": "OT - 3 HOURS",
                    "service_group_name": "OT CHARGES",
                },
                {
                    "service_code": "OT001",
                    "service_name": "OT - 2 HOURS",
                    "service_group_name": "OT CHARGES",
                },
                {
                    "service_code": "OT002",
                    "service_name": "OT - 3 HOURS",
                    "service_group_name": "OT CHARGES",
                },
            ]
        )

        self.assertEqual(hours, 3.0)
        self.assertEqual(codes, "OT001 | OT002")

    def test_ot_stays_blank_when_no_parsable_ot_row_exists(self) -> None:
        hours, codes = supabase_db._derive_ot_duration_fields(
            [
                {
                    "service_code": "OT001",
                    "service_name": "OT CHARGES",
                    "service_group_name": "OT CHARGES",
                }
            ]
        )

        self.assertIsNone(hours)
        self.assertEqual(codes, "")

    def test_cathlab_rows_sum_duration_and_store_all_codes(self) -> None:
        hours, codes = supabase_db._derive_cath_lab_duration_fields(
            [
                {
                    "service_code": "CAT5117",
                    "service_name": "CATH LAB CHARGES - 1/2 HOUR",
                    "service_group_name": "Cath Lab Hours",
                },
                {
                    "service_code": "CAT5036",
                    "service_name": "CATH LAB CHARGES PER HOUR",
                    "service_group_name": "Cath Lab Hours",
                },
            ]
        )

        self.assertEqual(hours, 1.5)
        self.assertEqual(codes, "CAT5036 | CAT5117")

    def test_name_based_cathlab_match_works_without_code(self) -> None:
        hours, codes = supabase_db._derive_cath_lab_duration_fields(
            [
                {
                    "service_code": "",
                    "service_name": "CATH LAB CHARGES PER HOUR",
                    "service_group_name": "",
                }
            ]
        )

        self.assertEqual(hours, 1.0)
        self.assertEqual(codes, "")

    def test_emergency_flag_sets_true_for_er_physician(self) -> None:
        derived = supabase_db._derive_emergency_mlc_flags(
            [
                {
                    "service_code": "D000806",
                    "service_name": "ER Physician",
                    "service_group_name": "Consultation",
                }
            ]
        )

        self.assertTrue(derived["has_emergency_origin"])
        self.assertFalse(derived["has_mlc_charge"])
        self.assertEqual(
            derived["context_json"]["emergency_signals"],
            [
                {
                    "service_code": "D000806",
                    "service_name": "ER Physician",
                    "match_type": "service_name",
                }
            ],
        )

    def test_emergency_group_signal_alone_does_not_trigger_flag(self) -> None:
        derived = supabase_db._derive_emergency_mlc_flags(
            [
                {
                    "service_code": "LAB001",
                    "service_name": "Creatinine",
                    "service_group_name": "Emergency Investigations",
                }
            ]
        )

        self.assertFalse(derived["has_emergency_origin"])
        self.assertEqual(derived["context_json"]["summary"]["emergency_signal_count"], 0)

    def test_support_only_eme_rows_do_not_trigger_emergency_origin(self) -> None:
        derived = supabase_db._derive_emergency_mlc_flags(
            [
                {
                    "service_code": "EME0020",
                    "service_name": "GRBS",
                    "service_group_name": "ICU Support",
                    "ward_name": "MICU",
                }
            ]
        )

        self.assertFalse(derived["has_emergency_origin"])
        self.assertEqual(derived["context_json"]["emergency_signals"], [])

    def test_mlc_flag_sets_true_for_hsp0047(self) -> None:
        derived = supabase_db._derive_emergency_mlc_flags(
            [
                {
                    "service_code": "HSP0047",
                    "service_name": "MLC Charges-IP",
                    "amount": 1200,
                }
            ]
        )

        self.assertTrue(derived["has_mlc_charge"])
        self.assertEqual(
            derived["context_json"]["mlc_signals"],
            [
                {
                    "service_code": "HSP0047",
                    "service_name": "MLC Charges-IP",
                    "match_type": "service_code",
                }
            ],
        )
        self.assertEqual(derived["context_json"]["summary"]["mlc_charge_amount"], 1200.0)

    def test_mlc_flag_sets_true_for_text_without_code(self) -> None:
        derived = supabase_db._derive_emergency_mlc_flags(
            [
                {
                    "service_code": "",
                    "service_name": "Special Review",
                    "department_name": "MLC Desk",
                    "amount": 0,
                }
            ]
        )

        self.assertTrue(derived["has_mlc_charge"])
        self.assertEqual(derived["context_json"]["mlc_signals"][0]["match_type"], "department_name")

    def test_cash_row_drug_admin_uses_twelve_point_five_percent_of_pharmacy_total(self) -> None:
        rows = [
            {
                "admission_no": "IP1",
                "patient_name": "Patient One",
                "payor_bucket": "Cash",
                "fc_actual_bucket_totals_jsonb": {"pharmacy_total": 200.0},
                "fc_actual_total_excluding_fnb_and_returns": 1000.0,
            }
        ]
        updates = [
            {
                "fc_actual_cash_drug_administration_charge": 25.0,
                "fc_actual_total_excluding_fnb_and_returns_plus_cash_drug_admin": 1025.0,
            }
        ]

        validation = supabase_db._validate_main_table_cash_drug_admin_updates(rows, updates)

        self.assertFalse(validation["failed_validation"])

    def test_non_cash_row_keeps_zero_drug_admin_and_same_total(self) -> None:
        rows = [
            {
                "admission_no": "IP2",
                "patient_name": "Patient Two",
                "payor_bucket": "Non-GIPSA Insurance",
                "fc_actual_bucket_totals_jsonb": {"pharmacy_total": 200.0},
                "fc_actual_total_excluding_fnb_and_returns": 1000.0,
            }
        ]
        updates = [
            {
                "fc_actual_cash_drug_administration_charge": 0.0,
                "fc_actual_total_excluding_fnb_and_returns_plus_cash_drug_admin": 1000.0,
            }
        ]

        validation = supabase_db._validate_main_table_cash_drug_admin_updates(rows, updates)

        self.assertFalse(validation["failed_validation"])

    def test_cash_row_with_zero_pharmacy_total_stores_zero_drug_admin(self) -> None:
        rows = [
            {
                "admission_no": "IP3",
                "patient_name": "Patient Three",
                "payor_bucket": "Cash",
                "fc_actual_bucket_totals_jsonb": {"pharmacy_total": 0.0},
                "fc_actual_total_excluding_fnb_and_returns": 1000.0,
            }
        ]
        updates = [
            {
                "fc_actual_cash_drug_administration_charge": 0.0,
                "fc_actual_total_excluding_fnb_and_returns_plus_cash_drug_admin": 1000.0,
            }
        ]

        validation = supabase_db._validate_main_table_cash_drug_admin_updates(rows, updates)

        self.assertFalse(validation["failed_validation"])

    def test_same_day_daycare_style_sets_zero_normalized_los(self) -> None:
        normalized_days, reason, same_day_daycare_style = supabase_db._compute_normalized_billable_stay_days(
            {
                "date_of_admission": datetime(2025, 3, 21, 9, 0, tzinfo=timezone.utc),
                "date_of_discharge": datetime(2025, 3, 21, 18, 0, tzinfo=timezone.utc),
                "los_days": 0.38,
                "is_daycare_broad": True,
                "services_json": [
                    {
                        "service_code": "ROM0010",
                        "service_name": "Bed Charges - Daycare",
                        "service_type": "Ward Charges",
                    }
                ],
            }
        )

        self.assertEqual(normalized_days, 0)
        self.assertEqual(reason, "same_day_daycare_fractional_los")
        self.assertTrue(same_day_daycare_style)

    def test_same_day_room_charge_sets_one_normalized_los(self) -> None:
        normalized_days, reason, same_day_daycare_style = supabase_db._compute_normalized_billable_stay_days(
            {
                "date_of_admission": datetime(2025, 3, 21, 8, 0, tzinfo=timezone.utc),
                "date_of_discharge": datetime(2025, 3, 21, 20, 0, tzinfo=timezone.utc),
                "los_days": 0.5,
                "is_daycare_broad": False,
                "services_json": [
                    {
                        "service_code": "ROM5001",
                        "service_name": "General Ward Bed Charges",
                        "service_type": "WARD CHARGES",
                        "ward_name": "GENERAL WARD",
                    }
                ],
            }
        )

        self.assertEqual(normalized_days, 1)
        self.assertEqual(reason, "same_day_room_based_stay")
        self.assertFalse(same_day_daycare_style)

    def test_cross_day_early_admission_uses_inclusive_days(self) -> None:
        normalized_days, reason, _same_day_daycare_style = supabase_db._compute_normalized_billable_stay_days(
            {
                "date_of_admission": datetime(2025, 3, 21, 8, 0, tzinfo=timezone.utc),
                "date_of_discharge": datetime(2025, 3, 23, 18, 0, tzinfo=timezone.utc),
                "los_days": 2.4,
                "is_daycare_broad": False,
                "icu_days": 0.0,
                "ward_days": 3.0,
                "services_json": [],
            }
        )

        self.assertEqual(normalized_days, 3)
        self.assertEqual(reason, "cross_day_inclusive")

    def test_cross_day_late_admission_subtracts_one_day(self) -> None:
        normalized_days, reason, _same_day_daycare_style = supabase_db._compute_normalized_billable_stay_days(
            {
                "date_of_admission": datetime(2025, 3, 21, 14, 15, tzinfo=timezone.utc),
                "date_of_discharge": datetime(2025, 3, 23, 10, 0, tzinfo=timezone.utc),
                "los_days": 1.82,
                "is_daycare_broad": False,
                "icu_days": 0.0,
                "ward_days": 2.0,
                "services_json": [],
            }
        )

        self.assertEqual(normalized_days, 2)
        self.assertEqual(reason, "cross_day_late_admission_adjusted")

    def test_cross_day_late_admission_never_drops_below_one(self) -> None:
        normalized_days, reason, _same_day_daycare_style = supabase_db._compute_normalized_billable_stay_days(
            {
                "date_of_admission": datetime(2025, 3, 21, 22, 0, tzinfo=timezone.utc),
                "date_of_discharge": datetime(2025, 3, 22, 6, 0, tzinfo=timezone.utc),
                "los_days": 0.33,
                "is_daycare_broad": False,
                "icu_days": 0.0,
                "ward_days": 1.0,
                "services_json": [],
            }
        )

        self.assertEqual(normalized_days, 1)
        self.assertEqual(reason, "cross_day_late_admission_adjusted")

    def test_cross_day_non_floor_non_ceil_delta_one_is_adjusted_down_by_one(self) -> None:
        normalized_days, reason, _same_day_daycare_style = supabase_db._compute_normalized_billable_stay_days(
            {
                "date_of_admission": datetime(2025, 1, 3, 11, 45, 55, tzinfo=timezone.utc),
                "date_of_discharge": datetime(2025, 1, 5, 11, 5, 24, tzinfo=timezone.utc),
                "los_days": 1.97,
                "is_daycare_broad": False,
                "icu_days": 0.0,
                "ward_days": 2.0,
                "services_json": [],
            }
        )

        self.assertEqual(normalized_days, 2)
        self.assertEqual(reason, "cross_day_inclusive_stay_aligned_minus_one")

    def test_cross_day_non_floor_non_ceil_delta_two_is_adjusted_down_by_one(self) -> None:
        normalized_days, reason, _same_day_daycare_style = supabase_db._compute_normalized_billable_stay_days(
            {
                "date_of_admission": datetime(2025, 1, 21, 10, 26, 6, tzinfo=timezone.utc),
                "date_of_discharge": datetime(2025, 1, 22, 1, 22, 53, tzinfo=timezone.utc),
                "los_days": 0.62,
                "is_daycare_broad": True,
                "icu_days": 0.0,
                "ward_days": 0.0,
                "services_json": [],
            }
        )

        self.assertEqual(normalized_days, 1)
        self.assertEqual(reason, "cross_day_inclusive_stay_aligned_minus_one")

    def test_missing_date_daycare_fallback_sets_zero(self) -> None:
        normalized_days, reason, same_day_daycare_style = supabase_db._compute_normalized_billable_stay_days(
            {
                "date_of_admission": None,
                "date_of_discharge": None,
                "los_days": 0.75,
                "is_daycare_broad": True,
                "services_json": [],
            }
        )

        self.assertEqual(normalized_days, 0)
        self.assertEqual(reason, "missing_dates_daycare_los_lt_1")
        self.assertFalse(same_day_daycare_style)

    def test_missing_date_non_daycare_fallback_uses_ceil_los(self) -> None:
        normalized_days, reason, same_day_daycare_style = supabase_db._compute_normalized_billable_stay_days(
            {
                "date_of_admission": None,
                "date_of_discharge": None,
                "los_days": 1.25,
                "is_daycare_broad": False,
                "services_json": [],
            }
        )

        self.assertEqual(normalized_days, 2)
        self.assertEqual(reason, "missing_dates_fallback_ceil_los")
        self.assertFalse(same_day_daycare_style)

    def test_service_bucketing_excludes_food_and_beverage_rows(self) -> None:
        payload = fc_actuals.compute_fc_actual_bucket_payload(
            services_json=[
                {
                    "service_code": "INV001",
                    "service_name": "CRP",
                    "service_type": "Investigations",
                    "amount": 500,
                },
                {
                    "service_code": "FOOD001",
                    "service_name": "Diet Lunch",
                    "department_name": "Food and Beverages",
                    "amount": 200,
                },
            ],
            pharmacy_json={},
            service_by_code={"INV001": {"fc_estimate_bucket": "Investigations"}},
            service_by_name={},
            pharmacy_by_code={},
            pharmacy_by_name={},
        )

        self.assertEqual(payload["bucket_totals"]["investigations"], 500.0)
        self.assertEqual(payload["bucket_totals"]["other_services"], 0.0)
        self.assertEqual(payload["total_excluding_fnb_and_returns"], 500.0)

    def test_pharmacy_returns_reduce_bucket_totals_without_creating_returns_bucket(self) -> None:
        payload = fc_actuals.compute_fc_actual_bucket_payload(
            services_json=[],
            pharmacy_json={
                "items": [
                    {
                        "item_code": "DRUG01",
                        "item_desc": "Paracetamol",
                        "quantity": 2,
                        "amount": 200,
                        "pharmacy_section": "ip_pharmacy",
                    }
                ],
                "returns": [
                    {
                        "item_code": "DRUG01",
                        "item_desc": "Paracetamol",
                        "return_quantity": 1,
                        "return_amount": 100,
                    }
                ],
            },
            service_by_code={},
            service_by_name={},
            pharmacy_by_code={"DRUG01": {"Bucket": DRUG_CLASS}},
            pharmacy_by_name={},
        )

        self.assertEqual(payload["bucket_totals"]["ip_drugs"], 100.0)
        self.assertEqual(payload["bucket_totals"]["pharmacy_total"], 100.0)

    def test_fc_actual_prefers_cleaned_pharmacy_bucket_totals_when_available(self) -> None:
        payload = fc_actuals.compute_fc_actual_bucket_payload(
            services_json=[],
            pharmacy_json={
                "items": [
                    {
                        "item_code": "DRUG01",
                        "item_desc": "Paracetamol",
                        "quantity": 10,
                        "amount": 9999,
                        "pharmacy_section": "ip_pharmacy",
                    }
                ]
            },
            service_by_code={},
            service_by_name={},
            pharmacy_by_code={"DRUG01": {"Bucket": DRUG_CLASS}},
            pharmacy_by_name={},
            cleaned_pharmacy_net_json={
                "summary": {
                    "bucket_totals": {
                        "ip_drugs": 123.45,
                        "ip_consumables": 10.0,
                        "ot_drugs": 0.0,
                        "ot_consumables": 5.0,
                        "implants": 1.0,
                        "pharmacy_total": 999.0,
                    }
                }
            },
        )

        self.assertEqual(payload["bucket_totals"]["ip_drugs"], 123.45)
        self.assertEqual(payload["bucket_totals"]["ip_consumables"], 10.0)
        self.assertEqual(payload["bucket_totals"]["ot_consumables"], 5.0)
        self.assertEqual(payload["bucket_totals"]["implants"], 1.0)
        self.assertEqual(payload["bucket_totals"]["pharmacy_total"], 139.45)
        self.assertNotIn("returns", payload["bucket_totals"])

    def test_mixed_ot_ip_quantities_preserve_cleaned_allocation_behavior(self) -> None:
        payload = fc_actuals.compute_fc_actual_bucket_payload(
            services_json=[],
            pharmacy_json={
                "items": [
                    {
                        "item_code": "SUP01",
                        "item_desc": "Syringe",
                        "quantity": 1,
                        "amount": 10,
                        "pharmacy_section": "ot_pharmacy",
                    },
                    {
                        "item_code": "SUP01",
                        "item_desc": "Syringe",
                        "quantity": 3,
                        "amount": 30,
                        "pharmacy_section": "ip_pharmacy",
                    },
                ],
                "returns": [
                    {
                        "item_code": "SUP01",
                        "item_desc": "Syringe",
                        "return_quantity": 1,
                        "return_amount": 10,
                    }
                ],
            },
            service_by_code={},
            service_by_name={},
            pharmacy_by_code={"SUP01": {"Bucket": SUPPLY_CLASS}},
            pharmacy_by_name={},
        )

        self.assertEqual(payload["bucket_totals"]["ot_consumables"], 10.0)
        self.assertEqual(payload["bucket_totals"]["ip_consumables"], 20.0)
        self.assertEqual(payload["bucket_totals"]["pharmacy_total"], 30.0)

    def test_total_matches_sum_of_all_heads_except_pharmacy_total(self) -> None:
        payload = fc_actuals.compute_fc_actual_bucket_payload(
            services_json=[
                {
                    "service_code": "RM001",
                    "service_name": "Room Charges",
                    "service_type": "Ward Charges",
                    "amount": 1000,
                }
            ],
            pharmacy_json={
                "items": [
                    {
                        "item_code": "DRUG01",
                        "item_desc": "Paracetamol",
                        "quantity": 1,
                        "amount": 250,
                        "pharmacy_section": "ip_pharmacy",
                    }
                ]
            },
            service_by_code={"RM001": {"fc_estimate_bucket": "Room Charges"}},
            service_by_name={},
            pharmacy_by_code={"DRUG01": {"Bucket": DRUG_CLASS}},
            pharmacy_by_name={},
        )

        bucket_totals = payload["bucket_totals"]
        expected_total = sum(bucket_totals[key] for key in fc_actuals.FC_ACTUAL_BUCKET_ORDER if key != "pharmacy_total")
        self.assertEqual(payload["total_excluding_fnb_and_returns"], expected_total)

    def test_cleaned_pharmacy_issue_uses_quantity_times_sale_rate_when_amount_is_inflated(self) -> None:
        payloads = fc_actuals.build_cleaned_pharmacy_payloads(
            pharmacy_json={
                "items": [
                    {
                        "item_code": "DRUG01",
                        "normalized_item_desc": "Paracetamol",
                        "quantity": 2,
                        "sale_rate": 50,
                        "amount": 5000,
                        "pharmacy_section": "ip_pharmacy",
                    }
                ]
            },
            by_code={"DRUG01": {"Bucket": DRUG_CLASS}},
            by_name={},
        )

        self.assertEqual(payloads["raw_issue_amount_total"], 5000.0)
        self.assertEqual(payloads["reconstructed_issue_amount_total"], 100.0)
        self.assertEqual(payloads["issue_payload"]["summary"]["gross_amount_total"], 100.0)
        self.assertEqual(payloads["net_payload"]["summary"]["bucket_totals"]["ip_drugs"], 100.0)

    def test_cleaned_pharmacy_returns_use_return_quantity_times_sale_rate(self) -> None:
        payloads = fc_actuals.build_cleaned_pharmacy_payloads(
            pharmacy_json={
                "returns": [
                    {
                        "item_code": "DRUG01",
                        "normalized_item_desc": "Paracetamol",
                        "return_quantity": 2,
                        "sale_rate": 25,
                        "return_amount": 5000,
                    }
                ]
            },
            by_code={"DRUG01": {"Bucket": DRUG_CLASS}},
            by_name={},
        )

        self.assertEqual(payloads["returns_payload"]["summary"]["return_amount_total"], 50.0)

    def test_cleaned_pharmacy_net_preserves_mixed_ot_ip_allocation_behavior(self) -> None:
        payloads = fc_actuals.build_cleaned_pharmacy_payloads(
            pharmacy_json={
                "items": [
                    {
                        "item_code": "SUP01",
                        "normalized_item_desc": "Syringe",
                        "quantity": 1,
                        "sale_rate": 10,
                        "pharmacy_section": "ot_pharmacy",
                    },
                    {
                        "item_code": "SUP01",
                        "normalized_item_desc": "Syringe",
                        "quantity": 3,
                        "sale_rate": 10,
                        "pharmacy_section": "ip_pharmacy",
                    },
                ],
                "returns": [
                    {
                        "item_code": "SUP01",
                        "normalized_item_desc": "Syringe",
                        "return_quantity": 1,
                        "sale_rate": 10,
                    }
                ],
            },
            by_code={"SUP01": {"Bucket": SUPPLY_CLASS}},
            by_name={},
        )

        bucket_totals = payloads["net_payload"]["summary"]["bucket_totals"]
        self.assertEqual(bucket_totals["ot_consumables"], 10.0)
        self.assertEqual(bucket_totals["ip_consumables"], 20.0)
        self.assertEqual(bucket_totals["pharmacy_total"], 30.0)
        net_item = payloads["net_payload"]["items"][0]
        self.assertEqual(net_item["raw_ot_quantity_issued"], 1.0)
        self.assertEqual(net_item["raw_ip_quantity_issued"], 3.0)
        self.assertEqual(net_item["raw_return_quantity"], 1.0)
        self.assertEqual(net_item["derived_net_ot_quantity"], 1.0)
        self.assertEqual(net_item["derived_net_ip_quantity"], 2.0)

    def test_cleaned_pharmacy_net_bucket_totals_reconcile_to_item_amounts(self) -> None:
        payloads = fc_actuals.build_cleaned_pharmacy_payloads(
            pharmacy_json={
                "items": [
                    {
                        "item_code": "DRUG01",
                        "normalized_item_desc": "Paracetamol",
                        "quantity": 2,
                        "sale_rate": 50,
                        "pharmacy_section": "ip_pharmacy",
                    },
                    {
                        "item_code": "IMP01",
                        "normalized_item_desc": "Implant",
                        "quantity": 1,
                        "sale_rate": 250,
                        "pharmacy_section": "ot_pharmacy",
                    },
                ]
            },
            by_code={"DRUG01": {"Bucket": DRUG_CLASS}, "IMP01": {"Bucket": "Implants / Stents"}},
            by_name={},
        )

        net_items = payloads["net_payload"]["items"]
        self.assertEqual(payloads["net_payload"]["summary"]["net_amount_total"], round(sum(item["net_amount"] for item in net_items), 2))
        self.assertEqual(
            payloads["net_payload"]["summary"]["bucket_totals"]["pharmacy_total"],
            round(
                sum(
                    payloads["net_payload"]["summary"]["bucket_totals"][key]
                    for key in ["ip_drugs", "ip_consumables", "ot_drugs", "ot_consumables", "implants"]
                ),
                2,
            ),
        )

    def test_cleaned_pharmacy_hemalatha_style_inflated_bill_amounts_reconstruct_correct_total(self) -> None:
        payloads = fc_actuals.build_cleaned_pharmacy_payloads(
            pharmacy_json={
                "items": [
                    {
                        "item_code": "OTDRUG",
                        "normalized_item_desc": "OT Drug",
                        "quantity": 1,
                        "sale_rate": 8388.17,
                        "amount": 1000000,
                        "pharmacy_section": "ot_pharmacy",
                    },
                    {
                        "item_code": "OTCONS",
                        "normalized_item_desc": "OT Consumable",
                        "quantity": 1,
                        "sale_rate": 60384.01,
                        "amount": 1000000,
                        "pharmacy_section": "ot_pharmacy",
                    },
                    {
                        "item_code": "IPDRUG",
                        "normalized_item_desc": "IP Drug",
                        "quantity": 1,
                        "sale_rate": 9712.99,
                        "amount": 1000000,
                        "pharmacy_section": "ip_pharmacy",
                    },
                    {
                        "item_code": "IPCONS",
                        "normalized_item_desc": "IP Consumable",
                        "quantity": 1,
                        "sale_rate": 10539.5,
                        "amount": 1000000,
                        "pharmacy_section": "ip_pharmacy",
                    },
                    {
                        "item_code": "IMP01",
                        "normalized_item_desc": "Implant",
                        "quantity": 1,
                        "sale_rate": 89130.15,
                        "amount": 1000000,
                        "pharmacy_section": "ot_pharmacy",
                    },
                ],
            },
            by_code={
                "OTDRUG": {"Bucket": DRUG_CLASS},
                "OTCONS": {"Bucket": SUPPLY_CLASS},
                "IPDRUG": {"Bucket": DRUG_CLASS},
                "IPCONS": {"Bucket": SUPPLY_CLASS},
                "IMP01": {"Bucket": "Implants / Stents"},
            },
            by_name={},
        )

        self.assertEqual(payloads["net_payload"]["summary"]["bucket_totals"]["pharmacy_total"], 178154.82)

    def test_cleaned_pharmacy_skips_duplicate_null_code_return_alias_when_coded_return_exists(self) -> None:
        payloads = fc_actuals.build_cleaned_pharmacy_payloads(
            pharmacy_json={
                "items": [
                    {
                        "item_code": "BEDU47",
                        "normalized_item_desc": "BED BATH TOWELS",
                        "quantity": 2,
                        "sale_rate": 650,
                        "pharmacy_section": "ip_pharmacy",
                    }
                ],
                "returns": [
                    {
                        "item_code": "BEDU47",
                        "normalized_item_desc": "BED BATH TOWELS",
                        "return_quantity": 1,
                        "sale_rate": 650,
                        "return_amount": 650,
                    },
                    {
                        "item_code": "",
                        "normalized_item_desc": "BED BATH TOWELS",
                        "return_quantity": 1,
                        "sale_rate": None,
                        "return_amount": 650,
                    },
                ],
            },
            by_code={"BEDU47": {"Bucket": SUPPLY_CLASS}},
            by_name={},
        )

        self.assertEqual(payloads["returns_payload"]["summary"]["item_count"], 1)
        self.assertEqual(payloads["returns_payload"]["summary"]["return_quantity_total"], 1.0)
        self.assertEqual(payloads["net_payload"]["summary"]["item_count"], 1)
        self.assertEqual(payloads["net_payload"]["summary"]["bucket_totals"]["ip_consumables"], 650.0)
        net_item = payloads["net_payload"]["items"][0]
        self.assertEqual(net_item["raw_ip_quantity_issued"], 2.0)
        self.assertEqual(net_item["raw_return_quantity"], 1.0)
        self.assertEqual(net_item["derived_net_ip_quantity"], 1.0)

    def test_cleaned_pharmacy_net_item_exposes_observed_and_derived_fields(self) -> None:
        payloads = fc_actuals.build_cleaned_pharmacy_payloads(
            pharmacy_json={
                "items": [
                    {
                        "item_code": "DRUG01",
                        "normalized_item_desc": "Paracetamol",
                        "quantity": 2,
                        "sale_rate": 50,
                        "pharmacy_section": "ip_pharmacy",
                    }
                ],
                "returns": [
                    {
                        "item_code": "DRUG01",
                        "normalized_item_desc": "Paracetamol",
                        "return_quantity": 1,
                        "sale_rate": 50,
                    }
                ],
            },
            by_code={"DRUG01": {"Bucket": DRUG_CLASS}},
            by_name={},
        )

        net_item = payloads["net_payload"]["items"][0]
        self.assertEqual(
            sorted(net_item.keys()),
            sorted(
                [
                    "classification",
                    "derived_net_ip_amount",
                    "derived_net_ip_quantity",
                    "derived_net_ot_amount",
                    "derived_net_ot_quantity",
                    "ip_rate",
                    "item_code",
                    "item_name",
                    "net_amount",
                    "normalized_item_desc",
                    "ot_rate",
                    "raw_ip_quantity_issued",
                    "raw_ot_quantity_issued",
                    "raw_return_quantity",
                ]
            ),
        )

    def test_service_code_match_takes_precedence_over_generic_name_alias(self) -> None:
        coverage = fc_actuals.audit_mapping_coverage(
            services_json=[
                {
                    "service_code": "CAR5341",
                    "service_name": "ECG",
                    "service_type": "Services",
                    "amount": 500,
                }
            ],
            pharmacy_json={},
            service_by_code={"CAR5341": {"fc_estimate_bucket": "Bedside Services"}},
            service_by_name={"ECG": {"fc_estimate_bucket": "Investigations"}},
            pharmacy_by_code={},
            pharmacy_by_name={},
        )

        self.assertEqual(coverage["ambiguous_service_rows"], [])
        self.assertEqual(coverage["unmapped_service_rows"], [])

    @patch("scripts.etl.common.supabase_db.compute_fc_actual_bucket_payload")
    def test_updates_derive_stored_totals_from_rounded_bucket_heads(self, recompute_mock) -> None:
        recompute_mock.return_value = {
            "bucket_totals": {
                "room_charges": 100.0,
                "investigations": 0.0,
                "procedure_ot_charges": 0.0,
                "bedside_services": 0.0,
                "professional_fees": 0.0,
                "other_services": 0.0,
                "ip_drugs": 10.004,
                "ip_consumables": 20.004,
                "ot_drugs": 0.0,
                "ot_consumables": 0.0,
                "implants": 0.0,
                "pharmacy_total": 30.008,
            },
            "total_excluding_fnb_and_returns": 130.008,
            "reconciliation_delta": 0.0,
        }

        updates = supabase_db._compute_fc_actual_updates(
            [
                {
                    "main_table_key": "mt-ip1",
                    "hospital_id": 1,
                    "admission_no": "IP1",
                    "patient_name": "Patient One",
                    "services_json": [],
                    "pharmacy_json": {},
                }
            ],
            {},
            {},
            {},
            {},
        )

        self.assertEqual(updates[0]["bucket_totals"]["pharmacy_total"], 30.0)
        self.assertEqual(updates[0]["total_excluding_fnb_and_returns"], 130.0)

    @patch("scripts.etl.common.supabase_db._compute_fc_actual_updates")
    @patch("scripts.etl.common.supabase_db._build_fc_actual_audit_results")
    @patch("scripts.etl.common.supabase_db._fetch_source_rollups_by_admission")
    @patch("scripts.etl.common.supabase_db.load_fc_actual_mappings")
    @patch("scripts.etl.common.supabase_db._fetch_target_main_table_rows")
    def test_targeted_update_mode_only_writes_selected_rows(
        self,
        fetch_rows_mock,
        load_mappings_mock,
        fetch_source_mock,
        build_audits_mock,
        compute_updates_mock,
    ) -> None:
        class FakeCursor:
            def __init__(self) -> None:
                self.executemany_calls: list[tuple[str, list[tuple[object, ...]]]] = []

            def executemany(self, sql: str, rows: list[tuple[object, ...]]) -> None:
                self.executemany_calls.append((sql, rows))

        fetch_rows_mock.return_value = [
            {
                "main_table_key": "mt-ip1",
                "hospital_id": 1,
                "admission_no": "IP1",
                "patient_name": "Patient One",
                "services_json": [],
                "pharmacy_json": {},
            }
        ]
        load_mappings_mock.return_value = ({}, {}, {}, {})
        fetch_source_mock.return_value = {}
        build_audits_mock.return_value = [
            {
                "admission_no": "IP1",
                "unmapped_service_rows": [],
                "unmapped_pharmacy_rows": [],
                "ambiguous_service_rows": [],
                "ambiguous_pharmacy_rows": [],
                "failed_checks": [],
                "passed": True,
            }
        ]
        compute_updates_mock.return_value = [
            {
                "main_table_key": "mt-ip1",
                "hospital_id": 1,
                "admission_no": "IP1",
                "patient_name": "Patient One",
                "bucket_totals": {key: 0.0 for key in fc_actuals.FC_ACTUAL_BUCKET_ORDER},
                "total_excluding_fnb_and_returns": 0.0,
                "reconciliation_delta": 0.0,
            }
        ]

        cursor = FakeCursor()
        summary = supabase_db._populate_main_table_fc_actual_buckets(
            cursor,
            admission_nos=["IP1"],
            dry_run=False,
        )

        self.assertEqual(summary["rows_written"], 1)
        self.assertEqual(len(cursor.executemany_calls), 1)
        self.assertEqual(cursor.executemany_calls[0][1][0][2], "mt-ip1")

    @patch("scripts.etl.common.supabase_db._populate_main_table_cash_drug_admin_fields")
    @patch("scripts.etl.common.supabase_db._populate_main_table_fc_actual_quality_flags")
    @patch("scripts.etl.common.supabase_db._validate_fc_actual_stored_values")
    @patch("scripts.etl.common.supabase_db._populate_main_table_fc_actual_buckets")
    @patch("scripts.etl.common.supabase_db.connect_db")
    def test_targeted_enrich_fc_actual_buckets_refreshes_quality_and_cash_fields(
        self,
        connect_db_mock,
        populate_fc_actual_mock,
        validate_fc_actual_mock,
        populate_quality_mock,
        populate_cash_mock,
    ) -> None:
        class FakeCursor:
            pass

        class FakeConnection:
            def __init__(self) -> None:
                self.cursor_obj = FakeCursor()
                self.committed = False

            def __enter__(self) -> "FakeConnection":
                return self

            def __exit__(self, exc_type, exc, tb) -> None:
                return None

            def cursor(self) -> "FakeConnection":
                return self

            def execute(self, *_args: object, **_kwargs: object) -> None:
                return None

            def commit(self) -> None:
                self.committed = True

            def __iter__(self):
                return iter(())

        fake_conn = FakeConnection()
        connect_db_mock.return_value = fake_conn
        populate_fc_actual_mock.return_value = {"rows_written": 1}
        validate_fc_actual_mock.return_value = {
            "validated_row_count": 1,
            "total_vs_bucket_mismatch_count": 0,
            "pharmacy_total_mismatch_count": 0,
            "recomputed_vs_stored_mismatch_count": 0,
            "failed_validation": False,
        }
        populate_quality_mock.return_value = {"rows_written": 1}
        populate_cash_mock.return_value = {"rows_written": 1}

        summary = supabase_db.enrich_main_table_fc_actual_buckets(admission_nos=["IP1"])

        self.assertEqual(summary["quality_refresh"]["rows_written"], 1)
        self.assertEqual(summary["cash_drug_admin_refresh"]["rows_written"], 1)
        populate_quality_mock.assert_called_once()
        populate_cash_mock.assert_called_once()

    @patch("scripts.etl.common.supabase_db.compute_fc_actual_bucket_payload")
    @patch("scripts.etl.common.supabase_db.load_fc_actual_mappings")
    @patch("scripts.etl.common.supabase_db._fetch_stored_fc_actual_rows")
    def test_validation_passes_when_stored_values_match_recomputed(
        self,
        fetch_rows_mock,
        load_mappings_mock,
        recompute_mock,
    ) -> None:
        fetch_rows_mock.return_value = [
            {
                "admission_no": "IP1",
                "patient_name": "Patient One",
                "services_json": [],
                "pharmacy_json": {},
                "stored_bucket_totals": {
                    "room_charges": 100.0,
                    "investigations": 0.0,
                    "procedure_ot_charges": 0.0,
                    "bedside_services": 0.0,
                    "professional_fees": 0.0,
                    "other_services": 0.0,
                    "ip_drugs": 10.0,
                    "ip_consumables": 20.0,
                    "ot_drugs": 0.0,
                    "ot_consumables": 0.0,
                    "implants": 0.0,
                    "pharmacy_total": 30.0,
                },
                "stored_total_excluding_fnb_and_returns": 130.0,
            }
        ]
        load_mappings_mock.return_value = ({}, {}, {}, {})
        recompute_mock.return_value = {
            "bucket_totals": {
                "room_charges": 100.0,
                "investigations": 0.0,
                "procedure_ot_charges": 0.0,
                "bedside_services": 0.0,
                "professional_fees": 0.0,
                "other_services": 0.0,
                "ip_drugs": 10.0,
                "ip_consumables": 20.0,
                "ot_drugs": 0.0,
                "ot_consumables": 0.0,
                "implants": 0.0,
                "pharmacy_total": 30.0,
            },
            "total_excluding_fnb_and_returns": 130.0,
        }

        summary = supabase_db._validate_fc_actual_stored_values(object(), admission_nos=["IP1"])

        self.assertEqual(summary["validated_row_count"], 1)
        self.assertEqual(summary["total_vs_bucket_mismatch_count"], 0)
        self.assertEqual(summary["pharmacy_total_mismatch_count"], 0)
        self.assertEqual(summary["recomputed_vs_stored_mismatch_count"], 0)
        self.assertFalse(summary["failed_validation"])

    @patch("scripts.etl.common.supabase_db.compute_fc_actual_bucket_payload")
    @patch("scripts.etl.common.supabase_db.load_fc_actual_mappings")
    @patch("scripts.etl.common.supabase_db._fetch_stored_fc_actual_rows")
    def test_validation_flags_total_and_pharmacy_mismatches(
        self,
        fetch_rows_mock,
        load_mappings_mock,
        recompute_mock,
    ) -> None:
        fetch_rows_mock.return_value = [
            {
                "admission_no": "IP1",
                "patient_name": "Patient One",
                "services_json": [],
                "pharmacy_json": {},
                "stored_bucket_totals": {
                    "room_charges": 100.0,
                    "investigations": 0.0,
                    "procedure_ot_charges": 0.0,
                    "bedside_services": 0.0,
                    "professional_fees": 0.0,
                    "other_services": 0.0,
                    "ip_drugs": 10.0,
                    "ip_consumables": 20.0,
                    "ot_drugs": 0.0,
                    "ot_consumables": 0.0,
                    "implants": 0.0,
                    "pharmacy_total": 99.0,
                },
                "stored_total_excluding_fnb_and_returns": 555.0,
            }
        ]
        load_mappings_mock.return_value = ({}, {}, {}, {})
        recompute_mock.return_value = {
            "bucket_totals": {
                "room_charges": 100.0,
                "investigations": 0.0,
                "procedure_ot_charges": 0.0,
                "bedside_services": 0.0,
                "professional_fees": 0.0,
                "other_services": 0.0,
                "ip_drugs": 10.0,
                "ip_consumables": 20.0,
                "ot_drugs": 0.0,
                "ot_consumables": 0.0,
                "implants": 0.0,
                "pharmacy_total": 30.0,
            },
            "total_excluding_fnb_and_returns": 130.0,
        }

        summary = supabase_db._validate_fc_actual_stored_values(object(), admission_nos=["IP1"])

        self.assertEqual(summary["total_vs_bucket_mismatch_count"], 1)
        self.assertEqual(summary["pharmacy_total_mismatch_count"], 1)
        self.assertEqual(summary["recomputed_vs_stored_mismatch_count"], 1)
        self.assertTrue(summary["failed_validation"])

    @patch("scripts.etl.common.supabase_db.compute_fc_actual_bucket_payload")
    @patch("scripts.etl.common.supabase_db.load_fc_actual_mappings")
    @patch("scripts.etl.common.supabase_db._fetch_stored_fc_actual_rows")
    def test_validation_uses_rounded_recomputed_bucket_sums(
        self,
        fetch_rows_mock,
        load_mappings_mock,
        recompute_mock,
    ) -> None:
        fetch_rows_mock.return_value = [
            {
                "admission_no": "IP1",
                "patient_name": "Patient One",
                "services_json": [],
                "pharmacy_json": {},
                "stored_bucket_totals": {
                    "room_charges": 100.0,
                    "investigations": 0.0,
                    "procedure_ot_charges": 0.0,
                    "bedside_services": 0.0,
                    "professional_fees": 0.0,
                    "other_services": 0.0,
                    "ip_drugs": 10.0,
                    "ip_consumables": 20.0,
                    "ot_drugs": 0.0,
                    "ot_consumables": 0.0,
                    "implants": 0.0,
                    "pharmacy_total": 30.0,
                },
                "stored_total_excluding_fnb_and_returns": 130.0,
            }
        ]
        load_mappings_mock.return_value = ({}, {}, {}, {})
        recompute_mock.return_value = {
            "bucket_totals": {
                "room_charges": 100.0,
                "investigations": 0.0,
                "procedure_ot_charges": 0.0,
                "bedside_services": 0.0,
                "professional_fees": 0.0,
                "other_services": 0.0,
                "ip_drugs": 10.004,
                "ip_consumables": 20.004,
                "ot_drugs": 0.0,
                "ot_consumables": 0.0,
                "implants": 0.0,
                "pharmacy_total": 30.008,
            },
            "total_excluding_fnb_and_returns": 130.008,
        }

        summary = supabase_db._validate_fc_actual_stored_values(object(), admission_nos=["IP1"])

        self.assertEqual(summary["total_vs_bucket_mismatch_count"], 0)
        self.assertEqual(summary["pharmacy_total_mismatch_count"], 0)
        self.assertEqual(summary["recomputed_vs_stored_mismatch_count"], 0)
        self.assertFalse(summary["failed_validation"])

    def test_tiny_total_placeholder_flags_exclude_all_targets(self) -> None:
        result = fc_actual_quality.evaluate_fc_actual_quality(
            {
                "patient_name": "Patient One",
                "payor_bucket": "Cash",
                "organization_name": "General Patients",
                "package_name": "",
                "package_amount": None,
                "los_days": 1.25,
                "icu_days": 0,
                "ward_days": 1,
                "room_category": "",
                "is_daycare_broad": False,
                "has_package": False,
                "services_json": [],
                "fc_actual_total_excluding_fnb_and_returns": 1,
                "fc_actual_bucket_totals_jsonb": {"procedure_ot_charges": 1},
            }
        )

        self.assertEqual(result["quality_level"], fc_actual_quality.QUALITY_LEVEL_EXCLUDE_ALL_TARGETS)
        self.assertEqual(result["quality_flags_json"]["rules"][0]["code"], "tiny_total_placeholder")

    def test_long_stay_sparse_actual_flags_exclude_all_targets(self) -> None:
        result = fc_actual_quality.evaluate_fc_actual_quality(
            {
                "patient_name": "Patient One",
                "payor_bucket": "Non-GIPSA Insurance",
                "organization_name": "Insurer",
                "package_name": "",
                "package_amount": None,
                "los_days": 14.05,
                "icu_days": 0,
                "ward_days": 15,
                "room_category": "",
                "is_daycare_broad": False,
                "has_package": False,
                "services_json": [],
                "fc_actual_total_excluding_fnb_and_returns": 12200,
                "fc_actual_bucket_totals_jsonb": {
                    "room_charges": 0,
                    "investigations": 0,
                    "procedure_ot_charges": 12200,
                    "bedside_services": 0,
                    "professional_fees": 0,
                    "other_services": 0,
                    "pharmacy_total": 0,
                },
            }
        )

        self.assertEqual(result["quality_level"], fc_actual_quality.QUALITY_LEVEL_EXCLUDE_ALL_TARGETS)
        self.assertIn("long_stay_sparse_actual", [rule["code"] for rule in result["quality_flags_json"]["rules"]])

    def test_missing_room_for_real_stay_flags_exclude_total_room_targets(self) -> None:
        result = fc_actual_quality.evaluate_fc_actual_quality(
            {
                "patient_name": "Patient One",
                "payor_bucket": "Non-GIPSA Insurance",
                "organization_name": "Insurer",
                "package_name": "",
                "package_amount": None,
                "los_days": 28.88,
                "icu_days": 0,
                "ward_days": 29,
                "room_category": "General",
                "is_daycare_broad": False,
                "has_package": False,
                "services_json": [],
                "fc_actual_total_excluding_fnb_and_returns": 169939.71,
                "fc_actual_bucket_totals_jsonb": {
                    "room_charges": 0,
                    "investigations": 0,
                    "procedure_ot_charges": 70560,
                    "bedside_services": 0,
                    "professional_fees": 0,
                    "other_services": 0,
                    "pharmacy_total": 99379.71,
                },
            }
        )

        self.assertEqual(result["quality_level"], fc_actual_quality.QUALITY_LEVEL_EXCLUDE_TOTAL_ROOM_TARGETS)
        rule = result["quality_flags_json"]["rules"][0]
        self.assertEqual(rule["code"], "missing_room_for_real_stay")
        self.assertEqual(
            rule["affected_targets"],
            ["fc_actual_total_excluding_fnb_and_returns", "room_charges", "los_linked_room_features"],
        )

    def test_package_rows_are_not_flagged_by_missing_room_for_real_stay(self) -> None:
        result = fc_actual_quality.evaluate_fc_actual_quality(
            {
                "patient_name": "Patient One",
                "payor_bucket": "GIPSA Insurance",
                "organization_name": "Insurer",
                "package_name": "Pkg",
                "package_amount": 100000,
                "los_days": 10,
                "icu_days": 0,
                "ward_days": 10,
                "room_category": "General",
                "is_daycare_broad": False,
                "has_package": True,
                "services_json": [],
                "fc_actual_total_excluding_fnb_and_returns": 120000,
                "fc_actual_bucket_totals_jsonb": {
                    "room_charges": 0,
                    "investigations": 0,
                    "procedure_ot_charges": 60000,
                    "bedside_services": 0,
                    "professional_fees": 0,
                    "other_services": 0,
                    "pharmacy_total": 60000,
                },
            }
        )

        self.assertEqual(result["quality_level"], fc_actual_quality.QUALITY_LEVEL_OK)
        self.assertEqual(result["quality_flags_json"]["rules"], [])

    def test_los_context_inconsistent_flags_review(self) -> None:
        result = fc_actual_quality.evaluate_fc_actual_quality(
            {
                "patient_name": "Patient One",
                "payor_bucket": "Cash",
                "organization_name": "General Patients",
                "package_name": "",
                "package_amount": None,
                "los_days": 0,
                "icu_days": 0,
                "ward_days": 0,
                "room_category": "",
                "is_daycare_broad": False,
                "has_package": False,
                "services_json": [],
                "fc_actual_total_excluding_fnb_and_returns": 24854.35,
                "fc_actual_bucket_totals_jsonb": {
                    "room_charges": 1510,
                    "professional_fees": 17295,
                    "procedure_ot_charges": 4880,
                    "pharmacy_total": 1169.35,
                },
            }
        )

        self.assertEqual(result["quality_level"], fc_actual_quality.QUALITY_LEVEL_REVIEW)
        self.assertEqual(result["quality_flags_json"]["rules"][0]["code"], "los_context_inconsistent")

    def test_clean_normal_rows_remain_ok(self) -> None:
        result = fc_actual_quality.evaluate_fc_actual_quality(
            {
                "patient_name": "Patient One",
                "payor_bucket": "Cash",
                "organization_name": "General Patients",
                "package_name": "",
                "package_amount": None,
                "los_days": 4,
                "icu_days": 0,
                "ward_days": 4,
                "room_category": "General",
                "is_daycare_broad": False,
                "has_package": False,
                "services_json": [],
                "fc_actual_total_excluding_fnb_and_returns": 50000,
                "fc_actual_bucket_totals_jsonb": {
                    "room_charges": 10000,
                    "investigations": 5000,
                    "procedure_ot_charges": 15000,
                    "bedside_services": 3000,
                    "professional_fees": 7000,
                    "other_services": 2000,
                    "pharmacy_total": 8000,
                },
            }
        )

        self.assertEqual(result["quality_level"], fc_actual_quality.QUALITY_LEVEL_OK)
        self.assertEqual(result["quality_flags_json"]["rules"], [])

    @patch("scripts.etl.common.supabase_db._fetch_target_main_table_fc_quality_rows")
    def test_quality_targeted_update_mode_only_writes_selected_rows(self, fetch_rows_mock) -> None:
        class FakeCursor:
            def __init__(self) -> None:
                self.executemany_calls: list[tuple[str, list[tuple[object, ...]]]] = []

            def executemany(self, sql: str, rows: list[tuple[object, ...]]) -> None:
                self.executemany_calls.append((sql, rows))

        fetch_rows_mock.return_value = [
            {
                "main_table_key": "mt-ip1",
                "hospital_id": 1,
                "admission_no": "IP1",
                "patient_name": "Patient One",
                "organization_name": "General Patients",
                "payor_bucket": "Cash",
                "package_name": "",
                "package_amount": None,
                "has_package": False,
                "is_daycare_broad": False,
                "los_days": 1.25,
                "icu_days": 0,
                "ward_days": 1,
                "room_category": "",
                "services_json": [],
                "fc_actual_bucket_totals_jsonb": {"procedure_ot_charges": 1},
                "fc_actual_total_excluding_fnb_and_returns": 1.0,
            }
        ]

        cursor = FakeCursor()
        summary = supabase_db._populate_main_table_fc_actual_quality_flags(
            cursor,
            admission_nos=["IP1"],
            dry_run=False,
        )

        self.assertEqual(summary["rows_written"], 1)
        self.assertEqual(summary["counts_by_level"][fc_actual_quality.QUALITY_LEVEL_EXCLUDE_ALL_TARGETS], 1)
        self.assertEqual(len(cursor.executemany_calls), 1)
        payload = cursor.executemany_calls[0][1][0][1]
        self.assertIn("tiny_total_placeholder", payload)

    @patch("scripts.etl.common.supabase_db._fetch_target_main_table_normalized_los_rows")
    def test_normalized_los_targeted_update_mode_only_writes_selected_rows(self, fetch_rows_mock) -> None:
        class FakeCursor:
            def __init__(self) -> None:
                self.executemany_calls: list[tuple[str, list[tuple[object, ...]]]] = []

            def executemany(self, sql: str, rows: list[tuple[object, ...]]) -> None:
                self.executemany_calls.append((sql, rows))

        fetch_rows_mock.return_value = [
            {
                "main_table_key": "mt-ip1",
                "hospital_id": 1,
                "admission_no": "IP1",
                "patient_name": "Patient One",
                "date_of_admission": datetime(2025, 3, 21, 9, 0, tzinfo=timezone.utc),
                "date_of_discharge": datetime(2025, 3, 21, 18, 0, tzinfo=timezone.utc),
                "los_days": 0.4,
                "is_daycare_broad": True,
                "icu_days": 0.0,
                "ward_days": 0.0,
                "services_json": [
                    {
                        "service_code": "ROM0010",
                        "service_name": "Bed Charges - Daycare",
                        "service_type": "WARD CHARGES",
                    }
                ],
            }
        ]

        cursor = FakeCursor()
        summary = supabase_db._populate_main_table_normalized_los(
            cursor,
            admission_nos=["IP1"],
            dry_run=False,
        )

        self.assertEqual(summary["rows_written"], 1)
        self.assertEqual(summary["same_day_daycare_style_count"], 1)
        self.assertEqual(len(cursor.executemany_calls), 1)
        self.assertEqual(cursor.executemany_calls[0][1][0][0], 0)
        self.assertEqual(cursor.executemany_calls[0][1][0][3], "mt-ip1")

    @patch("scripts.etl.common.supabase_db._fetch_target_main_table_procedure_duration_rows")
    def test_procedure_duration_targeted_mode_only_writes_selected_rows(self, fetch_rows_mock) -> None:
        class FakeCursor:
            def __init__(self) -> None:
                self.executemany_calls: list[tuple[str, list[tuple[object, ...]]]] = []

            def executemany(self, sql: str, rows: list[tuple[object, ...]]) -> None:
                self.executemany_calls.append((sql, rows))

        fetch_rows_mock.return_value = [
            {
                "main_table_key": "mt-ip1",
                "admission_no": "IP1",
                "patient_name": "Patient One",
                "services_json": [
                    {
                        "service_code": "OT001",
                        "service_name": "OT - 2 HOURS",
                        "service_group_name": "OT CHARGES",
                    },
                    {
                        "service_code": "CAT5036",
                        "service_name": "CATH LAB CHARGES PER HOUR",
                        "service_group_name": "Cath Lab Hours",
                    },
                ],
            }
        ]

        cursor = FakeCursor()
        summary = supabase_db._populate_main_table_procedure_duration_fields(
            cursor,
            admission_nos=["IP1"],
            dry_run=False,
        )

        self.assertEqual(summary["rows_written"], 1)
        self.assertEqual(summary["rows_with_non_null_derived_ot_hours"], 1)
        self.assertEqual(summary["rows_with_non_null_derived_cath_lab_hours"], 1)
        self.assertEqual(len(cursor.executemany_calls), 1)
        self.assertEqual(cursor.executemany_calls[0][1][0][0], 2.0)
        self.assertEqual(cursor.executemany_calls[0][1][0][4], "mt-ip1")

    @patch("scripts.etl.common.supabase_db.enrich_main_table_fc_actual_buckets")
    @patch("scripts.etl.common.supabase_db.enrich_main_table_cleaned_pharmacy_fields")
    @patch("scripts.etl.common.supabase_db.enrich_main_table_cash_drug_admin_fields")
    @patch("scripts.etl.common.supabase_db.enrich_main_table_procedure_duration_fields")
    @patch("scripts.etl.common.supabase_db.enrich_main_table_normalized_los")
    @patch("scripts.etl.common.supabase_db.enrich_main_table_fc_actual_quality_flags")
    @patch("scripts.etl.common.supabase_db.enrich_main_table_emergency_mlc_flags")
    @patch("scripts.etl.common.supabase_db.connect_db")
    def test_refresh_main_table_repopulates_normalized_los_then_quality_flags_after_fc_actual(
        self,
        connect_db_mock,
        enrich_emergency_mlc_mock,
        enrich_quality_mock,
        enrich_normalized_los_mock,
        enrich_procedure_duration_mock,
        enrich_cash_drug_admin_mock,
        enrich_cleaned_pharmacy_mock,
        enrich_fc_actual_mock,
    ) -> None:
        call_order: list[str] = []

        class FakeCursor:
            def execute(self, _sql: str, *_args: object) -> None:
                return None

            def executemany(self, _sql: str, _rows: list[tuple[object, ...]]) -> None:
                return None

            def fetchall(self) -> list[tuple[object, ...]]:
                return []

            def __enter__(self) -> "FakeCursor":
                return self

            def __exit__(self, exc_type, exc, tb) -> bool:
                return False

        class FakeConn:
            def cursor(self) -> FakeCursor:
                return FakeCursor()

            def commit(self) -> None:
                return None

            def __enter__(self) -> "FakeConn":
                return self

            def __exit__(self, exc_type, exc, tb) -> bool:
                return False

        connect_db_mock.return_value = FakeConn()

        def procedure_duration_side_effect(*_args: object, **_kwargs: object) -> dict[str, object]:
            call_order.append("procedure_duration")
            return {}

        def normalized_los_side_effect(*_args: object, **_kwargs: object) -> dict[str, object]:
            call_order.append("normalized_los")
            return {}

        def fc_actual_side_effect(*_args: object, **_kwargs: object) -> dict[str, object]:
            call_order.append("fc_actual")
            return {}

        def cleaned_pharmacy_side_effect(*_args: object, **_kwargs: object) -> dict[str, object]:
            call_order.append("cleaned_pharmacy")
            return {}

        def quality_side_effect(*_args: object, **_kwargs: object) -> dict[str, object]:
            call_order.append("quality")
            return {}

        def cash_drug_admin_side_effect(*_args: object, **_kwargs: object) -> dict[str, object]:
            call_order.append("cash_drug_admin")
            return {}

        def emergency_mlc_side_effect(*_args: object, **_kwargs: object) -> dict[str, object]:
            call_order.append("emergency_mlc")
            return {}

        enrich_procedure_duration_mock.side_effect = procedure_duration_side_effect
        enrich_normalized_los_mock.side_effect = normalized_los_side_effect
        enrich_cleaned_pharmacy_mock.side_effect = cleaned_pharmacy_side_effect
        enrich_fc_actual_mock.side_effect = fc_actual_side_effect
        enrich_quality_mock.side_effect = quality_side_effect
        enrich_cash_drug_admin_mock.side_effect = cash_drug_admin_side_effect
        enrich_emergency_mlc_mock.side_effect = emergency_mlc_side_effect

        with patch("scripts.etl.common.supabase_db._ensure_main_table_daycare_broad_columns"), \
             patch("scripts.etl.common.supabase_db._populate_main_table_daycare_broad"), \
             patch("scripts.etl.common.supabase_db._ensure_main_table_payor_bucket_column"), \
             patch("scripts.etl.common.supabase_db._populate_main_table_payor_bucket"), \
             patch("scripts.etl.common.supabase_db._ensure_main_table_short_stay_column"), \
             patch("scripts.etl.common.supabase_db._populate_main_table_short_stay_column"), \
             patch("scripts.etl.common.supabase_db._ensure_main_table_stay_audit_columns"), \
             patch("scripts.etl.common.supabase_db._populate_main_table_stay_audit_fields"), \
             patch("scripts.etl.common.supabase_db._ensure_main_table_tariff_columns"), \
             patch("scripts.etl.common.supabase_db._populate_main_table_tariff_fields"):
            supabase_db.refresh_main_table()

        self.assertEqual(call_order, ["procedure_duration", "normalized_los", "cleaned_pharmacy", "fc_actual", "quality", "cash_drug_admin", "emergency_mlc"])

    @patch("scripts.etl.common.supabase_db._fetch_target_main_table_rows")
    def test_cleaned_pharmacy_targeted_mode_only_writes_selected_rows(self, fetch_rows_mock) -> None:
        class FakeCursor:
            def __init__(self) -> None:
                self.executemany_calls: list[tuple[str, list[tuple[object, ...]]]] = []

            def executemany(self, sql: str, rows: list[tuple[object, ...]]) -> None:
                self.executemany_calls.append((sql, rows))

        fetch_rows_mock.return_value = [
            {
                "main_table_key": "mt-ip1",
                "admission_no": "IP1",
                "patient_name": "Patient One",
                "pharmacy_json": {
                    "items": [
                        {
                            "item_code": "DRUG01",
                            "normalized_item_desc": "Paracetamol",
                            "quantity": 2,
                            "sale_rate": 50,
                            "amount": 5000,
                            "pharmacy_section": "ip_pharmacy",
                        }
                    ]
                },
            }
        ]

        cursor = FakeCursor()
        summary = supabase_db._populate_main_table_cleaned_pharmacy_fields(
            cursor,
            admission_nos=["IP1"],
            dry_run=False,
        )

        self.assertEqual(summary["rows_written"], 1)
        self.assertEqual(summary["rows_with_non_empty_cleaned_issue_payload"], 1)
        self.assertEqual(summary["gross_issue_amount_total_using_raw_amount"], 5000.0)
        self.assertEqual(summary["gross_issue_amount_total_using_reconstructed_quantity_sale_rate"], 100.0)
        self.assertEqual(len(cursor.executemany_calls), 1)
        self.assertEqual(cursor.executemany_calls[0][1][0][3], "mt-ip1")

    @patch("scripts.etl.common.supabase_db._fetch_target_main_table_cash_drug_admin_rows")
    def test_cash_drug_admin_targeted_mode_only_writes_selected_rows(self, fetch_rows_mock) -> None:
        class FakeCursor:
            def __init__(self) -> None:
                self.executemany_calls: list[tuple[str, list[tuple[object, ...]]]] = []

            def executemany(self, sql: str, rows: list[tuple[object, ...]]) -> None:
                self.executemany_calls.append((sql, rows))

        fetch_rows_mock.return_value = [
            {
                "main_table_key": "mt-ip1",
                "admission_no": "IP1",
                "patient_name": "Patient One",
                "payor_bucket": "Cash",
                "fc_actual_bucket_totals_jsonb": {"pharmacy_total": 240.0},
                "fc_actual_total_excluding_fnb_and_returns": 1200.0,
            }
        ]

        cursor = FakeCursor()
        summary = supabase_db._populate_main_table_cash_drug_admin_fields(
            cursor,
            admission_nos=["IP1"],
            dry_run=False,
        )

        self.assertEqual(summary["rows_written"], 1)
        self.assertEqual(summary["cash_row_count"], 1)
        self.assertEqual(summary["non_zero_drug_admin_count"], 1)
        self.assertEqual(len(cursor.executemany_calls), 1)
        self.assertEqual(cursor.executemany_calls[0][1][0][0], 30.0)
        self.assertEqual(cursor.executemany_calls[0][1][0][1], 1230.0)
        self.assertEqual(cursor.executemany_calls[0][1][0][2], "mt-ip1")

    @patch("scripts.etl.common.supabase_db._fetch_target_main_table_emergency_mlc_rows")
    def test_emergency_mlc_targeted_mode_only_writes_selected_rows(self, fetch_rows_mock) -> None:
        class FakeCursor:
            def __init__(self) -> None:
                self.executemany_calls: list[tuple[str, list[tuple[object, ...]]]] = []

            def executemany(self, sql: str, rows: list[tuple[object, ...]]) -> None:
                self.executemany_calls.append((sql, rows))

        fetch_rows_mock.return_value = [
            {
                "main_table_key": "mt-ip1",
                "admission_no": "IP1",
                "patient_name": "Patient One",
                "services_json": [
                    {
                        "service_code": "D000806",
                        "service_name": "ER PHYSICIAN",
                        "service_group_name": "Consultation",
                    },
                    {
                        "service_code": "HSP0047",
                        "service_name": "MLC CHARGES-IP",
                        "amount": 1200,
                    },
                ],
            }
        ]

        cursor = FakeCursor()
        summary = supabase_db._populate_main_table_emergency_mlc_flags(
            cursor,
            admission_nos=["IP1"],
            dry_run=False,
        )

        self.assertEqual(summary["rows_written"], 1)
        self.assertEqual(summary["has_emergency_origin_count"], 1)
        self.assertEqual(summary["has_mlc_charge_count"], 1)
        self.assertEqual(len(cursor.executemany_calls), 1)
        self.assertEqual(cursor.executemany_calls[0][1][0][0], True)
        self.assertEqual(cursor.executemany_calls[0][1][0][1], True)
        self.assertEqual(cursor.executemany_calls[0][1][0][3], "mt-ip1")

    @patch("scripts.etl.common.supabase_db._validate_fc_actual_stored_values")
    @patch("scripts.etl.common.supabase_db._populate_main_table_fc_actual_buckets")
    @patch("scripts.etl.common.supabase_db._ensure_main_table_fc_actual_columns")
    @patch("scripts.etl.common.supabase_db.connect_db")
    def test_all_run_aborts_on_first_failed_validation_batch(
        self,
        connect_db_mock,
        _ensure_mock,
        populate_mock,
        validate_mock,
    ) -> None:
        class FakeCursor:
            def __init__(self) -> None:
                self._rows = [("IP1",), ("IP2",), ("IP3",), ("IP4",)]

            def execute(self, _sql: str, *_args: object) -> None:
                return None

            def fetchall(self) -> list[tuple[str]]:
                return self._rows

            def __enter__(self) -> "FakeCursor":
                return self

            def __exit__(self, exc_type, exc, tb) -> bool:
                return False

        class FakeConn:
            def cursor(self) -> FakeCursor:
                return FakeCursor()

            def commit(self) -> None:
                return None

            def __enter__(self) -> "FakeConn":
                return self

            def __exit__(self, exc_type, exc, tb) -> bool:
                return False

        connect_db_mock.side_effect = [FakeConn(), FakeConn()]
        populate_mock.return_value = {
            "rows_processed": 2,
            "rows_written": 2,
            "rows_skipped": 0,
            "failed_admissions": [],
            "unmapped_service_row_count": 0,
            "unmapped_pharmacy_row_count": 0,
            "ambiguous_service_row_count": 0,
            "ambiguous_pharmacy_row_count": 0,
            "mean_abs_reconciliation_delta": 0.0,
            "max_abs_reconciliation_delta": 0.0,
        }
        validate_mock.return_value = {
            "validated_row_count": 2,
            "total_vs_bucket_mismatch_count": 1,
            "pharmacy_total_mismatch_count": 0,
            "recomputed_vs_stored_mismatch_count": 1,
            "sample_failing_admissions": [{"admission_no": "IP1"}],
            "failed_validation": True,
        }

        with self.assertRaises(RuntimeError):
            supabase_db.enrich_main_table_fc_actual_buckets(batch_size=2)

    @patch("scripts.etl.common.supabase_db._populate_main_table_cash_drug_admin_fields")
    @patch("scripts.etl.common.supabase_db._ensure_main_table_cash_drug_admin_columns")
    @patch("scripts.etl.common.supabase_db._populate_main_table_fc_actual_quality_flags")
    @patch("scripts.etl.common.supabase_db._ensure_main_table_fc_actual_quality_columns")
    @patch("scripts.etl.common.supabase_db._validate_fc_actual_stored_values")
    @patch("scripts.etl.common.supabase_db._populate_main_table_fc_actual_buckets")
    @patch("scripts.etl.common.supabase_db._ensure_main_table_fc_actual_columns")
    @patch("scripts.etl.common.supabase_db.connect_db")
    def test_all_run_aggregates_inline_and_final_validation(
        self,
        connect_db_mock,
        _ensure_mock,
        populate_mock,
        validate_mock,
        _ensure_quality_mock,
        populate_quality_mock,
        _ensure_cash_mock,
        populate_cash_mock,
    ) -> None:
        class FakeCursor:
            def __init__(self) -> None:
                self._rows = [("IP1",), ("IP2",), ("IP3",), ("IP4",)]

            def execute(self, _sql: str, *_args: object) -> None:
                return None

            def fetchall(self) -> list[tuple[str]]:
                return self._rows

            def __enter__(self) -> "FakeCursor":
                return self

            def __exit__(self, exc_type, exc, tb) -> bool:
                return False

        class FakeConn:
            def cursor(self) -> FakeCursor:
                return FakeCursor()

            def commit(self) -> None:
                return None

            def __enter__(self) -> "FakeConn":
                return self

            def __exit__(self, exc_type, exc, tb) -> bool:
                return False

        connect_db_mock.side_effect = [FakeConn(), FakeConn(), FakeConn(), FakeConn()]
        populate_mock.side_effect = [
            {
                "rows_processed": 2,
                "rows_written": 2,
                "rows_skipped": 0,
                "failed_admissions": [],
                "unmapped_service_row_count": 0,
                "unmapped_pharmacy_row_count": 0,
                "ambiguous_service_row_count": 0,
                "ambiguous_pharmacy_row_count": 0,
                "mean_abs_reconciliation_delta": 0.0,
                "max_abs_reconciliation_delta": 0.0,
            },
            {
                "rows_processed": 2,
                "rows_written": 2,
                "rows_skipped": 0,
                "failed_admissions": [],
                "unmapped_service_row_count": 0,
                "unmapped_pharmacy_row_count": 0,
                "ambiguous_service_row_count": 0,
                "ambiguous_pharmacy_row_count": 0,
                "mean_abs_reconciliation_delta": 0.0,
                "max_abs_reconciliation_delta": 0.0,
            },
        ]
        validate_mock.side_effect = [
            {
                "validated_row_count": 2,
                "total_vs_bucket_mismatch_count": 0,
                "pharmacy_total_mismatch_count": 0,
                "recomputed_vs_stored_mismatch_count": 0,
                "sample_failing_admissions": [],
                "failed_validation": False,
            },
            {
                "validated_row_count": 2,
                "total_vs_bucket_mismatch_count": 0,
                "pharmacy_total_mismatch_count": 0,
                "recomputed_vs_stored_mismatch_count": 0,
                "sample_failing_admissions": [],
                "failed_validation": False,
            },
            {
                "validated_row_count": 4,
                "total_vs_bucket_mismatch_count": 0,
                "pharmacy_total_mismatch_count": 0,
                "recomputed_vs_stored_mismatch_count": 0,
                "sample_failing_admissions": [],
                "failed_validation": False,
            },
        ]
        populate_quality_mock.return_value = {"quality_level_change_count": 0}
        populate_cash_mock.return_value = {"changed_drug_admin_count": 0}

        summary = supabase_db.enrich_main_table_fc_actual_buckets(batch_size=2)

        self.assertEqual(summary["rows_processed"], 4)
        self.assertEqual(summary["inline_validation"]["validated_row_count"], 4)
        self.assertEqual(summary["final_validation"]["validated_row_count"], 4)
        self.assertEqual(summary["inline_validation"]["recomputed_vs_stored_mismatch_count"], 0)


if __name__ == "__main__":
    unittest.main()
