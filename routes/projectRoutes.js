const express = require('express');
const router = express.Router();
const {
  getAllProjects,
  getProjectById,
  createProject,
  updateProject,
  deleteProject
} = require('../controllers/projectController');

// @route   GET /api/projects
router.get('/', getAllProjects);

// @route   GET /api/projects/:id
router.get('/:id', getProjectById);

// @route   POST /api/projects
router.post('/', createProject);

// @route   PUT /api/projects/:id
router.put('/:id', updateProject);

// @route   DELETE /api/projects/:id
router.delete('/:id', deleteProject);

module.exports = router;