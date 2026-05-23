const express = require('express');
const router = express.Router();
const { getDb, saveDb } = require('./db');

// ── GET /api/kpis ──
router.get('/kpis', async (req, res) => {
  try {
    const db = await getDb();
    const result = db.exec(`SELECT * FROM kpis ORDER BY recorded_at DESC LIMIT 1`);
    if (!result.length) return res.json({});
    const [cols, vals] = [result[0].columns, result[0].values[0]];
    const row = Object.fromEntries(cols.map((c, i) => [c, vals[i]]));
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/agents ──
router.get('/agents', async (req, res) => {
  try {
    const db = await getDb();
    const result = db.exec(`SELECT * FROM agents ORDER BY id`);
    if (!result.length) return res.json([]);
    const { columns, values } = result[0];
    res.json(values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]]))));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/agents/:id ──
router.patch('/agents/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { status, current_task, efficiency } = req.body;
    const fields = [];
    const vals = [];
    if (status !== undefined) { fields.push('status = ?'); vals.push(status); }
    if (current_task !== undefined) { fields.push('current_task = ?'); vals.push(current_task); }
    if (efficiency !== undefined) { fields.push('efficiency = ?'); vals.push(efficiency); }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    db.run(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`, vals);
    saveDb();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/tasks ──
router.get('/tasks', async (req, res) => {
  try {
    const db = await getDb();
    const result = db.exec(`SELECT * FROM tasks ORDER BY created_at DESC`);
    if (!result.length) return res.json([]);
    const { columns, values } = result[0];
    res.json(values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]]))));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/tasks ──
router.post('/tasks', async (req, res) => {
  try {
    const db = await getDb();
    const { title, agent_type, status = 'in_progress', eta } = req.body;
    if (!title || !agent_type) return res.status(400).json({ error: 'title and agent_type required' });
    db.run(`INSERT INTO tasks (title, agent_type, status, eta, created_at) VALUES (?, ?, ?, ?, datetime('now'))`,
      [title, agent_type, status, eta || null]);
    saveDb();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/tasks/:id ──
router.patch('/tasks/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { status } = req.body;
    const completedAt = status === 'done' ? `datetime('now')` : 'NULL';
    db.run(`UPDATE tasks SET status = ?, completed_at = ${completedAt} WHERE id = ?`,
      [status, req.params.id]);
    // Log activity
    const r = db.exec(`SELECT title, agent_type FROM tasks WHERE id = ?`, [req.params.id]);
    if (r.length) {
      const [title, agent_type] = r[0].values[0];
      const agentName = agent_type.charAt(0).toUpperCase() + agent_type.slice(1);
      db.run(`INSERT INTO activity (agent, message, type, created_at) VALUES (?, ?, 'success', datetime('now'))`,
        [agentName, `Task marked ${status}: "${title}"`]);
    }
    saveDb();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/activity ──
router.get('/activity', async (req, res) => {
  try {
    const db = await getDb();
    const result = db.exec(`SELECT * FROM activity ORDER BY created_at DESC LIMIT 20`);
    if (!result.length) return res.json([]);
    const { columns, values } = result[0];
    res.json(values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]]))));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/activity ──
router.post('/activity', async (req, res) => {
  try {
    const db = await getDb();
    const { agent, message, type = 'info' } = req.body;
    if (!agent || !message) return res.status(400).json({ error: 'agent and message required' });
    db.run(`INSERT INTO activity (agent, message, type, created_at) VALUES (?, ?, ?, datetime('now'))`,
      [agent, message, type]);
    saveDb();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/revenue ──
router.get('/revenue', async (req, res) => {
  try {
    const db = await getDb();
    const result = db.exec(`SELECT date, amount FROM revenue ORDER BY date ASC LIMIT 30`);
    if (!result.length) return res.json([]);
    const { columns, values } = result[0];
    res.json(values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]]))));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/revenue ── (add today's MRR)
router.post('/revenue', async (req, res) => {
  try {
    const db = await getDb();
    const { amount } = req.body;
    if (!amount) return res.status(400).json({ error: 'amount required' });
    db.run(`INSERT OR REPLACE INTO revenue (date, amount) VALUES (date('now'), ?)`, [amount]);
    // Also update KPI
    db.run(`UPDATE kpis SET mrr = ?, recorded_at = datetime('now') WHERE id = (SELECT MAX(id) FROM kpis)`, [amount]);
    saveDb();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
