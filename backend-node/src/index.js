import 'dotenv/config';
import express from 'express';
import { pool } from './db/pool.js';
import estimateRoutes from './routes/estimate.routes.js';
import lookupRoutes from './routes/lookup.routes.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT 1 AS ok');
    res.json({ ok: rows[0].ok === 1, db: 'fc_handoff' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.use('/api/lookup', lookupRoutes);
app.use('/api/estimate', estimateRoutes);

// central error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message, details: err.details });
});

const port = process.env.PORT || 4100;
app.listen(port, () => console.log(`fc-builder-api listening on :${port}`));
