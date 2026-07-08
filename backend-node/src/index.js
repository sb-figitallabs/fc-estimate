import 'dotenv/config';
import fs from 'node:fs';
import express from 'express';
import { ZodError } from 'zod';
import swaggerUi from 'swagger-ui-express';
import { pool } from './db/pool.js';
import estimateRoutes from './routes/estimate.routes.js';
import lookupRoutes from './routes/lookup.routes.js';
import packagesRoutes from './routes/packages.routes.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

// API docs: Swagger UI at /docs, raw spec at /openapi.json
const openapi = JSON.parse(fs.readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
app.get('/openapi.json', (_req, res) => res.json(openapi));
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: 'FC Estimate Builder API' }));

// Sample frontend (public/index.html) at /
app.use(express.static(new URL('../public', import.meta.url).pathname));

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
app.use('/api/packages', packagesRoutes);

// central error handler — client input errors are 400, everything else 500
app.use((err, _req, res, _next) => {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Invalid input',
      details: err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    });
  }
  console.error(err);
  res.status(err.status || 500).json({ error: err.message, details: err.details });
});

const port = process.env.PORT || 4100;
app.listen(port, () => console.log(`fc-builder-api listening on :${port}`));
