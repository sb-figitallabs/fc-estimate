/**
 * Clinical-family cohort definitions over mart.main_table.
 * The exact robotic TKR cohort filter is being confirmed against
 * export_robotic_tkr_fc_estimate_builder.py (see spec/BUILD_SPEC.md).
 */
const FAMILIES = {
  robotic_tkr_unilateral_right: {
    family: 'robotic_tkr_unilateral_right',
    familyKind: 'surgical',
    // provisional filter — confirmed/replaced by spec extraction
    whereSql: `surgical_medical = 'Surgical' AND is_daycare_broad = false
               AND package_name ILIKE '%TKR%'`,
    params: [],
  },
};

export async function getCohort(procedure) {
  const def = FAMILIES[procedure];
  if (!def) {
    const err = new Error(`Unknown procedure family: ${procedure}`);
    err.status = 400;
    throw err;
  }
  return def;
}
