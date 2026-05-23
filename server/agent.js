const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const fetch = require('node-fetch');
const { getDb, saveDb } = require('./db');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// GET /agent/onboarding
router.get('/onboarding', async (req, res) => {
  try {
    const db = await getDb();
    const r = db.exec('SELECT * FROM onboarding WHERE user_id = ?', [req.user.id]);
    if (!r.length || !r[0].values.length) return res.json(null);
    const cols = r[0].columns;
    res.json(Object.fromEntries(cols.map((c, i) => [c, r[0].values[0][i]])));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /agent/onboarding
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

// POST /agent/strategy/run
router.post('/strategy/run', async (req, res) => {
  const db = await getDb();
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set in Render environment variables' });
  }
  const ob = db.exec('SELECT * FROM onboarding WHERE user_id = ?', [req.user.id]);
  if (!ob.length || !ob[0].values.length) {
    return res.status(400).json({ error: 'Complete onboarding first' });
  }
  const cols = ob[0].columns;
  const onboarding = Object.fromEntries(cols.map((c, i) => [c, ob[0].values[0][i]]));

  db.run(`CREATE TABLE IF NOT EXISTS agent_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, agent TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running', result TEXT, started_at TEXT NOT NULL, completed_at TEXT)`);
  db.run(`INSERT INTO agent_runs (user_id,agent,status,started_at) VALUES (?,?,?,datetime('now'))`, [req.user.id, 'strategy', 'running']);
  const runId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
  db.run(`UPDATE agents SET status='running', current_task='Analyzing market and generating roadmap...' WHERE type='strategy'`);
  db.run(`INSERT INTO activity (agent,message,type,created_at) VALUES (?,?,?,datetime('now'))`, ['Strategy', 'Starting market analysis for ' + onboarding.company_name, 'info']);
  saveDb();
  res.json({ ok: true, run_id: runId });
  runStrategyAgent(db, req.user.id, runId, onboarding).catch(console.error);
});

async function runStrategyAgent(db, userId, runId, onboarding) {
  try {
    const prompt = `You are an expert startup strategist. Analyze this company and produce a detailed roadmap.
COMPANY: ${onboarding.company_name}
PRODUCT: ${onboarding.product_desc}
TARGET MARKET: ${onboarding.target_market}
COMPETITORS: ${onboarding.competitors}
GOALS: ${onboarding.goals}
STACK: ${onboarding.stack}

Identify the 6 highest-impact priorities for the next 2 quarters.
Respond ONLY with a JSON array of exactly 6 items:
[{"title":"Short title","description":"2-3 sentences","priority":1,"quarter":"Q3 2026","reasoning":"1-2 sentences"}]`;

    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });
    const raw = message.content[0].text.trim();
    const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const items = JSON.parse(clean);

    db.run(`CREATE TABLE IF NOT EXISTS roadmap (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT NOT NULL, description TEXT, priority INTEGER, quarter TEXT, status TEXT DEFAULT 'planned', agent_reasoning TEXT, created_at TEXT NOT NULL)`);
    db.run('DELETE FROM roadmap WHERE user_id = ?', [userId]);
    items.forEach(item => {
      db.run(`INSERT INTO roadmap (user_id,title,description,priority,quarter,status,agent_reasoning,created_at) VALUES (?,?,?,?,?,'planned',?,datetime('now'))`,
        [userId, item.title, item.description, item.priority, item.quarter, item.reasoning]);
    });
    items.slice(0, 3).forEach(item => {
      db.run(`INSERT INTO tasks (title,agent_type,status,eta,created_at) VALUES (?,?,?,?,datetime('now'))`, [item.title, 'strategy', 'in_progress', 'Q: ' + item.quarter]);
    });
    db.run(`UPDATE kpis SET tasks_completed = tasks_completed + 1 WHERE id = (SELECT MAX(id) FROM kpis)`);
    db.run(`INSERT INTO activity (agent,message,type,created_at) VALUES (?,?,?,datetime('now'))`, ['Strategy', 'Roadmap generated: ' + items.length + ' priorities identified', 'success']);
    db.run(`UPDATE agent_runs SET status='complete', result=?, completed_at=datetime('now') WHERE id=?`, [JSON.stringify({ items_generated: items.length }), runId]);
    db.run(`UPDATE agents SET status='idle', current_task='Roadmap complete' WHERE type='strategy'`);
    saveDb();
  } catch (err) {
    db.run(`UPDATE agent_runs SET status='error', result=?, completed_at=datetime('now') WHERE id=?`, [JSON.stringify({ error: err.message }), runId]);
    db.run(`UPDATE agents SET status='idle', current_task='Last run failed' WHERE type='strategy'`);
    db.run(`INSERT INTO activity (agent,message,type,created_at) VALUES (?,?,?,datetime('now'))`, ['Strategy', 'Strategy run failed: ' + err.message.slice(0, 80), 'error']);
    saveDb();
  }
}

