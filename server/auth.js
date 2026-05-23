const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb, saveDb } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'polsia-dev-secret-change-in-production';
if (!process.env.JWT_SECRET) console.warn('⚠  JWT_SECRET not set — using insecure default. Set it in Render environment variables.');
const JWT_EXPIRES = '7d';

// ── POST /auth/login ──
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const db = await getDb();
    const result = db.exec('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    if (!result.length || !result[0].values.length) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const cols = result[0].columns;
    const user = Object.fromEntries(cols.map((c, i) => [c, result[0].values[0][i]]));

    const valid = bcrypt.compareSync(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES });

    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, avatar: user.avatar, plan: user.plan }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /auth/register ──
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const db = await getDb();

    // Check existing
    const existing = db.exec('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
    if (existing.length && existing[0].values.length) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const hash = bcrypt.hashSync(password, 10);
    const avatar = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

    db.run(`INSERT INTO users (name, email, password_hash, avatar, plan, created_at)
      VALUES (?, ?, ?, ?, 'Solo Plan', datetime('now'))`,
      [name, email.toLowerCase(), hash, avatar]);
    saveDb();

    const newUser = db.exec('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    const cols = newUser[0].columns;
    const user = Object.fromEntries(cols.map((c, i) => [c, newUser[0].values[0][i]]));

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES });

    res.status(201).json({
      token,
      user: { id: user.id, name: user.name, email: user.email, avatar: user.avatar, plan: user.plan }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /auth/me ── (verify token)
router.get('/me', async (req, res) => {
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });

    const token = auth.split(' ')[1];
    const payload = jwt.verify(token, JWT_SECRET);

    const db = await getDb();
    const result = db.exec('SELECT id, name, email, avatar, plan FROM users WHERE id = ?', [payload.id]);
    if (!result.length || !result[0].values.length) return res.status(401).json({ error: 'User not found' });

    const cols = result[0].columns;
    const user = Object.fromEntries(cols.map((c, i) => [c, result[0].values[0][i]]));
    res.json({ user });
  } catch (e) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});

module.exports = router;
module.exports.JWT_SECRET = JWT_SECRET;
