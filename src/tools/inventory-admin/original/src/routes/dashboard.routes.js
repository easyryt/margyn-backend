// routes/dashboard.routes.js
const { Router } = require('express');
const auth = require('../../../auth-context.cjs');
const Product = require('../models/Product');
const Inventory = require('../models/Inventory');
const PurchaseOrder = require('../models/PurchaseOrder');

const router = Router();

// GET /api/dashboard/inventory-products
router.get('/inventory-products', auth(['ADMIN']), async (req, res) => {
  try {
    const products = await Product.find({ isActive: true }).populate('categoryId');

    const result = await Promise.all(
      products.map(async (p) => {
        const inventoryDocs = await Inventory.find({ productId: p._id }).sort({
          type: 1,
          designCode: 1,
        });

        const rawDoc = inventoryDocs.find(
          (i) => i.type === 'RAW' && i.designCode === null
        );
        const printedDocs = inventoryDocs.filter((i) => i.type === 'PRINTED');

        const rawQuantity = rawDoc?.quantity ?? 0;
        const minThreshold = rawDoc?.minThreshold ?? 0;
        const printedQuantity = printedDocs.reduce(
          (sum, doc) => sum + (doc.quantity ?? 0),
          0
        );

        return {
          id: String(p._id),
          name: p.name,
          categoryName: p.categoryId?.name ?? '',
          rawQuantity,
          printedQuantity,
          minThreshold,
        };
      })
    );

    res.json(result);
  } catch (err) {
    console.error('Dashboard inventory-products error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// NEW: GET /api/dashboard/inventory-supplier
router.get('/inventory-supplier', auth(['ADMIN']), async (req, res) => {
  try {
    const pos = await PurchaseOrder.find()
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    const supplierByProduct = {};

    for (const po of pos) {
      for (const item of po.items || []) {
        const pid = String(item.productId);
        if (!supplierByProduct[pid]) {
          supplierByProduct[pid] = {
            supplierName: po.supplierName || '',
            notes: po.notes || '',
            purchaseOrderId: String(po._id),
            status: po.status,
          };
        }
      }
    }

    res.json({ supplierByProduct });
  } catch (err) {
    console.error('Dashboard inventory-supplier error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
