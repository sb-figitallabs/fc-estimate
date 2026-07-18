// A2 probe: are package codes priced per room in fc.service_tariff_rate_matrix?
import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const { rows } = await c.query(`
  SELECT tariff_cd, service_cd, service_name, ward_group_name, charge::float
  FROM fc.service_tariff_rate_matrix
  WHERE service_cd IN ('ORT5510','ORT5511','SGA5166','GYN5218','CAR0122')
    AND tariff_cd IN ('TR1','TR287','TR290')
  ORDER BY service_cd, tariff_cd, ward_group_name LIMIT 40`);
for (const r of rows) console.log(`${r.tariff_cd} ${r.service_cd} [${r.ward_group_name}] ₹${r.charge}  ${r.service_name?.slice(0, 40)}`);
const agg = await c.query(`
  SELECT count(DISTINCT m.service_cd)::int AS pkg_codes_in_matrix
  FROM fc.service_tariff_rate_matrix m
  JOIN (SELECT DISTINCT package_code FROM fc.package_master) p ON p.package_code = m.service_cd`);
console.log('distinct package codes present in the rate matrix:', agg.rows[0].pkg_codes_in_matrix);
await c.end();
