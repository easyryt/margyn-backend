const {load}=require("../support/inventory-source-loader.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const Barcode = load("models/Barcode");
const Inventory = load("models/Inventory");
const { scanBarcode } = load("controllers/packing.controller");

const objectId = () => new mongoose.Types.ObjectId().toString();

test("scanning a barcode never consumes a later printing job's exact queue", async (t) => {
  const original = {
    startSession: mongoose.startSession,
    updateBarcode: Barcode.findOneAndUpdate,
    updateInventory: Inventory.findOneAndUpdate,
    countBarcodes: Barcode.countDocuments,
  };

  t.after(() => {
    mongoose.startSession = original.startSession;
    Barcode.findOneAndUpdate = original.updateBarcode;
    Inventory.findOneAndUpdate = original.updateInventory;
    Barcode.countDocuments = original.countBarcodes;
  });

  const productId = objectId();
  const inventoryId = objectId();
  const inventoryUpdates = [];

  mongoose.startSession = async () => ({
    withTransaction: async (work) => work(),
    endSession: async () => {},
  });
  Barcode.findOneAndUpdate = async () => ({
    _id: objectId(),
    code: "PR-TEST-1",
    productId,
    designCode: "TEST-DESIGN",
    status: "USED",
    usedAt: new Date(),
  });
  Barcode.countDocuments = () => ({ session: async () => 7 });
  Inventory.findOneAndUpdate = async (_filter, update) => {
    inventoryUpdates.push(update);

    if (inventoryUpdates.length === 1) {
      return {
        _id: inventoryId,
        productId,
        designCode: "TEST-DESIGN",
        quantity: 210,
        pendingBarcodeQuantity: 100,
      };
    }

    return {
      _id: inventoryId,
      productId,
      designCode: "TEST-DESIGN",
      quantity: 210,
      pendingBarcodeQuantity: 100,
      ...update.$set,
    };
  };

  const res = {
    status: (code) => {
      res.statusCode = code;
      return res;
    },
    json: (body) => {
      res.body = body;
      return body;
    },
  };

  await scanBarcode({ body: { code: "PR-TEST-1" } }, res);

  assert.equal(res.statusCode, undefined);
  assert.equal(res.body.inventory.quantity, 210);
  assert.deepEqual(inventoryUpdates[0], {
    $inc: { quantity: -1 },
  });
  assert.deepEqual(inventoryUpdates[1].$set, {
    activeBarcodeCount: 7,
    unbarcodedQuantity: 203,
  });
  assert.equal(
    Object.hasOwn(inventoryUpdates[1].$set, "pendingBarcodeQuantity"),
    false,
  );
});
