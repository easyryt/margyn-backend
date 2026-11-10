const mongoose = require('../../../mongoose-context.cjs');
const PurchaseOrder = require('../models/PurchaseOrder');
const Product = require('../models/Product');
const { addRawStock } = require('../services/inventory.service');

const isPositiveWholeNumber = (value) =>
  Number.isSafeInteger(Number(value)) && Number(value) > 0;

const isNonNegativeWholeNumber = (value) =>
  Number.isSafeInteger(Number(value)) && Number(value) >= 0;

/**
 * Purchase orders are product-only. Repeated selections of the same product
 * are combined into a single line so verification has one quantity per model.
 */
const normalizeOrderItems = (items) => {
  const quantitiesByProduct = new Map();

  for (const item of items) {
    if (!item.productId || !mongoose.Types.ObjectId.isValid(item.productId)) {
      throw new Error('Each item must have a valid productId');
    }
    if (!isPositiveWholeNumber(item.orderedQty)) {
      throw new Error('orderedQty must be a positive whole number for each item');
    }

    const productId = String(item.productId);
    quantitiesByProduct.set(
      productId,
      (quantitiesByProduct.get(productId) || 0) + Number(item.orderedQty)
    );
  }

  return [...quantitiesByProduct.entries()].map(([productId, orderedQty]) => ({
    productId,
    orderedQty,
  }));
};

const buildTextSummary = (items, productsById) =>
  items
    .map((item) => {
      const product = productsById.get(String(item.productId));
      return `${product?.name || 'Unknown Product'} - ${item.orderedQty}pcs`;
    })
    .join(', ');

// Old pending purchase orders may still have several design rows for one
// product. This records one product-level received quantity without losing the
// total shown in their historical line items.
const distributeReceivedQuantity = (orderItems, receivedQty) => {
  let remaining = receivedQty;

  for (const orderItem of orderItems) {
    const appliedQty = Math.min(Number(orderItem.orderedQty), remaining);
    orderItem.receivedQty = appliedQty;
    remaining -= appliedQty;
  }

  if (remaining > 0 && orderItems[0]) {
    orderItems[0].receivedQty += remaining;
  }
};

// ---------- CREATE ----------
const createPurchaseOrder = async (req, res) => {
  try {
    const { supplierName, notes, items, purchaseDate } = req.body;
    const userId = req.user?.id;

    if (!supplierName || typeof supplierName !== 'string') {
      return res.status(400).json({ message: 'supplierName is required' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'Items array is required' });
    }

    let normalizedItems;
    try {
      normalizedItems = normalizeOrderItems(items);
    } catch (error) {
      return res.status(400).json({ message: error.message });
    }

    const productIds = normalizedItems.map((item) => item.productId);
    const products = await Product.find({
      _id: { $in: productIds },
      isActive: true,
    }).select('name');
    const productsById = new Map(
      products.map((product) => [String(product._id), product])
    );

    if (productsById.size !== productIds.length) {
      return res.status(400).json({
        message: 'One or more selected products are not active',
      });
    }

    const po = await PurchaseOrder.create({
      supplierName: supplierName.trim(),
      notes: notes ? String(notes).trim() : '',
      purchaseDate: purchaseDate ? new Date(purchaseDate) : new Date(),
      items: normalizedItems,
      status: 'PENDING',
      textSummary: buildTextSummary(normalizedItems, productsById),
      createdBy: userId || undefined,
    });

    return res.status(201).json({
      message: 'Purchase order created successfully',
      purchaseOrder: po,
    });
  } catch (err) {
    console.error('Create purchase order error', err);
    return res.status(500).json({ message: 'Server error' });
  }
};

// ---------- VERIFY ----------
const verifyPurchaseOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const { items } = req.body; // [{ productId, receivedQty }]

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid purchase order ID' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'Items array is required' });
    }

    const po = await PurchaseOrder.findById(id);
    if (!po) {
      return res.status(404).json({ message: 'Purchase order not found' });
    }
    if (po.status !== 'PENDING') {
      return res.status(400).json({ message: 'Order is already verified' });
    }

    const receivedByProduct = new Map();
    for (const item of items) {
      if (
        !item.productId ||
        !mongoose.Types.ObjectId.isValid(item.productId) ||
        !isNonNegativeWholeNumber(item.receivedQty)
      ) {
        return res.status(400).json({
          message: 'Each item must have a valid productId and a whole receivedQty of 0 or more',
        });
      }

      const productId = String(item.productId);
      if (receivedByProduct.has(productId)) {
        return res.status(400).json({
          message: 'Each product can appear only once when verifying',
        });
      }
      receivedByProduct.set(productId, Number(item.receivedQty));
    }

    const orderItemsByProduct = new Map();
    for (const orderItem of po.items) {
      const productId = String(orderItem.productId);
      const productItems = orderItemsByProduct.get(productId) || [];
      productItems.push(orderItem);
      orderItemsByProduct.set(productId, productItems);
    }

    for (const productId of receivedByProduct.keys()) {
      if (!orderItemsByProduct.has(productId)) {
        return res.status(400).json({
          message: 'Verification contains a product that is not in this order',
        });
      }
    }
    for (const productId of orderItemsByProduct.keys()) {
      if (!receivedByProduct.has(productId)) {
        return res.status(400).json({
          message: 'A received quantity is required for every product in this order',
        });
      }
    }

    for (const [productId, orderItems] of orderItemsByProduct) {
      const receivedQty = receivedByProduct.get(productId);
      distributeReceivedQuantity(orderItems, receivedQty);

      if (receivedQty > 0) {
        // This service always updates the single product-level RAW record:
        // { productId, type: 'RAW', designCode: null }.
        await addRawStock(productId, receivedQty);
      }
    }

    po.status = 'VERIFIED';
    await po.save();

    return res.json({
      message: 'Purchase order verified and product RAW stock updated',
      purchaseOrder: po,
    });
  } catch (err) {
    console.error('Verify purchase order error', err);
    return res.status(500).json({ message: 'Server error' });
  }
};

// ---------- LIST ----------
const listPurchaseOrders = async (req, res) => {
  try {
    const pos = await PurchaseOrder.find()
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('items.productId', 'name')
      .lean();
    return res.json({ purchaseOrders: pos });
  } catch (err) {
    console.error('List purchase orders error', err);
    return res.status(500).json({ message: 'Server error' });
  }
};

// ---------- UPDATE ----------
const updatePurchaseOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const { purchaseDate, supplierName, notes } = req.body;

    const po = await PurchaseOrder.findById(id);
    if (!po) return res.status(404).json({ message: 'Order not found' });

    if (po.status !== 'PENDING') {
      return res.status(400).json({ message: 'Only PENDING orders can be updated' });
    }

    if (purchaseDate) {
      const date = new Date(purchaseDate);
      if (Number.isNaN(date.getTime())) {
        return res.status(400).json({ message: 'Invalid date' });
      }
      po.purchaseDate = date;
    }
    if (supplierName) po.supplierName = supplierName.trim();
    if (notes !== undefined) po.notes = String(notes).trim();

    await po.save();
    return res.json({ message: 'Order updated', purchaseOrder: po });
  } catch (err) {
    console.error('Update purchase order error', err);
    return res.status(500).json({ message: 'Server error' });
  }
};

module.exports = {
  createPurchaseOrder,
  verifyPurchaseOrder,
  listPurchaseOrders,
  updatePurchaseOrder,
};
