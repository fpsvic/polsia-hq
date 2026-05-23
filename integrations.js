const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { getDb, saveDb } = require('./db');

// ── GET /integrations/status ──
// Returns which integrations are configured
router.get('/status', async (req, res) => {
  res.json({
    stripe: !!process.env.STRIPE_SECRET_KEY,
    github: !!process.env.GITHUB_TOKEN,
    analytics: !!(process.env.GA_PROPERTY_ID && process.env.GA_API_SECRET),
  });
});

// ── POST /integrations/sync ──
// Triggers a full sync of all configured integrations
router.post('/sync', async (req, res) => {
  const results = {};

  // ── STRIPE ──
  if (process.env.STRIPE_SECRET_KEY) {
    try {
      const db = await getDb();

      // Get MRR: sum of active subscriptions
      const subsRes = await fetch('https://api.stripe.com/v1/subscriptions?status=active&limit=100', {
        headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` }
      });
      const subs = await subsRes.json();

      let mrr = 0;
      if (subs.data) {
        subs.data.forEach(sub => {
          sub.items.data.forEach(item => {
            const amount = item.price.unit_amount || 0;
            const interval = item.price.recurring?.interval;
            const qty = item.quantity || 1;
            if (interval === 'month') mrr += (amount * qty) / 100;
            if (interval === 'year') mrr += (amount * qty) / 100 / 12;
          });
        });
      }

      // Get last 30 days of charges for revenue chart
      const since = Math.floor(Date.now() / 1000) - 30 * 86400;
      const chargesRes = await fetch(
        `https://api.stripe.com/v1/charges?created[gte]=${since}&limit=100&status=succeeded`,
        { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } }
      );
      const charges = await chargesRes.json();

      // Aggregate by day
      const byDay = {};
      if (charges.data) {
        charges.data.forEach(charge => {
          const d = new Date(charge.created * 1000).toISOString().split('T')[0];
          byDay[d] = (byDay[d] || 0) + charge.amount / 100;
        });
      }

      // Upsert daily revenue
      Object.entries(byDay).forEach(([date, amount]) => {
        db.run(`INSERT OR REPLACE INTO revenue (date, amount) VALUES (?, ?)`, [date, Math.round(amount)]);
      });

      // Update KPI MRR
      db.run(`UPDATE kpis SET mrr = ?, recorded_at = datetime('now') WHERE id = (SELECT MAX(id) FROM kpis)`,
        [Math.round(mrr)]);

      saveDb();
      results.stripe = { ok: true, mrr: Math.round(mrr), days: Object.keys(byDay).length };
    } catch (e) {
      results.stripe = { ok: false, error: e.message };
    }
  } else {
    results.stripe = { ok: false, error: 'STRIPE_SECRET_KEY not set' };
  }

  // ── GITHUB ──
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPO) {
    try {
      const db = await getDb();

      // Get today's merged PRs
      const today = new Date().toISOString().split('T')[0];
      const prRes = await fetch(
        `https://api.github.com/repos/${process.env.GITHUB_REPO}/pulls?state=closed&per_page=50`,
        {
          headers: {
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json'
          }
        }
      );
      const prs = await prRes.json();

      const todayMerged = Array.isArray(prs)
        ? prs.filter(pr => pr.merged_at && pr.merged_at.startsWith(today)).length
        : 0;

      // Get recent commits as deploys proxy
      const commitsRes = await fetch(
        `https://api.github.com/repos/${process.env.GITHUB_REPO}/commits?per_page=10`,
        {
          headers: {
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json'
          }
        }
      );
      const commits = await commitsRes.json();
      const todayCommits = Array.isArray(commits)
        ? commits.filter(c => c.commit.author.date.startsWith(today)).length
        : 0;

      // Update KPI deploys
      db.run(`UPDATE kpis SET deploys_today = ?, recorded_at = datetime('now') WHERE id = (SELECT MAX(id) FROM kpis)`,
        [todayMerged || todayCommits]);

      // Log activity for merged PRs
      if (Array.isArray(prs)) {
        prs.filter(pr => pr.merged_at && pr.merged_at.startsWith(today)).slice(0, 3).forEach(pr => {
          const existing = db.exec(`SELECT id FROM activity WHERE message LIKE ? LIMIT 1`,
            [`%${pr.title.slice(0, 30)}%`]);
          if (!existing.length || !existing[0].values.length) {
            db.run(`INSERT INTO activity (agent, message, type, created_at) VALUES (?, ?, 'success', datetime('now'))`,
              ['Engineering', `Merged PR: "${pr.title.slice(0, 60)}"`]);
          }
        });
      }

      saveDb();
      results.github = { ok: true, merged_prs: todayMerged, commits_today: todayCommits };
    } catch (e) {
      results.github = { ok: false, error: e.message };
    }
  } else {
    results.github = { ok: false, error: 'GITHUB_TOKEN or GITHUB_REPO not set' };
  }

  // ── GOOGLE ANALYTICS ──
  if (process.env.GA_PROPERTY_ID && process.env.GA_API_SECRET) {
    try {
      const db = await getDb();

      // GA4 Data API
      const gaRes = await fetch(
        `https://analyticsdata.googleapis.com/v1beta/properties/${process.env.GA_PROPERTY_ID}:runReport`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': process.env.GA_API_SECRET
          },
          body: JSON.stringify({
            dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
            metrics: [{ name: 'activeUsers' }, { name: 'sessions' }],
            dimensions: [{ name: 'date' }]
          })
        }
      );
      const gaData = await gaRes.json();

      let totalUsers = 0;
      if (gaData.rows) {
        gaData.rows.forEach(row => {
          totalUsers = Math.max(totalUsers, parseInt(row.metricValues[0].value) || 0);
        });
      }

      if (totalUsers > 0) {
        db.run(`UPDATE kpis SET active_users = ?, recorded_at = datetime('now') WHERE id = (SELECT MAX(id) FROM kpis)`,
          [totalUsers]);
        saveDb();
      }

      results.analytics = { ok: true, active_users: totalUsers };
    } catch (e) {
      results.analytics = { ok: false, error: e.message };
    }
  } else {
    results.analytics = { ok: false, error: 'GA_PROPERTY_ID or GA_API_SECRET not set' };
  }

  res.json({ synced_at: new Date().toISOString(), results });
});

