const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const fetch = require('node-fetch');
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

// ── POST /agent/engineering/run ──
router.post('/engineering/run', async (req, res) => {
  const db = await getDb();

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set in environment variables' });
  }
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) {
    return res.status(400).json({ error: 'GITHUB_TOKEN and GITHUB_REPO must be set to run the Engineering Agent' });
  }

  // Ensure engineering_analysis table exists
  db.run(`CREATE TABLE IF NOT EXISTS engineering_analysis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'task',
    priority INTEGER NOT NULL DEFAULT 1,
    effort TEXT NOT NULL DEFAULT 'medium',
    reasoning TEXT,
    status TEXT DEFAULT 'open',
    created_at TEXT NOT NULL
  )`);

  // Load onboarding for context (optional)
  const ob = db.exec('SELECT * FROM onboarding WHERE user_id = ?', [req.user.id]);
  const onboarding = (ob.length && ob[0].values.length)
    ? Object.fromEntries(ob[0].columns.map((c, i) => [c, ob[0].values[0][i]]))
    : null;

  // Create run record
  db.run(`INSERT INTO agent_runs (user_id,agent,status,started_at) VALUES (?,?,?,datetime('now'))`,
    [req.user.id, 'engineering', 'running']);
  const runId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];

  db.run(`UPDATE agents SET status='running', current_task='Fetching repo data from GitHub...' WHERE type='engineering'`);
  db.run(`INSERT INTO activity (agent,message,type,created_at) VALUES ('Engineering','Starting repo analysis for ${process.env.GITHUB_REPO}','info',datetime('now'))`);
  saveDb();

  res.json({ ok: true, run_id: runId });

  runEngineeringAgent(db, req.user.id, runId, onboarding).catch(console.error);
});

async function githubGet(path) {
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Polsia-Engineering-Agent'
    }
  });
  if (!res.ok) throw new Error(`GitHub API error ${res.status} on ${path}`);
  return res.json();
}

