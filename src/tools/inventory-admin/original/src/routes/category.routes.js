const { Router } = require('express');
const auth = require('../../../auth-context.cjs');
const {
  createCategory,
  getCategories,
  getCategoryById,
  updateCategory,
  deleteCategory,
} = require('../controllers/category.controller');

const router = Router();

// public list (or later restrict if you want)
router.get('/', auth(['ADMIN', 'PRINTER', 'PACKER']), getCategories);

// get single
router.get('/:id', auth(['ADMIN', 'PRINTER', 'PACKER']), getCategoryById);

// admin-only actions
router.post('/', auth(['ADMIN']), createCategory);
router.put('/:id', auth(['ADMIN']), updateCategory);
router.delete('/:id', auth(['ADMIN']), deleteCategory);

module.exports = router;