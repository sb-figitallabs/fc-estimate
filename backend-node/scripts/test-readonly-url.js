// Connectivity check for the shareable read-only URL (no cert file needed).
import pg from 'pg';

// node-pg aliases sslmode=require to verify-full; psql/DBeaver treat it as
// encrypt-only. uselibpqcompat gives the same semantics the manager's client will use.
const url = 'postgresql://fc_readonly:PATqg4GVgIPuMtOpIQB0@fc-estimate-db.cv02w0mscr9b.ap-south-1.rds.amazonaws.com:5432/fc_handoff?uselibpqcompat=true&sslmode=require';
const c = new pg.Client({ connectionString: url });
await c.connect();
const r = await c.query(`SELECT current_user, count(*)::int AS tables FROM information_schema.tables WHERE table_schema IN ('fc','mart','public')`);
console.log('connected as:', r.rows[0].current_user, '| visible tables:', r.rows[0].tables);
const s = await c.query(`SELECT count(*)::int AS n FROM mart.main_table`);
console.log('mart.main_table rows:', s.rows[0].n);
await c.end();
