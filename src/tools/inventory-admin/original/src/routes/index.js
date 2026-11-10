const { Router } = require('express');
const authRoutes = require('./auth.routes');
const categoryRoutes = require('./category.routes');
const productRoutes = require('./product.routes');
const inventoryRoutes = require('./inventory.routes');
const purchaseRoutes = require('./purchase.routes');
const printingRoutes = require('./printing.routes');
const barcodeRoutes = require('./barcode.routes');
const packingRoutes = require('./packing.routes');
const dashboardRoutes = require('./dashboard.routes');
const productDesignRoutes = require('./productDesign.routes');
const imageRoutes = require("./imageRoutes");

const router = Router();

router.use('/auth', authRoutes);
router.use('/categories', categoryRoutes);
router.use('/products', productRoutes);
router.use('/inventory', inventoryRoutes);
router.use('/purchase-orders', purchaseRoutes);
router.use('/printing-jobs', printingRoutes);
router.use('/barcodes', barcodeRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/packing', packingRoutes);
router.use('/product-designs', productDesignRoutes);
router.use("/images", imageRoutes);

router.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

module.exports = router;