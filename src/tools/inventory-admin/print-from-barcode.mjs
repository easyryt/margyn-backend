import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { AppError } from "../../services/errors.mjs";
import mongoose from "./mongoose-context.mjs";

const require = createRequire(import.meta.url);
const Barcode = require("./original/src/models/Barcode.js");
const Inventory = require("./original/src/models/Inventory.js");
const PrintingJob = require("./original/src/models/PrintingJob.js");
const Product = require("./original/src/models/Product.js");
const ProductDesign = require("./original/src/models/ProductDesign.js");
const { addPrintedStock, deductRawStock, printedFilter, rawFilter } = require("./original/src/services/inventory.service.js");

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export async function markBarcodePrinted(req, res) {
  const { code, operationId } = req.body ?? {};
  if (typeof code !== "string" || !code.trim() || code.length > 256 || typeof operationId !== "string" || !uuid.test(operationId)) {
    throw new AppError("A valid barcode and confirmation ID are required.", 400);
  }

  // Store the confirmation in the same transaction as the stock movement.
  const jobId = createHash("sha256").update("scanner-print:" + operationId.toLowerCase()).digest("hex").slice(0, 24);
  const label = code.trim();
  const receipt = `Marked printed from barcode ${label}`;
  const session = await mongoose.startSession();
  try {
    const counts = await session.withTransaction(async () => {
      const previous = await PrintingJob.findById(jobId).session(session).lean();
      if (previous) {
        if (previous.notes !== receipt) throw new AppError("This confirmation belongs to another barcode.", 409);
        const raw = await Inventory.findOne(rawFilter(previous.productId)).session(session);
        const printed = await Inventory.findOne(printedFilter(previous.productId, previous.designCode)).session(session);
        return { rawQuantity: raw?.quantity ?? 0, printedQuantity: printed?.quantity ?? 0 };
      }

      const barcode = await Barcode.findOne({ code: label }).session(session).lean();
      if (!barcode) throw new AppError("No product matches this barcode.", 404);
      if (barcode.status === "USED") throw new AppError("This label was already packed. Use an available label for the design.", 409);
      const product = await Product.findOne({ _id: barcode.productId, isActive: true }).session(session).lean();
      const design = await ProductDesign.findOne({ productId: barcode.productId, designCode: barcode.designCode, isActive: true }).session(session).lean();
      if (!product || !design) throw new AppError("This barcode no longer matches an active product and design.", 409);

      const raw = await deductRawStock(product._id, 1, session);
      if (!raw) throw new AppError("There’s no raw stock to move for this product.", 409);
      const printed = await addPrintedStock(product._id, design.designCode, 1, session);
      await PrintingJob.create([{
        _id: jobId,
        categoryId: product.categoryId,
        productId: product._id,
        designId: design._id,
        designCode: design.designCode,
        quantity: 1,
        status: "COMPLETED",
        inventoryAdded: true,
        barcodeGenerationStatus: "PENDING",
        barcodeExpectedCount: 1,
        notes: receipt,
        createdBy: req.inventoryIdentity.id,
      }], { session });
      return { rawQuantity: raw.quantity, printedQuantity: printed.quantity };
    });
    res.json(counts);
  } finally {
    await session.endSession();
  }
}
