const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { getDb, saveDb } = require('./db');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── GET /agent/onboarding ──
router.get('/onboarding', async (req, res) => {
  try {
    const db = await getDb();
    const r = db.exec('SELECT * FROM onboarding WHERE user_id = ?', [req.user.id]);
    if (!r.length || !r[0].values.length) return res.json(null);
    const cols = r[0].columns;
    res.json(Object.fromEntries(cols.map((c, i) => [c, r[0].values[0][i]])));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /agent/onboarding ──
router.post('/onboarding', async (req, res) => {
  try {
    const db = await getDb();
    const { company_name, product_desc, target_market, competitors, goals, stack, github_repo } = req.body;
    db.run(`INSERT INTO onboarding (user_id,company_name,product_desc,target_market,competitors,goals,stack,github_repo,updated_at)
      VALUES (?,?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET
        company_name=excluded.company_name, product_desc=excluded.product_desc,
        target_market=excluded.target_market, competitors=excluded.competitors,
        goals=excluded.goals, stack=excluded.stack, github_repo=excluded.github_repo,
        updated_at=excluded.updated_at`,
      [req.user.id, company_name, product_desc, target_market, competitors, goals, stack, github_repo]);
    saveDb();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /agent/strategy/run ──
// Triggers real AI strategy analysis
router.post('/strategy/run', async (req, res) => {
  const db = await getDb();

  // Check API key
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set in Render environment variables' });
  }

  // Load onboarding
  const ob = db.exec('SELECT * FROM onboarding WHERE user_id = ?', [req.user.id]);
  if (!ob.length || !ob[0].values.length) {
    return res.status(400).json({ error: 'Complete onboarding first' });
  }
  const cols = ob[0].columns;
  const onboarding = Object.fromEntries(cols.map((c, i) => [c, ob[0].values[0][i]]));

  // Create run record
  db.run(`INSERT INTO agent_runs (user_id,agent,status,started_at) VALUES (?,?,?,datetime('now'))`,
    [req.user.id, 'strategy', 'running']);
  const runId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];

  // Update agent status
  db.run(`UPDATE agents SET status='running', current_task='Analyzing market and generating roadmap...' WHERE type='strategy'`);
  db.run(`INSERT INTO activity (agent,message,type,created_at) VALUES ('Strategy','Starting market analysis for ${onboarding.company_name}','info',datetime('now'))`);
  saveDb();

  // Respond immediately — analysis runs async
  res.json({ ok: true, run_id: runId });

  // ── RUN AI ANALYSIS ASYNC ──
  runStrategyAgent(db, req.user.id, runId, onboarding).catch(console.error);
});

async function runStrategyAgent(db, userId, runId, onboarding) {
  try {
    const prompt = `You are an expert startup strategist and product advisor. Analyze the following company and produce a detailed, actionable roadmap.

COMPANY INFORMATION:
- Company: ${onboarding.company_name}
- Product: ${onboarding.product_desc}
- Target Market: ${onboarding.target_market}
- Competitors: ${onboarding.competitors}
- Primary Goals: ${onboarding.goals}
- Tech Stack: ${onboarding.stack}
- GitHub Repo: ${onboarding.github_repo || 'Not provided'}

Your task:
1. Analyze the competitive landscape
2. Identify the 6 highest-impact product/growth priorities for the next 2 quarters
3. For each priority, explain WHY it matters strategically

Respond ONLY with a JSON array of exactly 6 items. No preamble, no explanation, just the JSON array:
[
  {
    "title": "Short action-oriented title (max 8 words)",
    "description": "What to build/do and why it matters (2-3 sentences)",
    "priority": 1,
    "quarter": "Q3 2026",
    "reasoning": "Strategic reasoning based on their competitive position (1-2 sentences)"
  }
]

Priority 1 = highest impact. Quarter = Q3 2026 or Q4 2026. Be specific to their actual product and market.`;

    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = message.content[0].text.trim();

    // Parse JSON — strip any markdown fences if present
    const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const items = JSON.parse(clean);

    // Clear old roadmap for this user
    db.run('DELETE FROM roadmap WHERE user_id = ?', [userId]);

    // Insert new roadmap items
    items.forEach(item => {
      db.run(`INSERT INTO roadmap (user_id,title,description,priority,quarter,status,agent_reasoning,created_at)
        VALUES (?,?,?,?,?,'planned',?,datetime('now'))`,
        [userId, item.title, item.description, item.priority, item.quarter, item.reasoning]);
    });

    // Update tasks with top 3 items
    items.slice(0, 3).forEach(item => {
      db.run(`INSERT INTO tasks (title,agent_type,status,eta,created_at)
        VALUES (?,?,?,?,datetime('now'))`,
        [item.title, 'strategy', 'in_progress', `Q: ${item.quarter}`]);
    });

    // Update KPI tasks count
    db.run(`UPDATE kpis SET tasks_completed = tasks_completed + 1 WHERE id = (SELECT MAX(id) FROM kpis)`);

    // Log completion
    db.run(`INSERT INTO activity (agent,message,type,created_at)
      VALUES ('Strategy','Roadmap generated: ${items.length} priorities identified for ${onboarding.company_name}','success',datetime('now'))`);

    // Mark run complete
    db.run(`UPDATE agent_runs SET status='complete', result=?, completed_at=datetime('now') WHERE id=?`,
      [JSON.stringify({ items_generated: items.length }), runId]);

    // Reset agent status
    db.run(`UPDATE agents SET status='idle', current_task='Roadmap complete — ready for next run' WHERE type='strategy'`);

    saveDb();
  } catch (err) {
    db.run(`UPDATE agent_runs SET status='error', result=?, completed_at=datetime('now') WHERE id=?`,
      [JSON.stringify({ error: err.message }), runId]);
    db.run(`UPDATE agents SET status='idle', current_task='Last run failed — check logs' WHERE type='strategy'`);
    db.run(`INSERT INTO activity (agent,message,type,created_at)
      VALUES ('Strategy','Strategy run failed: ${err.message}','error',datetime('now'))`);
    saveDb();
  }
}

// ── GET /agent/roadmap ──
router.get('/roadmap', async (req, res) => {
  try {
    const db = await getDb();
    const r = db.exec('SELECT * FROM roadmap WHERE user_id = ? ORDER BY priority ASC', [req.user.id]);
    if (!r.length) return res.json([]);
    const { columns, values } = r[0];
    res.json(values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]]))));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /agent/runs ──
router.get('/runs', async (req, res) => {
  try {
    const db = await getDb();
    const r = db.exec('SELECT * FROM agent_runs WHERE user_id = ? ORDER BY started_at DESC LIMIT 10', [req.user.id]);
    if (!r.length) return res.json([]);
    const { columns, values } = r[0];
    res.json(values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]]))));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
