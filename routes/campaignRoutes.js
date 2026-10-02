const express = require('express');
const router = express.Router();
const {
  createCampaign,
  getAllCampaigns,
  getCampaignById,
  deleteCampaign
} = require('../controllers/campaignController');

// GET /api/campaigns - Get all campaigns
router.get('/', getAllCampaigns);

// GET /api/campaigns/:id - Get campaign by ID
router.get('/:id', getCampaignById);

// POST /api/campaigns - Create new campaign and send emails
router.post('/', createCampaign);

// DELETE /api/campaigns/:id - Delete campaign
router.delete('/:id', deleteCampaign);

module.exports = router;