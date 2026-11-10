const { Router } = require('express');

const auth = require('../../../auth-context.cjs');

const {
  generateBarcodes,
  listBarcodesByProduct,
  updateBarcodeStatus,
  getBarcodeTodayReport,
  getPackedBarcodes,
} = require('../controllers/barcode.controller');

const router = Router();

/*
 * Generate ONLY newly required barcodes.
 */
router.post(
  '/',
  auth(['ADMIN', 'PRINTER']),
  generateBarcodes,
);

/*
 * Packed / USED barcodes.
 */
router.get(
  '/packed',
  auth(['ADMIN', 'PRINTER']),
  getPackedBarcodes,
);

/*
 * Today's generated barcode report.
 */
router.get(
  '/report/today',
  auth(['ADMIN', 'PRINTER']),
  getBarcodeTodayReport,
);

/*
 * Manage barcodes for a product.
 *
 * Optional query:
 *
 * ?designCode=ABC
 * ?status=AVAILABLE
 * ?status=USED
 * ?generationBatchId=BATCH-XXXX
 * ?from=2026-08-19
 * ?to=2026-08-19
 */
router.get(
  '/manage/:productId',
  auth(['ADMIN', 'PRINTER']),
  listBarcodesByProduct,
);

/*
 * Change barcode status.
 */
router.patch(
  '/:id/status',
  auth(['ADMIN', 'PRINTER']),
  updateBarcodeStatus,
);

module.exports = router;