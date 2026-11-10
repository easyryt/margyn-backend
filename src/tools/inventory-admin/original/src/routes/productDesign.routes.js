const { Router } = require('express');
const auth = require('../../../auth-context.cjs');

const {
  createProductDesign,
  getProductDesigns,
  updateProductDesign,
  deleteProductDesign,
} = require('../controllers/productDesign.controller');

const router = Router();

// GET /api/product-designs/product/:productId
router.get(
  '/product/:productId',
  auth(['ADMIN', 'PRINTER', 'PACKER']),
  getProductDesigns
);

// POST /api/product-designs
router.post(
  '/',
  auth(['ADMIN', 'PRINTER']),
  createProductDesign
);

// PUT /api/product-designs/:id
router.put(
  '/:id',
  auth(['ADMIN', 'PRINTER']),
  updateProductDesign
);

// DELETE /api/product-designs/:id
router.delete(
  '/:id',
  auth(['ADMIN', 'PRINTER']),
  deleteProductDesign
);

module.exports = router;