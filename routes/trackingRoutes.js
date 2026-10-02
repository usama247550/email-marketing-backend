const express = require('express');
const router = express.Router();
const {
  trackOpen,
  trackUnsubscribe
} = require('../controllers/trackingController');

// GET /api/track/open/:trackingId - Track email open (returns 1x1 GIF)
router.get('/open/:trackingId', trackOpen);

// GET /api/track/unsubscribe/:trackingId - Track unsubscribe (returns HTML page)
router.get('/unsubscribe/:trackingId', trackUnsubscribe);

module.exports = router;