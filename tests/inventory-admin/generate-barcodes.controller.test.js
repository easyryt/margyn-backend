const {load}=require("../support/inventory-source-loader.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const Barcode = load("models/Barcode");
const Inventory = load("models/Inventory");
const ProductDesign = load("models/ProductDesign");
const PrintingJob = load("models/PrintingJob");
const {
  generateBarcodes,
} = load("controllers/barcode.controller");

const objectId = () => new mongoose.Types.ObjectId().toString();

const makeResponse = () => {
  const response = {};

  response.status = (code) => {
    response.statusCode = code;
    return response;
  };

  response.json = (body) => {
    response.body = body;
    return body;
  };

  return response;
};

const installCommonMocks = (t) => {
  const original = {
    startSession: mongoose.startSession,
    findDesign: ProductDesign.findOne,
    findInventory: Inventory.findOne,
    updateInventory: Inventory.findOneAndUpdate,
    findJob: PrintingJob.findOne,
    findJobs: PrintingJob.find,
    findJobById: PrintingJob.findById,
    claimJob: PrintingJob.findOneAndUpdate,
    countBarcodes: Barcode.countDocuments,
    findBarcodes: Barcode.find,
    insertBarcodes: Barcode.insertMany,
  };

  t.after(() => {
    mongoose.startSession = original.startSession;
    ProductDesign.findOne = original.findDesign;
    Inventory.findOne = original.findInventory;
    Inventory.findOneAndUpdate = original.updateInventory;
    PrintingJob.findOne = original.findJob;
    PrintingJob.find = original.findJobs;
    PrintingJob.findById = original.findJobById;
    PrintingJob.findOneAndUpdate = original.claimJob;
    Barcode.countDocuments = original.countBarcodes;
    Barcode.find = original.findBarcodes;
    Barcode.insertMany = original.insertBarcodes;
  });

  mongoose.startSession = async () => ({
    withTransaction: async (work) => work(),
    endSession: async () => {},
  });
};

test("a completed 100-unit job creates exactly 100 labels despite 222 old available labels", async (t) => {
  installCommonMocks(t);

  const productId = objectId();
  const designId = objectId();
  const jobId = objectId();
  const inventoryId = objectId();
  const generated = [];
  let availableCountCalls = 0;
  let inventoryUpdate;
  let jobClaimFilter;

  const inventory = {
    _id: inventoryId,
    quantity: 310,
    unbarcodedQuantity: 100,
    pendingBarcodeQuantity: 100,
    activeBarcodeCount: 222,
  };
  const job = {
    _id: jobId,
    productId,
    designId,
    designCode: "TEST-DESIGN",
    quantity: 100,
    status: "COMPLETED",
    inventoryAdded: true,
    barcodeGenerationStatus: "PENDING",
    barcodeExpectedCount: 100,
    barcodeGeneratedCount: 0,
    save: async () => job,
  };

  PrintingJob.findById = () => ({
    select: () => ({
      lean: async () => ({ productId, designId }),
    }),
  });
  ProductDesign.findOne = () => ({
    lean: async () => ({
      _id: designId,
      name: "Test design",
      mode: "TEST",
      designCode: "TEST-DESIGN",
    }),
  });
  Inventory.findOne = () => ({
    session: async () => inventory,
  });
  PrintingJob.findOne = () => ({
    session: async () => job,
  });
  PrintingJob.findOneAndUpdate = async (filter) => {
    jobClaimFilter = filter;
    job.barcodeGenerationStatus = "GENERATING";
    return job;
  };
  Barcode.countDocuments = (filter) => ({
    session: async () => {
      if (filter.status === "AVAILABLE") {
        availableCountCalls += 1;
        return availableCountCalls === 1 ? 222 : 322;
      }
      throw new Error(`Unexpected barcode count filter: ${JSON.stringify(filter)}`);
    },
  });
  Barcode.insertMany = async (documents) => {
    generated.push(...documents);
    return documents.map((document) => ({
      _id: objectId(),
      ...document,
    }));
  };
  Barcode.find = () => ({
    sort: () => ({
      session: async () => generated.map((document) => ({
        _id: objectId(),
        ...document,
      })),
    }),
  });
  Inventory.findOneAndUpdate = async (_filter, update) => {
    inventoryUpdate = update;
    return { ...inventory, ...update.$set };
  };

  const res = makeResponse();
  await generateBarcodes({ body: { printingJobId: jobId } }, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.barcodes.length, 100);
  assert.equal(res.body.barcodeCount, 100);
  assert.equal(res.body.generation.requestedBarcodeCount, 100);
  assert.equal(res.body.generation.persistedBarcodeCount, 100);
  assert.equal(res.body.generation.source, "PRINTING_JOB");
  assert.equal(String(res.body.generation.printingJobId), jobId);
  assert.equal(generated.length, 100);
  assert.deepEqual(
    generated.map((barcode) => barcode.labelSequence),
    Array.from({ length: 100 }, (_value, index) => index + 1),
  );
  assert.ok(generated.every((barcode) => barcode.printingJobId === jobId));
  assert.equal(job.barcodeGenerationStatus, "GENERATED");
  assert.equal(job.barcodeGeneratedCount, 100);
  assert.deepEqual(jobClaimFilter, {
    _id: jobId,
    status: "COMPLETED",
    inventoryAdded: true,
    barcodeGenerationStatus: "PENDING",
  });
  assert.deepEqual(inventoryUpdate.$set, {
    activeBarcodeCount: 322,
    pendingBarcodeQuantity: 0,
    unbarcodedQuantity: 0,
  });
});

test("retrying a generated printing job returns the same complete 100-label batch", async (t) => {
  installCommonMocks(t);

  const productId = objectId();
  const designId = objectId();
  const jobId = objectId();
  const inventoryId = objectId();
  const batchId = "BATCH-RETRY-100";
  const generatedAt = new Date("2026-08-28T00:00:00.000Z");
  const existingBatch = Array.from({ length: 100 }, (_value, index) => ({
    _id: objectId(),
    code: `PR-TEST-${index + 1}`,
    productId,
    designCode: "TEST-DESIGN",
    printingJobId: jobId,
    labelSequence: index + 1,
    generationBatchId: batchId,
    generatedAt,
    status: index < 5 ? "USED" : "AVAILABLE",
  }));
  const job = {
    _id: jobId,
    productId,
    designId,
    designCode: "TEST-DESIGN",
    quantity: 100,
    status: "COMPLETED",
    inventoryAdded: true,
    barcodeGenerationStatus: "GENERATED",
    barcodeGenerationBatchId: batchId,
    barcodeExpectedCount: 100,
    barcodeGeneratedCount: 100,
    barcodeGeneratedAt: generatedAt,
  };

  PrintingJob.findById = () => ({
    select: () => ({
      lean: async () => ({ productId, designId }),
    }),
  });
  ProductDesign.findOne = () => ({
    lean: async () => ({
      _id: designId,
      name: "Test design",
      mode: "TEST",
      designCode: "TEST-DESIGN",
    }),
  });
  Inventory.findOne = () => ({
    session: async () => ({
      _id: inventoryId,
      quantity: 0,
      unbarcodedQuantity: 0,
      pendingBarcodeQuantity: 0,
      activeBarcodeCount: 95,
    }),
  });
  PrintingJob.findOne = () => ({
    session: async () => job,
  });
  Barcode.countDocuments = () => ({ session: async () => 95 });
  Barcode.find = () => ({
    sort: () => ({ session: async () => existingBatch }),
  });
  Barcode.insertMany = async () => {
    throw new Error("A generated job must never insert a second barcode batch");
  };
  Inventory.findOneAndUpdate = async () => {
    throw new Error("A generated job retry must not update inventory");
  };

  const res = makeResponse();
  await generateBarcodes({ body: { printingJobId: jobId } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.barcodes.length, 100);
  assert.equal(res.body.generation.batchId, batchId);
  assert.equal(res.body.generation.source, "PRINTING_JOB_RETRY");
  assert.equal(res.body.generation.reusedExistingBatch, true);
});

test("a queue-backed direct transfer still generates its full exact 10-label quantity", async (t) => {
  installCommonMocks(t);

  const productId = objectId();
  const designId = objectId();
  const inventoryId = objectId();
  const generated = [];
  let availableCountCalls = 0;

  ProductDesign.findOne = () => ({
    lean: async () => ({
      _id: designId,
      name: "Test design",
      mode: "TEST",
      designCode: "TEST-DESIGN",
    }),
  });
  Inventory.findOne = () => ({
    session: async () => ({
      _id: inventoryId,
      quantity: 10,
      unbarcodedQuantity: 10,
      pendingBarcodeQuantity: 10,
      activeBarcodeCount: 0,
    }),
  });
  PrintingJob.find = () => ({
    sort: () => ({
      limit: () => ({ session: async () => [] }),
    }),
  });
  Barcode.countDocuments = (filter) => ({
    session: async () => {
      if (filter.status === "AVAILABLE") {
        availableCountCalls += 1;
        return availableCountCalls === 1 ? 0 : 10;
      }
      return generated.length;
    },
  });
  Barcode.insertMany = async (documents) => {
    generated.push(...documents);
    return documents.map((document) => ({ _id: objectId(), ...document }));
  };
  Inventory.findOneAndUpdate = async (_filter, update) => ({
    _id: inventoryId,
    quantity: 10,
    ...update.$set,
  });

  const res = makeResponse();
  await generateBarcodes({ body: { productId, designId } }, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.barcodes.length, 10);
  assert.equal(res.body.generation.source, "PRINT_QUEUE");
  assert.equal(res.body.generation.requestedBarcodeCount, 10);
  assert.equal(res.body.generation.persistedBarcodeCount, 10);
});

test("generic generation never guesses which completed printing job to use", async (t) => {
  installCommonMocks(t);

  const productId = objectId();
  const designId = objectId();

  ProductDesign.findOne = () => ({
    lean: async () => ({
      _id: designId,
      name: "Test design",
      mode: "TEST",
      designCode: "TEST-DESIGN",
    }),
  });
  Inventory.findOne = () => ({
    session: async () => ({
      _id: objectId(),
      quantity: 100,
      pendingBarcodeQuantity: 100,
    }),
  });
  Barcode.countDocuments = () => ({ session: async () => 0 });
  PrintingJob.find = () => ({
    sort: () => ({
      limit: () => ({
        session: async () => [
          { _id: objectId(), barcodeGenerationStatus: "PENDING" },
          { _id: objectId(), barcodeGenerationStatus: "PENDING" },
        ],
      }),
    }),
  });

  const res = makeResponse();
  await generateBarcodes({ body: { productId, designId } }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(
    res.body.message,
    "printingJobId is required when multiple completed printing jobs are pending",
  );
});
