// A1 prerequisite: package_duration sanity for the families under discussion.
import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const { rows } = await c.query(`
  SELECT package_code, package_name, package_duration, pre_days, post_days
  FROM fc.package_master
  WHERE package_code IN ('ORT5511','ORT5510','ORT5531','ORT5535','ORT5536','SGA5166','GYN5218','GYN5219','CAR0122','CAT0469')
     OR package_name ILIKE '%KNEE REPLACEMENT%' OR package_name ILIKE '%ROBOTIC TKR%'
  ORDER BY package_code LIMIT 25`);
for (const r of rows) console.log(`${r.package_code} dur=${r.package_duration} pre=${r.pre_days} post=${r.post_days}  ${r.package_name?.slice(0, 48)}`);
const nulls = await c.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE package_duration IS NULL)::int AS no_dur FROM fc.package_master`);
console.log('catalog:', JSON.stringify(nulls.rows[0]));
await c.end();
