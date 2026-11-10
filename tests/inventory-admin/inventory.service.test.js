const {load}=require("../support/inventory-source-loader.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");

const Inventory = load("models/Inventory");
const { addPrintedStock } = load("services/inventory.service");

test("adding printed stock normalizes a legacy null barcode queue before incrementing it", async (t) => {
  const original = {
    updateOne: Inventory.updateOne,
    findOneAndUpdate: Inventory.findOneAndUpdate,
  };

  t.after(() => {
    Inventory.updateOne = original.updateOne;
    Inventory.findOneAndUpdate = original.findOneAndUpdate;
  });

  const calls = [];
  const session = { id: "session" };

  Inventory.updateOne = async (...args) => {
    calls.push({ operation: "normalize", args });
    return { acknowledged: true };
  };
  Inventory.findOneAndUpdate = async (...args) => {
    calls.push({ operation: "increment", args });
    return { quantity: 10, pendingBarcodeQuantity: 10 };
  };

  await addPrintedStock("product-1", "DESIGN-1", 10, session);

  assert.deepEqual(calls[0], {
    operation: "normalize",
    args: [
      {
        productId: "product-1",
        type: "PRINTED",
        designCode: "DESIGN-1",
        pendingBarcodeQuantity: null,
      },
      { $set: { pendingBarcodeQuantity: 0 } },
      { session },
    ],
  });
  assert.deepEqual(calls[1].args[1].$inc, {
    quantity: 10,
    unbarcodedQuantity: 10,
    pendingBarcodeQuantity: 10,
  });
});
