const express = require('express');
const router = express.Router();
const { handleBrevoWebhook } = require('../controllers/brevoWebhookController');

// GET /api/webhooks/brevo
// Brevo performs a reachability check (GET/HEAD) before accepting a webhook URL.
// Return 200 so that check passes.
router.get('/brevo', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Brevo webhook endpoint is reachable' });
});

// POST /api/webhooks/brevo
// No authentication — Brevo calls this from its own servers.
// Payload structure validation is handled inside the controller.
router.post('/brevo', handleBrevoWebhook);

module.exports = router;
