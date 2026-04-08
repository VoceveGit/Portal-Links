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
    await client.query(`ALTER TABLE links ADD COLUMN IF NOT EXISTS thumbnail TEXT`);
  } finally {
    client.release();
  }
}

app.use(express.json({ limit: '8mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/companies', async (_req, res) => {
  try {
    const { rows: companies } = await pool.query(
      `SELECT id, name, color, created_at FROM companies ORDER BY created_at ASC`
    );
    const { rows: links } = await pool.query(
      `SELECT id, company_id, label, url, description, icon, thumbnail, sort_order
       FROM links ORDER BY sort_order ASC, created_at ASC`
    );
    const byCompany = new Map();
    companies.forEach((c) => {
      byCompany.set(c.id, { ...c, links: [] });
    });
    links.forEach((l) => {
      const row = byCompany.get(l.company_id);
      if (row) {
        row.links.push({
          id: l.id,
          label: l.label,
          url: l.url,
          desc: l.description || '',
          icon: l.icon || '🖥️',
          thumbnail: l.thumbnail || null,
        });
      }
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

app.put('/api/companies/:id', requireApiKey, async (req, res) => {
  try {
    const id = req.params.id;
    const name = String(req.body?.name ?? '').trim().slice(0, 200);
    const color = String(req.body?.color ?? '').trim().slice(0, 500);
    if (!name) return res.status(400).json({ error: 'Nome obrigatório.' });
    if (!color) return res.status(400).json({ error: 'Cor obrigatória.' });
    const r = await pool.query(
      `UPDATE companies SET name = $1, color = $2 WHERE id = $3 RETURNING id, name, color, created_at`,
      [name, color, id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Empresa não encontrada.' });
    res.json({ ...r.rows[0], links: [] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao atualizar empresa.' });
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
    let thumbnail = null;
    if (req.body?.thumbnail != null && req.body.thumbnail !== '') {
      const t = String(req.body.thumbnail);
      if (!t.startsWith('data:image/')) return res.status(400).json({ error: 'Miniatura inválida.' });
      if (t.length > 6_000_000) return res.status(400).json({ error: 'Imagem muito grande.' });
      thumbnail = t;
    }
    if (!label) return res.status(400).json({ error: 'Nome do link obrigatório.' });
    if (!url) return res.status(400).json({ error: 'URL obrigatória.' });
    if (!url.startsWith('http://') && !url.startsWith('https://')) url = `https://${url}`;

    const check = await pool.query(`SELECT 1 FROM companies WHERE id = $1`, [companyId]);
    if (check.rowCount === 0) return res.status(404).json({ error: 'Empresa não encontrada.' });

    const { rows } = await pool.query(
      `INSERT INTO links (company_id, label, url, description, icon, thumbnail)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, label, url, description, icon, thumbnail`,
      [companyId, label, url, desc, icon, thumbnail]
    );
    const link = rows[0];
    res.status(201).json({
      ...link,
      desc: link.description || '',
      thumbnail: link.thumbnail || null,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao criar link.' });
  }
});

app.put('/api/links/:id', requireApiKey, async (req, res) => {
  try {
    const id = req.params.id;
    const { rows: existing } = await pool.query(`SELECT * FROM links WHERE id = $1`, [id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Link não encontrado.' });
    const cur = existing[0];
    const label =
      req.body.label !== undefined ? String(req.body.label).trim().slice(0, 300) : cur.label;
    let url = req.body.url !== undefined ? String(req.body.url).trim() : cur.url;
    const desc =
      req.body.desc !== undefined ? String(req.body.desc ?? '').trim().slice(0, 2000) : (cur.description || '');
    const icon =
      req.body.icon !== undefined ? String(req.body.icon || '🖥️').trim().slice(0, 32) : cur.icon;
    let thumbnail = cur.thumbnail;
    if (req.body.thumbnail !== undefined) {
      if (req.body.thumbnail === null || req.body.thumbnail === '') thumbnail = null;
      else {
        const t = String(req.body.thumbnail);
        if (!t.startsWith('data:image/')) return res.status(400).json({ error: 'Miniatura inválida.' });
        if (t.length > 6_000_000) return res.status(400).json({ error: 'Imagem muito grande.' });
        thumbnail = t;
      }
    }
    if (!label) return res.status(400).json({ error: 'Nome obrigatório.' });
    if (!url) return res.status(400).json({ error: 'URL obrigatória.' });
    if (!url.startsWith('http://') && !url.startsWith('https://')) url = `https://${url}`;
    await pool.query(
      `UPDATE links SET label = $1, url = $2, description = $3, icon = $4, thumbnail = $5 WHERE id = $6`,
      [label, url, desc, icon, thumbnail, id]
    );
    const { rows } = await pool.query(
      `SELECT id, label, url, description, icon, thumbnail FROM links WHERE id = $1`,
      [id]
    );
    const link = rows[0];
    res.json({
      id: link.id,
      label: link.label,
      url: link.url,
      desc: link.description || '',
      icon: link.icon || '🖥️',
      thumbnail: link.thumbnail || null,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao atualizar link.' });
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
