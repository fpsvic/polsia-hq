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
    db = new SQL.Database(Buffer.from(raw.data));
    // Add new tables if missing
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, avatar TEXT DEFAULT 'JD',
      plan TEXT DEFAULT 'Studio Plan', created_at TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS onboarding (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      company_name TEXT, product_desc TEXT, target_market TEXT,
      competitors TEXT, goals TEXT, stack TEXT, github_repo TEXT,
      updated_at TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS roadmap (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL, description TEXT,
      priority INTEGER DEFAULT 0, quarter TEXT,
      status TEXT DEFAULT 'planned', agent_reasoning TEXT,
      created_at TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL, agent TEXT NOT NULL,
      status TEXT DEFAULT 'running', result TEXT,
      started_at TEXT NOT NULL, completed_at TEXT
    )`);
    // Seed demo user if missing
    const res = db.exec('SELECT COUNT(*) as c FROM users');
    if (res[0].values[0][0] === 0) {
      const hash = bcrypt.hashSync('demo1234', 10);
      db.run(`INSERT INTO users (name,email,password_hash,avatar,plan,created_at)
        VALUES ('Jane Doe','jane@polsia.ai',?,'JD','Studio Plan',datetime('now'))`, [hash]);
    }
    saveDb();
  } else {
    db = new SQL.Database();
    await seed(db);
    saveDb();
  }
  return db;
}

function saveDb() {
  if (!db) return;
  fs.writeFileSync(DB_PATH, JSON.stringify({ data: Array.from(db.export()) }));
}

async function seed(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      avatar TEXT DEFAULT 'JD', plan TEXT DEFAULT 'Studio Plan', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS onboarding (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE,
      company_name TEXT, product_desc TEXT, target_market TEXT,
      competitors TEXT, goals TEXT, stack TEXT, github_repo TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS roadmap (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
      title TEXT NOT NULL, description TEXT, priority INTEGER DEFAULT 0,
      quarter TEXT, status TEXT DEFAULT 'planned', agent_reasoning TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
      agent TEXT NOT NULL, status TEXT DEFAULT 'running',
      result TEXT, started_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS kpis (
      id INTEGER PRIMARY KEY AUTOINCREMENT, recorded_at TEXT NOT NULL,
      mrr INTEGER, active_users INTEGER, deploys_today INTEGER, tasks_completed INTEGER
    );
    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle', current_task TEXT,
      uptime_minutes INTEGER DEFAULT 0, efficiency INTEGER DEFAULT 90
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, agent_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'in_progress', eta TEXT, created_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, message TEXT NOT NULL,
      type TEXT DEFAULT 'info', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS revenue (
      id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL UNIQUE, amount INTEGER NOT NULL
    );
  `);

  const hash = bcrypt.hashSync('demo1234', 10);
  db.run(`INSERT INTO users (name,email,password_hash,avatar,plan,created_at)
    VALUES ('Jane Doe','jane@polsia.ai',?,'JD','Studio Plan',datetime('now'))`, [hash]);
  db.run(`INSERT INTO kpis (recorded_at,mrr,active_users,deploys_today,tasks_completed)
    VALUES (datetime('now'),0,0,0,0)`);
  const agents = [
    ['Strategy Agent','strategy','idle','Waiting for onboarding',0,90],
    ['Engineering Agent','engineering','idle','Waiting for onboarding',0,96],
    ['Growth Agent','growth','idle','Waiting for onboarding',0,82],
  ];
  agents.forEach(([n,t,s,task,u,e]) =>
    db.run(`INSERT INTO agents (name,type,status,current_task,uptime_minutes,efficiency) VALUES (?,?,?,?,?,?)`,
      [n,t,s,task,u,e]));
  const revenueData = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
  revenueData.forEach((amount,i) => {
    const daysAgo = revenueData.length-1-i;
    db.run(`INSERT OR IGNORE INTO revenue (date,amount) VALUES (date('now',? || ' days'),?)`,
      [(-daysAgo).toString(), amount]);
  });
}

module.exports = { getDb, saveDb };
