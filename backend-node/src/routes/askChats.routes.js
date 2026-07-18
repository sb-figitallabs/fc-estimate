import { Router } from 'express';
import { pool } from '../db/pool.js';

/**
 * Ask-the-Project conversation storage (18-Jul): past chats persist server-side
 * so the team sees them from any browser — like any AI chat platform.
 * NOTE: the engine API carries no auth, so conversations are shared across
 * everyone with access to this host (single-team tool by design).
 */
const router = Router();

let ensured = false;
async function ensureTable() {
  if (ensured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fc.ask_conversations (
      id          BIGSERIAL PRIMARY KEY,
      title       TEXT NOT NULL DEFAULT 'New chat',
      messages    JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  ensured = true;
}

router.get('/', async (_req, res, next) => {
  try {
    await ensureTable();
    const { rows } = await pool.query(
      `SELECT id, title, updated_at, jsonb_array_length(messages) AS message_count
       FROM fc.ask_conversations ORDER BY updated_at DESC LIMIT 100`);
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    await ensureTable();
    const { rows } = await pool.query(
      'SELECT id, title, messages, created_at, updated_at FROM fc.ask_conversations WHERE id = $1',
      [Number(req.params.id)]);
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    await ensureTable();
    const title = String(req.body?.title || 'New chat').slice(0, 120);
    const { rows } = await pool.query(
      'INSERT INTO fc.ask_conversations (title) VALUES ($1) RETURNING id, title, updated_at',
      [title]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.put('/:id', async (req, res, next) => {
  try {
    await ensureTable();
    const messages = Array.isArray(req.body?.messages) ? req.body.messages.slice(0, 200) : [];
    const title = String(req.body?.title || 'New chat').slice(0, 120);
    const { rowCount } = await pool.query(
      'UPDATE fc.ask_conversations SET title = $2, messages = $3::jsonb, updated_at = now() WHERE id = $1',
      [Number(req.params.id), title, JSON.stringify(messages)]);
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await ensureTable();
    await pool.query('DELETE FROM fc.ask_conversations WHERE id = $1', [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
