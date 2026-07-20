// One-shot: read-only DB role for external review access (manager, 18-Jul).
// SELECT-only on all current and future tables in every app schema; no
// write, no DDL. Rotate by re-running with a new password.
import 'dotenv/config';
import pg from 'pg';

const USER = 'fc_readonly';
const PASS = 'PATqg4GVgIPuMtOpIQB0';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const { rows: schemas } = await c.query(
  `SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND nspname NOT LIKE 'pg_temp%' AND nspname NOT LIKE 'pg_toast%'`
);
const { rows: existing } = await c.query(`SELECT 1 FROM pg_roles WHERE rolname = '${USER}'`);
if (existing.length) {
  await c.query(`ALTER ROLE ${USER} WITH LOGIN PASSWORD '${PASS}'`);
  console.log('role existed — password reset');
} else {
  await c.query(`CREATE ROLE ${USER} WITH LOGIN PASSWORD '${PASS}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 10`);
  console.log('role created');
}
await c.query(`GRANT CONNECT ON DATABASE fc_handoff TO ${USER}`);
for (const { nspname } of schemas) {
  await c.query(`GRANT USAGE ON SCHEMA "${nspname}" TO ${USER}`);
  await c.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${nspname}" TO ${USER}`);
  await c.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA "${nspname}" GRANT SELECT ON TABLES TO ${USER}`);
  console.log('granted read on schema', nspname);
}
// prove it: reconnect as the readonly user and run a select + a blocked write
const host = new URL(process.env.DATABASE_URL).host;
const ro = new pg.Client({ connectionString: `postgresql://${USER}:${encodeURIComponent(PASS)}@${host}/fc_handoff?sslmode=no-verify` });
await ro.connect();
const t = await ro.query(`SELECT table_schema || '.' || table_name AS t FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') LIMIT 1`);
const probe = t.rows[0].t;
const n = await ro.query(`SELECT count(*)::int AS n FROM ${probe}`);
console.log(`readonly SELECT ok — ${probe} rows:`, n.rows[0].n);
try {
  await ro.query(`CREATE TABLE _readonly_probe(x int)`);
  console.log('WARNING: readonly user could create a table!');
} catch (e) {
  console.log('write correctly denied:', e.message.slice(0, 60));
}
await ro.end();
await c.end();
