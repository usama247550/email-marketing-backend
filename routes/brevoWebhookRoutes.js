const express = require('express');
const router = express.Router();
const { handleBrevoWebhook } = require('../controllers/brevoWebhookController');

// POST /api/webhooks/brevo
// No authentication — Brevo calls this from its own servers.
// Payload structure validation is handled inside the controller.
router.post('/brevo', handleBrevoWebhook);

module.exports = router;
