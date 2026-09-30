const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { prepare } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'defender-panel-s3cr3t-k3y-2024-CHANGE-ME';
const TOKEN_EXPIRY = '24h';

function generateToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ error: 'Token inválido o expirado' });
  req.user = decoded;
  next();
}

function login(username, password) {
  const user = prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) return null;
  const token = generateToken(user);
  return { token, user: { id: user.id, username: user.username, role: user.role } };
}

module.exports = { generateToken, verifyToken, authMiddleware, login, JWT_SECRET };
