const {load}=require("../support/inventory-source-loader.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const Inventory = load("models/Inventory");
const PrintingJob = load("models/PrintingJob");

const id = () => new mongoose.Types.ObjectId();

test("PRINTED inventory rejects fractional quantities", async () => {
  const inventory = new Inventory({
    productId: id(),
    type: "PRINTED",
    designCode: "TEST-DESIGN",
    quantity: 10.5,
  });

  await assert.rejects(
    inventory.validate(),
    /quantity must be a whole number/,
  );
});

test("valid inventory validation does not call a nonexistent next callback", async () => {
  const inventory = new Inventory({
    productId: id(),
    type: "PRINTED",
    designCode: "TEST-DESIGN",
    quantity: 10,
    pendingBarcodeQuantity: 10,
  });

  await assert.doesNotReject(inventory.validate());
});

test("printing jobs reject fractional quantities", async () => {
  const printingJob = new PrintingJob({
    categoryId: id(),
    productId: id(),
    designId: id(),
    designCode: "TEST-DESIGN",
    quantity: 7.1,
  });

  await assert.rejects(
    printingJob.validate(),
    /quantity must be a whole number/,
  );
});
