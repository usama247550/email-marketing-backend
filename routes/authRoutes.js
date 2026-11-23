'use strict';

const express = require('express');
const { signAuthToken, verifyAuthToken } = require('../middleware/authToken');

const router = express.Router();

function getAdminCredentials() {
  const email = (process.env.ADMIN_EMAIL || 'arswift@admin.com').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  return { email, password };
}

router.post('/login', (req, res) => {
  try {
    const rawEmail = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const rawPassword = typeof req.body?.password === 'string' ? req.body.password : '';
    const { email, password } = getAdminCredentials();

    if (!rawEmail || !rawPassword) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required',
      });
    }

    if (rawEmail !== email || rawPassword !== password) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password',
      });
    }

    const token = signAuthToken({ role: 'admin', email });
    return res.json({
      success: true,
      message: 'Logged in successfully',
      token,
      user: { email },
    });
  } catch (error) {
    console.error('[auth] login error:', error);
    return res.status(500).json({
      success: false,
      message: 'Login failed',
    });
  }
});

router.get('/me', (req, res) => {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const payload = verifyAuthToken(match ? match[1].trim() : null);

  if (!payload) {
    return res.status(401).json({ success: false, message: 'Not authenticated' });
  }

  return res.json({
    success: true,
    user: { email: payload.email || 'admin' },
  });
});

module.exports = router;