'use strict';

const { verifyAuthToken } = require('./authToken');

const PUBLIC_PATHS = [
  { method: 'POST', path: '/auth/login' },
  { method: 'GET', path: '/health' },
];

function isPublicApiRequest(req) {
  const path = req.path || '';
  if (path.startsWith('/track')) return true;
  if (path.startsWith('/webhooks')) return true;
  return PUBLIC_PATHS.some(
    (p) => p.path === path && (!p.method || p.method === req.method)
  );
}

function requireAuth(req, res, next) {
  if (isPublicApiRequest(req)) {
    return next();
  }

  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match ? match[1].trim() : null;
  const payload = verifyAuthToken(token);

  if (!payload) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required. Please log in.',
    });
  }

  req.auth = payload;
  return next();
}

module.exports = { requireAuth };