const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const authMiddleware = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
  try { req.user = jwt.verify(auth.split(' ')[1], JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid or expired token' }); }
};

app.use('/api', authMiddleware);
app.use('/integrations', authMiddleware);
app.use('/agent', authMiddleware);

app.use('/auth', require('./auth'));
app.use('/api', require('./routes'));
app.use('/integrations', require('./integrations'));
app.use('/agent', require('./agent'));

app.use(express.static(path.join(__dirname, '../public')));
app.get('/{*path}', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

app.listen(PORT, () => {
  console.log(`\n  ✦ Polsia running on port ${PORT}\n`);
});
