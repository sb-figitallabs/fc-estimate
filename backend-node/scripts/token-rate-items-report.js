// 15-Jul Q2: the manager wants the exact line items priced at ₹0/₹1 token
// rates on insurer tariffs, before deciding cash-fallback vs keep — "one
// rupee is used for line items that should not be billed in insurance".
// For each token-rated item: its TR1 (cash) rate and, as evidence, how often
// the item name appears on ACTUAL insurer bill lines with a real amount.
import 'dotenv/config';
import pg from 'pg';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const { rows } = await c.query(`
  WITH token AS (
    SELECT tariff_cd, service_cd, service_name,
           max(charge::float) AS max_charge
    FROM fc.service_tariff_rate_matrix
    WHERE tariff_cd <> 'TR1'
    GROUP BY 1, 2, 3
    HAVING max(charge::float) <= 1
  ),
  tr1 AS (
    SELECT service_cd, max(charge::float) AS tr1_charge
    FROM fc.service_tariff_rate_matrix WHERE tariff_cd = 'TR1'
    GROUP BY 1
  ),
  billed AS (
    SELECT upper(btrim(l.service_name)) AS sname,
           count(*)::int bill_lines,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY l.billed_amount)::numeric) billed_p50
    FROM fc.package_bill_lines l
    JOIN fc.package_bill_admissions a ON a.ip_no = l.ip_no
    WHERE a.payer_type = 'INSURANCE' AND l.billed_amount > 0
    GROUP BY 1
  )
  SELECT t.tariff_cd, t.service_cd, t.service_name, t.max_charge AS token_rate,
         r.tr1_charge, b.bill_lines AS billed_on_insurance, b.billed_p50
  FROM token t
  LEFT JOIN tr1 r ON r.service_cd = t.service_cd
  LEFT JOIN billed b ON b.sname = upper(btrim(t.service_name))
  ORDER BY coalesce(b.bill_lines, 0) DESC, r.tr1_charge DESC NULLS LAST
  LIMIT 120`);

console.log('===== TOKEN-RATE ITEMS ON INSURER TARIFFS =====');
console.log('tariff | code | item | token | TR1 cash rate | billed on insurance bills (lines, P50)');
for (const r of rows) {
  console.log([
    r.tariff_cd,
    r.service_cd,
    String(r.service_name).slice(0, 48),
    `₹${r.token_rate}`,
    r.tr1_charge != null ? `₹${Math.round(r.tr1_charge)}` : '(no TR1 rate)',
    r.billed_on_insurance ? `${r.billed_on_insurance} lines, P50 ₹${r.billed_p50}` : 'never billed',
  ].join(' | '));
}
const billedCount = rows.filter((r) => r.billed_on_insurance > 0).length;
console.log(`\n${rows.length} token-rated items shown (top by billed evidence); ${billedCount} of them DO appear on actual insurer bills with real amounts — those are missing rates, not not-billable items.`);
await c.end();
