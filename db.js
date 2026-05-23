const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, '../polsia.db.json');

let db = null;

async function getDb() {
  if (db) return db;
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const raw = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    const buf = Buffer.from(raw.data);
    db = new SQL.Database(buf);
    // Ensure users table exists for existing DBs
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      avatar TEXT DEFAULT 'JD',
      plan TEXT DEFAULT 'Studio Plan',
      created_at TEXT NOT NULL
    )`);
    // Seed demo user if none exist
    const res = db.exec('SELECT COUNT(*) as c FROM users');
    if (res[0].values[0][0] === 0) {
      const hash = bcrypt.hashSync('demo1234', 10);
      db.run(`INSERT INTO users (name, email, password_hash, avatar, plan, created_at)
        VALUES ('Jane Doe', 'jane@polsia.ai', ?, 'JD', 'Studio Plan', datetime('now'))`, [hash]);
      saveDb();
    }
  } else {
    db = new SQL.Database();
    await seed(db);
    saveDb();
  }
  return db;
}

function saveDb() {
  if (!db) return;
  const data = Array.from(db.export());
  fs.writeFileSync(DB_PATH, JSON.stringify({ data }), 'utf8');
}

async function seed(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      avatar TEXT DEFAULT 'JD',
      plan TEXT DEFAULT 'Studio Plan',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kpis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recorded_at TEXT NOT NULL,
      mrr INTEGER,
      active_users INTEGER,
      deploys_today INTEGER,
      tasks_completed INTEGER
    );

    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      current_task TEXT,
      uptime_minutes INTEGER DEFAULT 0,
      efficiency INTEGER DEFAULT 90
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'in_progress',
      eta TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT DEFAULT 'info',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS revenue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      amount INTEGER NOT NULL
    );
  `);

  // Demo user
  const hash = bcrypt.hashSync('demo1234', 10);
  db.run(`INSERT INTO users (name, email, password_hash, avatar, plan, created_at)
    VALUES ('Jane Doe', 'jane@polsia.ai', ?, 'JD', 'Studio Plan', datetime('now'))`, [hash]);

  // KPIs
  db.run(`INSERT INTO kpis (recorded_at, mrr, active_users, deploys_today, tasks_completed)
    VALUES (datetime('now'), 18340, 1842, 6, 247)`);

  // Agents
  const agents = [
    ['Strategy Agent', 'strategy', 'running', 'Analyzing competitor pricing changes · 3 sources', 462, 90],
    ['Engineering Agent', 'engineering', 'running', 'Building feature/notifications-v2 · 4 files changed', 462, 96],
    ['Growth Agent', 'growth', 'running', 'A/B test variant B winning · reallocating budget', 371, 82],
  ];
  agents.forEach(([name, type, status, task, uptime, efficiency]) => {
    db.run(`INSERT INTO agents (name, type, status, current_task, uptime_minutes, efficiency)
      VALUES (?, ?, ?, ?, ?, ?)`, [name, type, status, task, uptime, efficiency]);
  });

  // Tasks
  const tasks = [
    ['Build onboarding email sequence (3 emails)', 'growth', 'in_progress', '~45m left', -1],
    ['Refactor auth middleware for Next.js 15', 'engineering', 'in_progress', '~1h left', -2],
    ['Competitor feature gap analysis', 'strategy', 'in_progress', '~20m left', -3],
    ['Optimize checkout conversion flow', 'growth', 'in_progress', '~2h left', -4],
    ['Pricing page A/B test — variant ready to ship', 'growth', 'review', 'Awaiting you', -5],
    ['Q3 roadmap draft — 8 priorities ranked', 'strategy', 'review', 'Awaiting you', -6],
    ['Mobile push notifications PR #142', 'engineering', 'review', 'Awaiting you', -7],
    ['Deploy hotfix for login redirect bug', 'engineering', 'done', null, -8],
    ['Publish 2 SEO blog posts', 'growth', 'done', null, -9],
    ['Weekly competitive intelligence report', 'strategy', 'done', null, -10],
  ];
  tasks.forEach(([title, type, status, eta, hoursAgo]) => {
    db.run(`INSERT INTO tasks (title, agent_type, status, eta, created_at)
      VALUES (?, ?, ?, ?, datetime('now', ? || ' hours'))`,
      [title, type, status, eta, hoursAgo.toString()]);
  });

  // Activity
  const activities = [
    ['Engineering', 'Deployed notifications-v1 to production — 0 test failures', 'success', -2],
    ['Growth', 'Paused underperforming ad set · saved $240 in wasted spend', 'success', -3],
    ['Strategy', 'Updated roadmap — added "team collaboration" as Q3 priority', 'info', -4],
    ['Engineering', 'Fixed 3 bugs from user feedback batch · auto-closed 3 issues', 'success', -5],
    ['Growth', 'Published 2 blog posts · SEO score 91/100', 'info', -6],
    ['Strategy', 'Sent weekly digest to your inbox', 'info', -7],
  ];
  activities.forEach(([agent, message, type, hoursAgo]) => {
    db.run(`INSERT INTO activity (agent, message, type, created_at)
      VALUES (?, ?, ?, datetime('now', ? || ' hours'))`,
      [agent, message, type, hoursAgo.toString()]);
  });

  // Revenue (30 days)
  const revenueData = [9200,9800,10100,9700,11200,11800,12400,11900,13100,13800,
    14200,13600,15100,15800,16200,15700,16900,17200,17800,17100,
    17600,18000,17400,18100,18500,17900,18200,18700,18300,18340];
  revenueData.forEach((amount, i) => {
    const daysAgo = revenueData.length - 1 - i;
    db.run(`INSERT OR IGNORE INTO revenue (date, amount) VALUES (date('now', ? || ' days'), ?)`,
      [(-daysAgo).toString(), amount]);
  });
}

module.exports = { getDb, saveDb };
