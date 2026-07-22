// C1 (i22, 20-Jul): add 4 neonatal cash packages to the FINANCIAL package
// layer. Codes already exist in fc.surgery_master (clinical) — this ENRICHES
// the financial side (fc.package_master + fc.package_room_rates), it does not
// duplicate the clinical master. Idempotent: re-run safe (delete-then-insert
// of just these 4 TR1 codes). Source doc registered in fc_source_registry
// if that table exists (fail-open).
import 'dotenv/config';
import pg from 'pg';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const PKGS = [
  {
    code: 'PAE5048', name: 'POSTNATAL WELL BABY PACKAGE - 1 DAY', amount: 11000,
    duration: 1, post: 1, room: 'MOTHER_BED', room_label: 'Mother Bed',
    eff: '2026-06-17',
    inclusions: "Mother's Bed - 1 Day; Pharmacy up to Rs.2500; Transcutaneous Bilirubin (TCB) - 1; Professional Fee (Neonatologist/Paediatrician) - Rs.5000; Lactation Consultation - 1; Medical Records - 1 Day",
    exclusions: 'Cross Consultation; Additional Investigations (CT, MRI, PFT, Doppler, etc.); Ventilator Charges; Food & Beverages, Telephone Charges; All medications and investigations other than Procedure; Special Equipment Charges; Diabetic Management; Beyond package days all services & investigations at actual',
    pf: 5000,
  },
  {
    code: 'PAE5049', name: 'POSTNATAL WELL BABY PACKAGE - 2 DAYS', amount: 18000,
    duration: 2, post: 2, room: 'MOTHER_BED', room_label: 'Mother Bed',
    eff: '2026-06-17',
    inclusions: "Mother's Bed - 2 Days; Pharmacy up to Rs.2500; Blood Group & Rh Typing - 1; OAE Hearing Screening - 1; Transcutaneous Bilirubin (TCB) - 1; Professional Fee (Neonatologist/Paediatrician) - Rs.7500; Lactation Consultation - 2; Medical Records - >1 Day",
    exclusions: 'Cross Consultation; Additional Investigations (CT, MRI, PFT, Doppler, etc.); Ventilator Charges; Food & Beverages, Telephone Charges; All medications and investigations other than Procedure; Special Equipment Charges; Diabetic Management; Beyond package days all services & investigations at actual',
    pf: 7500,
  },
  {
    code: 'PAE5055', name: 'PHOTOTHERAPY PACKAGE - PER DAY', amount: 22000,
    duration: 1, post: 1, room: 'WARD', room_label: 'Ward',
    eff: '2026-06-17',
    inclusions: 'Ward Stay - 1 Day; Pharmacy up to Rs.2500; CBP (Complete Blood Picture) - 1; Transcutaneous Bilirubin (TCB) - 1; Reticulocyte Count - 1; Professional Fee (Neonatologist/Paediatrician) - Rs.5000; Medical Records - 1 Day; Ward Consumables - 1; Single Surface Phototherapy - 1',
    exclusions: 'Cross Consultation; Additional Investigations (CT, MRI, PFT, Doppler, etc.); Ventilator Charges; Food & Beverages, Telephone Charges; All medications and investigations other than Procedure; Special Equipment Charges; Diabetic Management; Beyond package days all services & investigations at actual',
    pf: 5000,
  },
  {
    code: 'PAE5061', name: 'PHOTOTHERAPY DOUBLE SURFACE PACKAGE - PER DAY', amount: 23000,
    duration: 1, post: 1, room: 'WARD', room_label: 'Ward',
    eff: '2026-05-18',
    inclusions: 'Ward Stay - 1 Day; Pharmacy up to Rs.2500; CBP (Complete Blood Picture) - 1; Transcutaneous Bilirubin (TCB) - 1; Reticulocyte Count - 1; Professional Fee (Neonatologist/Paediatrician) - Rs.5000; Medical Records - 1 Day; Ward Consumables - 1; Double Surface Phototherapy - 1',
    exclusions: 'Cross Consultation; Additional Investigations (CT, MRI, PFT, Doppler, etc.); HIV/HBsAg/HCV Disposable Kit; Ventilator Charges; Food & Beverages, Telephone Charges; All medications and investigations other than Procedure; Special Equipment Charges; Diabetic Management; Beyond package days all services & investigations at actual',
    pf: 5000,
  },
];