// GET /agent/roadmap
router.get('/roadmap', async (req, res) => {
  try {
    const db = await getDb();
    const r = db.exec('SELECT * FROM roadmap WHERE user_id = ? ORDER BY priority ASC', [req.user.id]);
    if (!r.length) return res.json([]);
    const { columns, values } = r[0];
    res.json(values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]]))));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /agent/runs
router.get('/runs', async (req, res) => {
  try {
    const db = await getDb();
    db.run(`CREATE TABLE IF NOT EXISTS agent_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, agent TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running', result TEXT, started_at TEXT NOT NULL, completed_at TEXT)`);
    const r = db.exec('SELECT * FROM agent_runs WHERE user_id = ? ORDER BY started_at DESC LIMIT 10', [req.user.id]);
    if (!r.length) return res.json([]);
    const { columns, values } = r[0];
    res.json(values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]]))));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /agent/engineering/run
router.post('/engineering/run', async (req, res) => {
  try {
    const db = await getDb();
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set in environment variables' });
    }
    if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) {
      return res.status(400).json({ error: 'GITHUB_TOKEN and GITHUB_REPO must be set to run the Engineering Agent' });
    }
    db.run(`CREATE TABLE IF NOT EXISTS agent_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, agent TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running', result TEXT, started_at TEXT NOT NULL, completed_at TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS onboarding (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE, company_name TEXT, product_desc TEXT, target_market TEXT, competitors TEXT, goals TEXT, stack TEXT, github_repo TEXT, updated_at TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS engineering_analysis (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'task', priority INTEGER NOT NULL DEFAULT 1, effort TEXT NOT NULL DEFAULT 'medium', reasoning TEXT, status TEXT DEFAULT 'open', created_at TEXT NOT NULL)`);

    const ob = db.exec('SELECT * FROM onboarding WHERE user_id = ?', [req.user.id]);
    const onboarding = (ob.length && ob[0].values.length)
      ? Object.fromEntries(ob[0].columns.map((c, i) => [c, ob[0].values[0][i]])) : null;

    db.run(`INSERT INTO agent_runs (user_id,agent,status,started_at) VALUES (?,?,?,datetime('now'))`, [req.user.id, 'engineering', 'running']);
    const runId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
    db.run(`UPDATE agents SET status='running', current_task='Fetching repo data from GitHub...' WHERE type='engineering'`);
    db.run(`INSERT INTO activity (agent,message,type,created_at) VALUES (?,?,?,datetime('now'))`, ['Engineering', 'Starting repo analysis for ' + process.env.GITHUB_REPO, 'info']);
    saveDb();

    res.json({ ok: true, run_id: runId });
    runEngineeringAgent(db, req.user.id, runId, onboarding).catch(console.error);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function githubGet(path) {
  const res = await fetch('https://api.github.com/repos/' + process.env.GITHUB_REPO + path, {
    headers: {
      Authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Polsia-Engineering-Agent'
    }
  });
  if (!res.ok) throw new Error('GitHub API error ' + res.status + ' on ' + path);
  return res.json();
}

async function runEngineeringAgent(db, userId, runId, onboarding) {
  try {
    db.run(`UPDATE agents SET current_task='Fetching issues, PRs and commits...' WHERE type='engineering'`);
    saveDb();

    const [repoData, issues, openPRs, recentCommits] = await Promise.all([
      githubGet(''),
      githubGet('/issues?state=open&per_page=20&sort=created&direction=desc'),
      githubGet('/pulls?state=open&per_page=10&sort=updated&direction=desc'),
      githubGet('/commits?per_page=15')
    ]);

    let closedPRs = [];
    try { closedPRs = await githubGet('/pulls?state=closed&per_page=8&sort=updated&direction=desc'); } catch (_) {}

    const realIssues = Array.isArray(issues) ? issues.filter(i => !i.pull_request).slice(0, 15) : [];

    const issuesSummary = realIssues.map(i =>
      '  #' + i.number + ' [' + ((i.labels || []).map(l => l.name).join(', ') || 'no label') + '] "' + i.title + '" — open ' + Math.round((Date.now() - new Date(i.created_at)) / 86400000) + 'd'
    ).join('\n') || '  (none)';

    const openPRsSummary = Array.isArray(openPRs) ? openPRs.map(p =>
      '  #' + p.number + ' "' + p.title + '" by @' + (p.user && p.user.login) + (p.draft ? ' — DRAFT' : '')
    ).join('\n') : '(none)';

    const commitsSummary = Array.isArray(recentCommits) ? recentCommits.slice(0, 10).map(c =>
      '  ' + (c.sha ? c.sha.slice(0, 7) : '?') + ' "' + (c.commit && c.commit.message ? c.commit.message.split('\n')[0] : '') + '"'
    ).join('\n') : '(none)';

    const closedPRsSummary = Array.isArray(closedPRs) ? closedPRs.slice(0, 5).map(p =>
      '  #' + p.number + ' "' + p.title + '" — ' + (p.merged_at ? 'merged ' + new Date(p.merged_at).toLocaleDateString() : 'closed unmerged')
    ).join('\n') : '(none)';

    db.run(`UPDATE agents SET current_task='Analyzing repo with Claude...' WHERE type='engineering'`);
    saveDb();

    const companyCtx = onboarding
      ? 'COMPANY: ' + onboarding.company_name + ' — ' + onboarding.product_desc + '\nTARGET MARKET: ' + onboarding.target_market
      : 'REPO: ' + repoData.full_name + ' — ' + (repoData.description || 'no description');

    const prompt = `You are a senior engineering lead doing sprint planning.

${companyCtx}
REPO: ${repoData.full_name} (${repoData.open_issues_count} open issues, primary language: ${repoData.language || 'unknown'})

OPEN ISSUES (${realIssues.length}):
${issuesSummary}

OPEN PULL REQUESTS:
${openPRsSummary}

RECENT COMMITS:
${commitsSummary}

RECENTLY MERGED:
${closedPRsSummary}

Identify the 6 most important engineering actions right now. Respond ONLY with a JSON array, no preamble:
[{"title":"Short title (max 10 words)","description":"What to do and why (2-3 sentences, reference issue/PR numbers).","type":"bug","priority":1,"effort":"small","reasoning":"One sentence on why this is highest leverage."}]

Valid type: bug, pr-review, refactor, security, feature, testing, tooling
Valid effort: small (under 2h), medium (half-day), large (1-2 days)`;

    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = message.content[0].text.trim();
    const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const items = JSON.parse(clean);

    db.run('DELETE FROM engineering_analysis WHERE user_id = ?', [userId]);
    items.forEach(item => {
      db.run(`INSERT INTO engineering_analysis (user_id,title,description,type,priority,effort,reasoning,status,created_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))`,
        [userId, item.title, item.description, item.type, item.priority, item.effort, item.reasoning, 'open']);
    });
    items.slice(0, 2).forEach(item => {
      const eta = item.effort === 'small' ? '~2h' : item.effort === 'medium' ? '~4h' : '~1-2 days';
      db.run(`INSERT INTO tasks (title,agent_type,status,eta,created_at) VALUES (?,?,?,?,datetime('now'))`, [item.title, 'engineering', 'in_progress', eta]);
    });
    db.run(`UPDATE kpis SET tasks_completed = tasks_completed + 1 WHERE id = (SELECT MAX(id) FROM kpis)`);
    db.run(`INSERT INTO activity (agent,message,type,created_at) VALUES (?,?,?,datetime('now'))`, ['Engineering', 'Analysis complete — ' + items.length + ' priorities for ' + repoData.full_name, 'success']);
    db.run(`UPDATE agent_runs SET status='complete', result=?, completed_at=datetime('now') WHERE id=?`, [JSON.stringify({ items_generated: items.length, repo: repoData.full_name }), runId]);
    db.run(`UPDATE agents SET status='idle', current_task=? WHERE type='engineering'`, ['Analysis complete — ' + items.length + ' priorities ready']);
    saveDb();
  } catch (err) {
    db.run(`UPDATE agent_runs SET status='error', result=?, completed_at=datetime('now') WHERE id=?`, [JSON.stringify({ error: err.message }), runId]);
    db.run(`UPDATE agents SET status='idle', current_task='Last run failed — check logs' WHERE type='engineering'`);
    db.run(`INSERT INTO activity (agent,message,type,created_at) VALUES (?,?,?,datetime('now'))`, ['Engineering', 'Engineering run failed: ' + err.message.slice(0, 80), 'error']);
    saveDb();
  }
}

// GET /agent/engineering/analysis
router.get('/engineering/analysis', async (req, res) => {
  try {
    const db = await getDb();
    db.run(`CREATE TABLE IF NOT EXISTS onboarding (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE, company_name TEXT, product_desc TEXT, target_market TEXT, competitors TEXT, goals TEXT, stack TEXT, github_repo TEXT, updated_at TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS engineering_analysis (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'task', priority INTEGER NOT NULL DEFAULT 1, effort TEXT NOT NULL DEFAULT 'medium', reasoning TEXT, status TEXT DEFAULT 'open', created_at TEXT NOT NULL)`);
    const r = db.exec('SELECT * FROM engineering_analysis WHERE user_id = ? ORDER BY priority ASC', [req.user.id]);
    if (!r.length) return res.json([]);
    const { columns, values } = r[0];
    res.json(values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]]))));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /agent/engineering/analysis/:id
router.patch('/engineering/analysis/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status required' });
    db.run(`UPDATE engineering_analysis SET status = ? WHERE id = ? AND user_id = ?`, [status, req.params.id, req.user.id]);
    saveDb();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
