const asNonNegativeWholeNumber = (value, fieldName) => {
  const number = Number(value);

  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${fieldName} must be a non-negative whole number`);
  }

  return number;
};

/**
 * Computes the legacy/cache count of PRINTED units not covered by AVAILABLE
 * labels. It is useful after scans and status changes, but it must never be
 * used to choose the size of a new PrintingJob barcode batch.
 */
const calculateBarcodeGenerationCount = (
  printedQuantity,
  availableBarcodeCount,
) => {
  const printed = asNonNegativeWholeNumber(
    printedQuantity,
    "printedQuantity",
  );
  const available = asNonNegativeWholeNumber(
    availableBarcodeCount,
    "availableBarcodeCount",
  );

  return Math.max(0, printed - available);
};

const assertExactBarcodeBatch = (barcodes, expectedCount) => {
  const expected = asNonNegativeWholeNumber(
    expectedCount,
    "expectedCount",
  );

  if (!Array.isArray(barcodes) || barcodes.length !== expected) {
    throw new Error(
      `Barcode generation integrity check failed: expected ${expected}, created ${
        Array.isArray(barcodes) ? barcodes.length : 0
      }`,
    );
  }
};

/**
 * A printing job is an immutable label batch. Count alone is not enough when
 * returning a previous request: verify that the labels are the exact ordered
 * 1..N set belonging to that job and generation batch.
 */
const assertExactPrintingJobBarcodeBatch = (
  barcodes,
  expectedCount,
  printingJobId,
  generationBatchId,
) => {
  assertExactBarcodeBatch(barcodes, expectedCount);

  if (
    typeof generationBatchId !== "string" ||
    generationBatchId.trim() === ""
  ) {
    throw new Error(
      "Printing job barcode integrity check failed: generation batch ID is missing",
    );
  }

  const expectedJobId = String(printingJobId);

  barcodes.forEach((barcode, index) => {
    if (String(barcode.printingJobId) !== expectedJobId) {
      throw new Error(
        "Printing job barcode integrity check failed: barcode belongs to another printing job",
      );
    }

    if (barcode.generationBatchId !== generationBatchId) {
      throw new Error(
        "Printing job barcode integrity check failed: barcode belongs to another generation batch",
      );
    }

    if (Number(barcode.labelSequence) !== index + 1) {
      throw new Error(
        "Printing job barcode integrity check failed: label sequence is incomplete",
      );
    }
  });
};

module.exports = {
  asNonNegativeWholeNumber,
  calculateBarcodeGenerationCount,
  assertExactBarcodeBatch,
  assertExactPrintingJobBarcodeBatch,
};
