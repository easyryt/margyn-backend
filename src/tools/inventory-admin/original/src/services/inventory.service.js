const Inventory = require('../models/Inventory');

const rawFilter = (productId) => ({
  productId,
  type: 'RAW',
  designCode: null,
});

const printedFilter = (productId, designCode) => ({
  productId,
  type: 'PRINTED',
  designCode,
});

const updateOptions = (session) => ({
  new: true,
  upsert: true,
  runValidators: true,
  ...(session ? { session } : {}),
});

/**
 * Add stock to the single RAW inventory row for this product/model.
 */
const addRawStock = (productId, quantity, minThreshold, session) => {
  const update = {
    $inc: { quantity },
    $set: { isActive: true },
    $setOnInsert: {
      ...rawFilter(productId),
      minThreshold: minThreshold ?? 0,
    },
  };

  // Do not overwrite an existing threshold unless the caller explicitly asks.
  if (minThreshold !== undefined) {
    update.$set.minThreshold = minThreshold;
  }

  return Inventory.findOneAndUpdate(rawFilter(productId), update, updateOptions(session));
};

/**
 * Deduct RAW stock only when enough is available. `null` means insufficient.
 */
const deductRawStock = (productId, quantity, session) =>
  Inventory.findOneAndUpdate(
    { ...rawFilter(productId), quantity: { $gte: quantity } },
    { $inc: { quantity: -quantity } },
    { new: true, ...(session ? { session } : {}) }
  );

/**
 * Add stock to one PRINTED inventory row for this product/model + design.
 */
const addPrintedStock = async (productId, designCode, quantity, session) => {
  const filter = printedFilter(productId, designCode);

  // Existing installations can contain an explicit `null` from before the
  // exact queue was introduced. MongoDB cannot $inc a null value, so upgrade
  // it atomically inside the caller's transaction before adding new stock.
  await Inventory.updateOne(
    { ...filter, pendingBarcodeQuantity: null },
    { $set: { pendingBarcodeQuantity: 0 } },
    session ? { session } : {},
  );

  return Inventory.findOneAndUpdate(
    filter,
    {
      $inc: {
        quantity,
        unbarcodedQuantity: quantity,
        pendingBarcodeQuantity: quantity,
      },
      $set: { isActive: true },
      $setOnInsert: {
        ...printedFilter(productId, designCode),
        minThreshold: 0,
      },
    },
    updateOptions(session),
  );
};

/**
 * Deduct PRINTED stock only. Barcode scans must call this, never deductRawStock.
 */
const deductPrintedStock = (productId, designCode, quantity, session) =>
  Inventory.findOneAndUpdate(
    { ...printedFilter(productId, designCode), quantity: { $gte: quantity } },
    { $inc: { quantity: -quantity } },
    { new: true, ...(session ? { session } : {}) }
  );

/**
 * Reserve active barcode labels. The conditional update makes this safe even
 * when two staff members generate labels at the same time.
 */
const reserveBarcodeLabels = (productId, designCode, quantity, session) =>
  Inventory.findOneAndUpdate(
    {
      ...printedFilter(productId, designCode),
      $expr: {
        $gte: [
          {
            $subtract: [
              '$quantity',
              { $ifNull: ['$activeBarcodeCount', 0] },
            ],
          },
          quantity,
        ],
      },
    },
    { $inc: { activeBarcodeCount: quantity } },
    { new: true, ...(session ? { session } : {}) }
  );

/**
 * A barcode scan consumes one label and one matching PRINTED item together.
 */
const deductPrintedStockForBarcode = (productId, designCode, quantity, session) =>
  Inventory.findOneAndUpdate(
    {
      ...printedFilter(productId, designCode),
      quantity: { $gte: quantity },
      $expr: { $gte: [{ $ifNull: ['$activeBarcodeCount', 0] }, quantity] },
    },
    { $inc: { quantity: -quantity, activeBarcodeCount: -quantity } },
    { new: true, ...(session ? { session } : {}) }
  );

module.exports = {
  addRawStock,
  deductRawStock,
  addPrintedStock,
  deductPrintedStock,
  reserveBarcodeLabels,
  deductPrintedStockForBarcode,
  rawFilter,
  printedFilter,
};