// ── POST /integrations/manual ──
// Manual override for any KPI
router.post('/manual', async (req, res) => {
  try {
    const db = await getDb();
    const { mrr, active_users, deploys_today, tasks_completed } = req.body;

    const fields = [];
    const vals = [];
    if (mrr !== undefined) { fields.push('mrr = ?'); vals.push(Number(mrr)); }
    if (active_users !== undefined) { fields.push('active_users = ?'); vals.push(Number(active_users)); }
    if (deploys_today !== undefined) { fields.push('deploys_today = ?'); vals.push(Number(deploys_today)); }
    if (tasks_completed !== undefined) { fields.push('tasks_completed = ?'); vals.push(Number(tasks_completed)); }

    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

    fields.push('recorded_at = datetime(\'now\')');
    vals.push(null); // placeholder for WHERE
    db.run(`UPDATE kpis SET ${fields.join(', ')} WHERE id = (SELECT MAX(id) FROM kpis)`, vals.slice(0, -1));
    saveDb();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /integrations/revenue/manual ──
// Add a manual revenue data point
router.post('/revenue/manual', async (req, res) => {
  try {
    const db = await getDb();
    const { date, amount } = req.body;
    if (!date || amount === undefined) return res.status(400).json({ error: 'date and amount required' });
    db.run(`INSERT OR REPLACE INTO revenue (date, amount) VALUES (?, ?)`, [date, Number(amount)]);
    saveDb();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
