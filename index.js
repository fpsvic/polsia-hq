const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Auth middleware for /api routes
app.use('/api', (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    req.user = jwt.verify(auth.split(' ')[1], JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});

// Routes
app.use('/auth', require('./auth'));
app.use('/api', require('./routes'));

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));

// Fallback
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  ✦ Polsia server running on port ${PORT}`);
  console.log(`  ✦ Demo login: jane@polsia.ai / demo1234\n`);
});
