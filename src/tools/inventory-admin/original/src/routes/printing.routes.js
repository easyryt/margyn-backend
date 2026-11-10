const { Router } = require('express');
const auth = require('../../../auth-context.cjs');
const { generateBarcodes } = require('../controllers/barcode.controller');

const {
  createPrintingJob,
  listPrintingJobs,
  getPrintingJobById,
  updatePrintingJob,
  deletePrintingJob,
  getPrintedDesignsByProduct,
} = require('../controllers/printing.controller');

const router = Router();

// Get available model/design list for a product.
router.get(
  '/designs/:productId',
  auth(['ADMIN', 'PRINTER', 'PACKER']),
  getPrintedDesignsByProduct
);

// Printing job CRUD.
router.post('/', auth(['ADMIN', 'PRINTER']), createPrintingJob);

router.get('/', auth(['ADMIN', 'PRINTER']), listPrintingJobs);

// Generate (or safely return) the one exact barcode batch for a completed
// printing job. New clients should use this route instead of aggregate stock.
router.post(
  '/:id/barcodes',
  auth(['ADMIN', 'PRINTER']),
  (req, res) => {
    req.body = {
      ...(req.body || {}),
      printingJobId: req.params.id,
    };

    return generateBarcodes(req, res);
  },
);

router.get('/:id', auth(['ADMIN', 'PRINTER']), getPrintingJobById);

router.put('/:id', auth(['ADMIN', 'PRINTER']), updatePrintingJob);

router.delete('/:id', auth(['ADMIN', 'PRINTER']), deletePrintingJob);

module.exports = router;