const codes = PKGS.map((p) => p.code);
await c.query('BEGIN');
try {
  // idempotent reload of just these 4 TR1 financial rows
  await c.query(`DELETE FROM fc.package_room_rates              WHERE tariff_code = 'TR1' AND package_code = ANY($1)`, [codes]);
  await c.query(`DELETE FROM fc.package_organization_applicability WHERE tariff_code = 'TR1' AND package_code = ANY($1)`, [codes]);
  await c.query(`DELETE FROM fc.package_master                 WHERE tariff_code = 'TR1' AND package_code = ANY($1)`, [codes]);

  for (const p of PKGS) {
    await c.query(`
      INSERT INTO fc.package_master (
        tariff_code, package_code, package_name, canonical_package_name, normalized_package_name,
        tariff_name, package_type, department_name, package_amount, package_duration, pre_days, post_days,
        is_active, effective_from, payor_bucket, has_tariff, tariff_source,
        has_inclusions, inclusion_source, inclusions_text, has_exclusions, exclusion_source, exclusions_text,
        matched_room_category, can_generate_estimate, runtime_status, fc_runtime_ready, source_pack,
        tariff_information)
      VALUES ($1,$2,$3,$3,upper($3),'KIMS','Neonatal Packages','NEONATOLOGY / PAEDIATRICS',
        $4,$5,0,$6,true,$7,'cash',true,'Neonates Phsio Package Detailed pdf June 26',
        true,'Neonates Phsio Package Detailed pdf June 26',$8,
        true,'Neonates Phsio Package Detailed pdf June 26',$9,
        $10,true,'Strong / Ready',true,'neonatal_pack_jun26',
        $11)`,
      [p.code === undefined ? null : 'TR1', p.code, p.name, p.amount, p.duration, p.post, p.eff,
       p.inclusions, p.exclusions, p.room,
       // tariff_information markdown gives the per-room rescue price + PF note
       `Room Category: ${p.room_label}\nTariff: ${p.amount}\nProfessional Fee (normalized from "Surgeon Charges"): ${p.pf}`]);

    // applicability row — the runtime view INNER-JOINs this (cash, non-org).
    await c.query(`
      INSERT INTO fc.package_organization_applicability
        (organization_cd, organization_name, tariff_code, tariff_name, package_code, package_name, payor_bucket, applicability_source)
      VALUES ('', NULL, 'TR1', 'KIMS', $1, $2, 'cash', 'neonatal_pack_jun26')`,
      [p.code, p.name]);

    // per-room financial rate: the package's own room + a general fallback so
    // the builder can price it at any selected room (flat cash rate).
    await c.query(`
      INSERT INTO fc.package_room_rates (tariff_code, package_code, ordinal, room_category_code, room_category_label, amount, source_field, source_note)
      VALUES ('TR1',$1,1,$2,$3,$4,'neonatal_pack','applicable room per package doc'),
             ('TR1',$1,2,'general','General',$4,'neonatal_pack','flat cash rate — single-room package')`,
      [p.code, p.room.toLowerCase(), p.room_label, p.amount]);
  }

  await c.query('COMMIT');
  console.log('committed 4 neonatal packages to fc.package_master + fc.package_room_rates');
} catch (e) {
  await c.query('ROLLBACK');
  console.error('rolled back:', e.message);
  process.exit(1);
}

// register the source doc AFTER commit (own txn) — a missing registry table
// here must never abort the package insert above.
await c.query(`
  INSERT INTO fc.fc_source_registry (source_name, source_type, note)
  VALUES ('Neonates Phsio Package Detailed pdf June 26', 'package_document',
          'C1/i22: 4 neonatal cash packages PAE5048/5049/5055/5061 into TR1 financial layer')
  ON CONFLICT DO NOTHING`).then(() => console.log('source registered')).catch(() => console.log('source_registry absent — skipped (non-fatal)'));

// verify
const v = await c.query(`
  SELECT package_code, package_name, package_amount, package_duration, matched_room_category, can_generate_estimate,
    (SELECT count(*) FROM fc.package_room_rates r WHERE r.package_code = m.package_code AND r.tariff_code='TR1') AS room_rows
  FROM fc.package_master m WHERE tariff_code='TR1' AND package_code = ANY($1) ORDER BY package_code`, [codes]);
for (const r of v.rows) console.log(` ${r.package_code} ₹${r.package_amount} dur=${r.package_duration} room=${r.matched_room_category} rooms=${r.room_rows} ready=${r.can_generate_estimate}`);
await c.end();
