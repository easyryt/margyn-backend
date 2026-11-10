const {load}=require("../support/inventory-source-loader.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calculateBarcodeGenerationCount,
  assertExactBarcodeBatch,
  assertExactPrintingJobBarcodeBatch,
} = load("services/barcode-generation.service");

test("a print quantity of 10 produces 10 labels", () => {
  assert.equal(calculateBarcodeGenerationCount(10, 0), 10);
});

test("packed labels never reduce the next printed batch", () => {
  // Print 10 and create 10 labels.
  let printedQuantity = 10;
  let availableBarcodeCount = 0;
  const firstBatch = calculateBarcodeGenerationCount(
    printedQuantity,
    availableBarcodeCount,
  );
  assert.equal(firstBatch, 10);

  availableBarcodeCount += firstBatch;

  // Pack 3 units: both PRINTED stock and AVAILABLE labels drop by 3.
  printedQuantity -= 3;
  availableBarcodeCount -= 3;

  // Print 10 more units. The second barcode batch must be 10, not 7.
  printedQuantity += 10;
  assert.equal(
    calculateBarcodeGenerationCount(
      printedQuantity,
      availableBarcodeCount,
    ),
    10,
  );
});

test("only currently available labels count against printed stock", () => {
  assert.equal(calculateBarcodeGenerationCount(17, 7), 10);
  assert.equal(calculateBarcodeGenerationCount(10, 3), 7);
});

test("fractional or invalid quantities are rejected instead of rounded down", () => {
  assert.throws(
    () => calculateBarcodeGenerationCount(10.5, 0),
    /printedQuantity must be a non-negative whole number/,
  );
  assert.throws(
    () => calculateBarcodeGenerationCount(10, 2.5),
    /availableBarcodeCount must be a non-negative whole number/,
  );
});

test("a partial batch fails the integrity check", () => {
  assert.doesNotThrow(() => assertExactBarcodeBatch([{}, {}], 2));
  assert.throws(
    () => assertExactBarcodeBatch([{}, {}], 3),
    /expected 3, created 2/,
  );
});

test("a printing job batch must contain the complete ordered 1..N label set", () => {
  const jobId = "printing-job-1";
  const batchId = "BATCH-1";
  const labels = [1, 2, 3].map((labelSequence) => ({
    printingJobId: jobId,
    generationBatchId: batchId,
    labelSequence,
  }));

  assert.doesNotThrow(() =>
    assertExactPrintingJobBarcodeBatch(
      labels,
      3,
      jobId,
      batchId,
    ),
  );

  assert.throws(
    () =>
      assertExactPrintingJobBarcodeBatch(
        [labels[0], labels[2], { ...labels[2], labelSequence: 4 }],
        3,
        jobId,
        batchId,
      ),
    /label sequence is incomplete/,
  );
});