async function runEngineeringAgent(db, userId, runId, onboarding) {
  try {
    // ── Fetch GitHub data in parallel ──
    db.run(`UPDATE agents SET current_task='Fetching issues, PRs and commits...' WHERE type='engineering'`);
    saveDb();

    const [repoData, issues, openPRs, recentCommits] = await Promise.all([
      githubGet(''),
      githubGet('/issues?state=open&per_page=20&sort=created&direction=desc'),
      githubGet('/pulls?state=open&per_page=10&sort=updated&direction=desc'),
      githubGet('/commits?per_page=15')
    ]);

    // Also grab recently closed PRs for context on what was just shipped
    let closedPRs = [];
    try { closedPRs = await githubGet('/pulls?state=closed&per_page=8&sort=updated&direction=desc'); }
    catch (_) {}

    // Separate real issues from PRs (GitHub returns PRs in issues endpoint too)
    const realIssues = Array.isArray(issues)
      ? issues.filter(i => !i.pull_request).slice(0, 15)
      : [];

    // Format for prompt
    const issuesSummary = realIssues.map(i =>
      `  #${i.number} [${(i.labels || []).map(l => l.name).join(', ') || 'no label'}] "${i.title}" — open ${Math.round((Date.now() - new Date(i.created_at)) / 86400000)}d`
    ).join('\n') || '  (none)';

    const openPRsSummary = Array.isArray(openPRs) ? openPRs.map(p =>
      `  #${p.number} "${p.title}" by @${p.user?.login} — ${p.draft ? 'DRAFT, ' : ''}${p.requested_reviewers?.length ? `${p.requested_reviewers.length} reviewer(s) requested` : 'no reviewers'}`
    ).join('\n') : '(none)';

    const commitsSummary = Array.isArray(recentCommits) ? recentCommits.slice(0, 10).map(c =>
      `  ${c.sha?.slice(0, 7)} "${c.commit?.message?.split('\n')[0]}" — ${c.commit?.author?.name}, ${new Date(c.commit?.author?.date).toLocaleDateString()}`
    ).join('\n') : '(none)';

    const closedPRsSummary = Array.isArray(closedPRs) ? closedPRs.slice(0, 5).map(p =>
      `  #${p.number} "${p.title}" — merged ${p.merged_at ? new Date(p.merged_at).toLocaleDateString() : 'closed unmerged'}`
    ).join('\n') : '(none)';

    db.run(`UPDATE agents SET current_task='Analyzing repo with Claude...' WHERE type='engineering'`);
    saveDb();

    const companyContext = onboarding
      ? `COMPANY: ${onboarding.company_name} — ${onboarding.product_desc}\nTARGET MARKET: ${onboarding.target_market}\nSTACK: ${onboarding.stack}`
      : `REPO: ${repoData.full_name} — ${repoData.description || 'no description'}\nLANGUAGE: ${repoData.language || 'unknown'}`;

    const prompt = `You are a senior software engineering lead doing a structured code review and sprint planning session.

${companyContext}
REPO: ${repoData.full_name} (${repoData.stargazers_count} stars, ${repoData.open_issues_count} open issues)
PRIMARY LANGUAGE: ${repoData.language || 'unknown'}

OPEN ISSUES (${realIssues.length}):
${issuesSummary}

OPEN PULL REQUESTS (${Array.isArray(openPRs) ? openPRs.length : 0}):
${openPRsSummary}

RECENT COMMITS (last 15):
${commitsSummary}

RECENTLY CLOSED/MERGED:
${closedPRsSummary}

Based on this repository state, identify the 6 most important engineering actions to take right now. Mix of: bugs to fix, PRs to unblock, refactors that will accelerate future work, security/reliability improvements, and missing tests or tooling.

Respond ONLY with a JSON array of exactly 6 items. No preamble, no markdown — raw JSON only:
[
  {
    "title": "Action-oriented title (max 10 words)",
    "description": "What exactly to do and why it matters right now (2-3 sentences). Be specific — reference issue numbers, PR numbers, or file areas when relevant.",
    "type": "bug" | "pr-review" | "refactor" | "security" | "feature" | "testing" | "tooling",
    "priority": 1,
    "effort": "small" | "medium" | "large",
    "reasoning": "Why this is the highest-leverage thing to do given the current repo state (1 sentence)."
  }
]

Priority 1 = most urgent. Effort: small = <2h, medium = half-day, large = 1-2 days.`;

    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = message.content[0].text.trim();
    const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const items = JSON.parse(clean);

    // Clear old analysis for this user
    db.run('DELETE FROM engineering_analysis WHERE user_id = ?', [userId]);

    // Insert new analysis items
    items.forEach(item => {
      db.run(`INSERT INTO engineering_analysis (user_id,title,description,type,priority,effort,reasoning,status,created_at)
        VALUES (?,?,?,?,?,?,'open',?,datetime('now'))`,
        [userId, item.title, item.description, item.type, item.priority, item.effort, item.reasoning]);
    });

    // Add top 2 as tasks in the main task board
    items.slice(0, 2).forEach(item => {
      db.run(`INSERT INTO tasks (title,agent_type,status,eta,created_at)
        VALUES (?,?,?,?,datetime('now'))`,
        [item.title, 'engineering', 'in_progress', item.effort === 'small' ? '~2h' : item.effort === 'medium' ? '~4h' : '~1-2 days']);
    });

    db.run(`UPDATE kpis SET tasks_completed = tasks_completed + 1 WHERE id = (SELECT MAX(id) FROM kpis)`);
    db.run(`INSERT INTO activity (agent,message,type,created_at)
      VALUES ('Engineering','Repo analysis complete — ${items.length} engineering priorities identified for ${repoData.full_name}','success',datetime('now'))`);
    db.run(`UPDATE agent_runs SET status='complete', result=?, completed_at=datetime('now') WHERE id=?`,
      [JSON.stringify({ items_generated: items.length, repo: repoData.full_name }), runId]);
    db.run(`UPDATE agents SET status='idle', current_task='Analysis complete — ${items.length} priorities ready' WHERE type='engineering'`);

    saveDb();
  } catch (err) {
    db.run(`UPDATE agent_runs SET status='error', result=?, completed_at=datetime('now') WHERE id=?`,
      [JSON.stringify({ error: err.message }), runId]);
    db.run(`UPDATE agents SET status='idle', current_task='Last run failed — check logs' WHERE type='engineering'`);
    db.run(`INSERT INTO activity (agent,message,type,created_at)
      VALUES ('Engineering','Engineering run failed: ${err.message.slice(0, 80)}','error',datetime('now'))`);
    saveDb();
  }
}

// ── GET /agent/engineering/analysis ──
router.get('/engineering/analysis', async (req, res) => {
  try {
    const db = await getDb();
    db.run(`CREATE TABLE IF NOT EXISTS engineering_analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'task',
      priority INTEGER NOT NULL DEFAULT 1,
      effort TEXT NOT NULL DEFAULT 'medium',
      reasoning TEXT,
      status TEXT DEFAULT 'open',
      created_at TEXT NOT NULL
    )`);
    const r = db.exec('SELECT * FROM engineering_analysis WHERE user_id = ? ORDER BY priority ASC', [req.user.id]);
    if (!r.length) return res.json([]);
    const { columns, values } = r[0];
    res.json(values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]]))));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /agent/engineering/analysis/:id ──
router.patch('/engineering/analysis/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status required' });
    db.run(`UPDATE engineering_analysis SET status = ? WHERE id = ? AND user_id = ?`,
      [status, req.params.id, req.user.id]);
    saveDb();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
