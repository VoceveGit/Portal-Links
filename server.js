const path = require('path');
const express = require('express');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

function requireApiKey(req, res, next) {
  const expected = process.env.PORTAL_API_KEY;
  if (!expected) return next();
  const sent = req.headers['x-portal-key'];
  if (sent !== expected) {
    return res.status(401).json({ error: 'Chave da API inválida ou ausente.' });
  }
  return next();
}

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS companies (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(200) NOT NULL,
        color TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS links (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        label VARCHAR(300) NOT NULL,
        url TEXT NOT NULL,
        description TEXT,
        icon VARCHAR(32),
        sort_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  } finally {
    client.release();
  }
}

app.use(express.json({ limit: '512kb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/companies', async (_req, res) => {
  try {
    const { rows: companies } = await pool.query(
      `SELECT id, name, color, created_at FROM companies ORDER BY created_at ASC`
    );
    const { rows: links } = await pool.query(
      `SELECT id, company_id, label, url, description, icon, sort_order
       FROM links ORDER BY sort_order ASC, created_at ASC`
    );
    const byCompany = new Map();
    companies.forEach((c) => {
      byCompany.set(c.id, { ...c, links: [] });
    });
    links.forEach((l) => {
      const row = byCompany.get(l.company_id);
      if (row) row.links.push({ id: l.id, label: l.label, url: l.url, desc: l.description || '', icon: l.icon || '🖥️' });
    });
    res.json({ companies: Array.from(byCompany.values()) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao carregar dados.' });
  }
});

app.post('/api/companies', requireApiKey, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 200);
    const color = String(req.body?.color || '').trim().slice(0, 500);
    if (!name) return res.status(400).json({ error: 'Nome obrigatório.' });
    if (!color) return res.status(400).json({ error: 'Cor obrigatória.' });
    const { rows } = await pool.query(
      `INSERT INTO companies (name, color) VALUES ($1, $2) RETURNING id, name, color, created_at`,
      [name, color]
    );
    const c = rows[0];
    res.status(201).json({ ...c, links: [] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao criar empresa.' });
  }
});

app.delete('/api/companies/:id', requireApiKey, async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM companies WHERE id = $1`, [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Empresa não encontrada.' });
    res.status(204).end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao excluir empresa.' });
  }
});

app.post('/api/companies/:companyId/links', requireApiKey, async (req, res) => {
  try {
    const companyId = req.params.companyId;
    const label = String(req.body?.label || '').trim().slice(0, 300);
    let url = String(req.body?.url || '').trim();
    const desc = String(req.body?.desc ?? '').trim().slice(0, 2000);
    const icon = String(req.body?.icon || '🖥️').trim().slice(0, 32);
    if (!label) return res.status(400).json({ error: 'Nome do link obrigatório.' });
    if (!url) return res.status(400).json({ error: 'URL obrigatória.' });
    if (!url.startsWith('http://') && !url.startsWith('https://')) url = `https://${url}`;

    const check = await pool.query(`SELECT 1 FROM companies WHERE id = $1`, [companyId]);
    if (check.rowCount === 0) return res.status(404).json({ error: 'Empresa não encontrada.' });

    const { rows } = await pool.query(
      `INSERT INTO links (company_id, label, url, description, icon)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, label, url, description, icon`,
      [companyId, label, url, desc, icon]
    );
    const link = rows[0];
    res.status(201).json({ ...link, desc: link.description || '' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao criar link.' });
  }
});

app.delete('/api/links/:id', requireApiKey, async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM links WHERE id = $1`, [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Link não encontrado.' });
    res.status(204).end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao excluir link.' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

async function start() {
  if (!process.env.DATABASE_URL) {
    console.error('Defina DATABASE_URL (PostgreSQL).');
    process.exit(1);
  }
  await migrate();
  app.listen(PORT, () => {
    console.log(`Portal rodando na porta ${PORT}`);
  });
}

start().catch((e) => {
  console.error(e);
  process.exit(1);
});
