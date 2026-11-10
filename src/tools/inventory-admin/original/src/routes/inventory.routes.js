const { Router } = require('express');
const auth = require('../../../auth-context.cjs');
const {
  addRawInventory,
  transferRawToPrintedInventory,
  getDesignInventoryByProduct,
  updateInventoryThreshold,
  getLowStockInventory,
} = require('../controllers/inventory.controller');

const router = Router();

// RAW is stock for a phone model only, never for an individual design.
router.post('/raw', auth(['ADMIN', 'PRINTER']), addRawInventory);

// Moves one or more quantities from RAW model stock to PRINTED design stock.
router.post(
  '/transfer-to-printed',
  auth(['ADMIN', 'PRINTER']),
  transferRawToPrintedInventory
);

router.get('/low-stock', auth(['ADMIN', 'PRINTER', 'PACKER']), getLowStockInventory);
router.patch('/:id', auth(['ADMIN', 'PRINTER', 'PACKER']), updateInventoryThreshold);

// Keep these aliases if the existing frontend already calls them.
router.get('/design/:productId', auth(['ADMIN', 'PRINTER', 'PACKER']), getDesignInventoryByProduct);
router.get('/with-barcodes/:productId', auth(['ADMIN', 'PRINTER', 'PACKER']), getDesignInventoryByProduct);
router.get('/:productId', auth(['ADMIN', 'PRINTER', 'PACKER']), getDesignInventoryByProduct);

module.exports = router;
