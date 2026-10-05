const express = require('express');
const router  = express.Router();
const {
  getAllAutomations,
  getAutomationById,
  createAutomation,
  updateAutomation,
  deleteAutomation,
} = require('../controllers/automationController');

router.get('/',    getAllAutomations);
router.get('/:id', getAutomationById);
router.post('/',   createAutomation);
router.put('/:id', updateAutomation);
router.delete('/:id', deleteAutomation);

module.exports = router;
