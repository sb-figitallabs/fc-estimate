import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const raw = await c.query(`
  SELECT tariff_cd, service_cd, ward_group_name, charge
  FROM fc.service_tariff_rate_matrix
  WHERE service_cd = 'URO5443' AND tariff_cd = 'TR1' LIMIT 20`);
console.log('raw rows:', raw.rows.length);
for (const r of raw.rows) console.log(` [${r.ward_group_name}] charge=${JSON.stringify(r.charge)}`);
const agg = await c.query(`
  SELECT service_cd, ward_group_name, max(charge::float) AS charge
  FROM fc.service_tariff_rate_matrix
  WHERE tariff_cd = $1 AND service_cd = ANY($2)
    AND upper(ward_group_name) IN ('GENERAL','TWIN','SINGLE')
  GROUP BY service_cd, ward_group_name`, ['TR1', ['URO5443']]);
console.log('agg:', JSON.stringify(agg.rows));
await c.end();
