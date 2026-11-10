// controllers/packing.controller.js
const Barcode = require('../models/Barcode');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product'); // make sure this path is correct
const mongoose = require('../../../mongoose-context.cjs');
const {
  calculateBarcodeGenerationCount,
} = require('../services/barcode-generation.service');

// NEW: POST /api/packing/lookup (ADMIN / PACKER)
// body: { code }
const lookupBarcode = async (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ message: 'Barcode code is required' });
    }

    const barcode = await Barcode.findOne({ code }).populate('productId', 'name skuBase categoryId');
    if (!barcode) {
      return res.status(404).json({ message: 'Barcode not found' });
    }

    // Optionally show that it is already used, but DO NOT change anything
    const product = barcode.productId; // after populate
    const designCode = barcode.designCode;

    // Optionally, also show current printed inventory quantity for that design
    const printedInv = await Inventory.findOne({
      productId: barcode.productId._id || barcode.productId,
      type: 'PRINTED',
      designCode,
    });

    return res.json({
      barcode: {
        id: barcode._id,
        code: barcode.code,
        status: barcode.status,          // "NEW" / "USED" etc.
        designCode,
      },
      product: product
        ? {
            id: product._id,
            name: product.name,
            skuBase: product.skuBase,
            categoryId: product.categoryId,
          }
        : null,
      printedInventory: printedInv
        ? {
            quantity: printedInv.quantity,
            minThreshold: printedInv.minThreshold,
          }
        : null,
    });
  } catch (err) {
    console.error('Lookup barcode error', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// existing commit scan
// POST /api/packing/scan (ADMIN / PACKER)
// body: { code }
const scanBarcode = async (req, res) => {
  let session;
  try {
    const code = String(req.body.code || '').trim();

    if (!code) {
      return res.status(400).json({ message: 'Barcode code is required' });
    }

    session = await mongoose.startSession();
    let barcode;
    let printedInv;

    await session.withTransaction(async () => {
      // Claim the label atomically. If a second scan arrives at the same
      // moment, only one transaction can turn it from AVAILABLE to USED.
      barcode = await Barcode.findOneAndUpdate(
        { code, status: 'AVAILABLE' },
        { $set: { status: 'USED', usedAt: new Date() } },
        { new: true, session },
      );

      if (!barcode) {
        const existingBarcode = await Barcode.exists({ code }).session(session);
        throw new Error(existingBarcode ? 'Barcode already used' : 'Barcode not found');
      }

      printedInv = await Inventory.findOneAndUpdate(
        {
          productId: barcode.productId,
          type: 'PRINTED',
          designCode: barcode.designCode,
          quantity: { $gte: 1 },
        },
        { $inc: { quantity: -1 } },
        { new: true, session },
      );

      if (!printedInv) {
        throw new Error('No printed stock available for this barcode SKU');
      }

      // The Barcode collection is authoritative. Recalculate the cached
      // counters after every scan, which also repairs old inconsistent rows.
      const availableBarcodeCount = await Barcode.countDocuments({
        productId: barcode.productId,
        designCode: barcode.designCode,
        status: 'AVAILABLE',
      }).session(session);

      const unbarcodedQuantity = calculateBarcodeGenerationCount(
        printedInv.quantity,
        availableBarcodeCount,
      );

      printedInv = await Inventory.findOneAndUpdate(
        { _id: printedInv._id, quantity: printedInv.quantity },
        {
          $set: {
            activeBarcodeCount: availableBarcodeCount,
            unbarcodedQuantity,
          },
        },
        { new: true, runValidators: true, session },
      );

      if (!printedInv) {
        throw new Error('PRINTED inventory changed; please scan the barcode again');
      }
    });

    res.json({
      message: 'Barcode scanned; printed stock decremented',
      barcode: {
        id: barcode._id,
        code: barcode.code,
        status: barcode.status,
        usedAt: barcode.usedAt,
      },
      inventory: {
        productId: printedInv.productId,
        designCode: printedInv.designCode,
        quantity: printedInv.quantity,
      },
    });
  } catch (err) {
    if (
      err.message === 'Barcode not found' ||
      err.message === 'Barcode already used' ||
      err.message === 'No printed stock available for this barcode SKU' ||
      err.message === 'PRINTED inventory changed; please scan the barcode again'
    ) {
      return res.status(err.message === 'Barcode not found' ? 404 : 400).json({
        message: err.message,
      });
    }
    console.error('Scan barcode error', err);
    res.status(500).json({ message: 'Server error' });
  } finally {
    if (session) await session.endSession();
  }
};

module.exports = {
  scanBarcode,
  lookupBarcode,
};
