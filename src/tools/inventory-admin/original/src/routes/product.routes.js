const { Router } = require('express');
const auth = require('../../../auth-context.cjs');
const {
  createProduct,
  getProducts,
  getProductById,
  updateProduct,
  deleteProduct,
} = require('../controllers/product.controller');

const router = Router();

// list / view allowed for all roles inside system
router.get('/', auth(['ADMIN', 'PRINTER', 'PACKER']), getProducts);
router.get('/:id', auth(['ADMIN', 'PRINTER', 'PACKER']), getProductById);

// admin-only CRUD
router.post('/', auth(['ADMIN']), createProduct);
router.put('/:id', auth(['ADMIN']), updateProduct);
router.delete('/:id', auth(['ADMIN']), deleteProduct);

module.exports = router;