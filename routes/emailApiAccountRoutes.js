const express = require('express');
const router = express.Router();
const emailApiAccountController = require('../controllers/emailApiAccountController');

// GET /api/email-api-accounts - Get all email API accounts
router.get('/', emailApiAccountController.getAll);

// POST /api/email-api-accounts/:id/test — validate key with Brevo
router.post('/:id/test', emailApiAccountController.test);

// GET /api/email-api-accounts/:id - Get email API account by ID
router.get('/:id', emailApiAccountController.getById);

// POST /api/email-api-accounts - Create new email API account
router.post('/', emailApiAccountController.create);

// PUT /api/email-api-accounts/:id - Update email API account
router.put('/:id', emailApiAccountController.update);

// DELETE /api/email-api-accounts/:id - Delete email API account
router.delete('/:id', emailApiAccountController.delete);

module.exports = router;