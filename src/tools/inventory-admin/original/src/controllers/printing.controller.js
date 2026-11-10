const mongoose = require("../../../mongoose-context.cjs");
const PrintingJob = require("../models/PrintingJob");
const ProductDesign = require("../models/ProductDesign");
const { deductRawStock, addPrintedStock } = require("../services/inventory.service");

const VALID_STATUSES = ["PENDING", "COMPLETED", "CANCELLED"];

const isPositiveWholeNumber = (value) =>
  Number.isSafeInteger(Number(value)) && Number(value) > 0;

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

/**
 * Move stock from the single product-level RAW row to one design-level
 * PRINTED row. It must be called in a transaction.
 */
const applyCompletedJobInventory = async (printingJob, session) => {
  const rawInventory = await deductRawStock(
    printingJob.productId,
    printingJob.quantity,
    session,
  );

  if (!rawInventory) {
    throw new Error("Insufficient RAW inventory for this printing job");
  }

  const printedInventory = await addPrintedStock(
    printingJob.productId,
    printingJob.designCode,
    printingJob.quantity,
    session,
  );

  printingJob.inventoryAdded = true;
  printingJob.barcodeGenerationStatus = "PENDING";
  printingJob.barcodeGenerationBatchId = null;
  printingJob.barcodeExpectedCount = printingJob.quantity;
  printingJob.barcodeGeneratedCount = 0;
  printingJob.barcodeGeneratedAt = null;
  await printingJob.save({ session });

  return { rawInventory, printedInventory };
};

// POST /api/printing-jobs
// PENDING jobs are history only. A job created as COMPLETED is transferred
// immediately from RAW to PRINTED in the same transaction.
const createPrintingJob = async (req, res) => {
  let session;
  try {
    const {
      categoryId,
      productId,
      designId,
      quantity,
      status = "PENDING",
      notes = "",
      minThreshold,
    } = req.body;

    if (!isObjectId(categoryId) || !isObjectId(productId) || !isObjectId(designId)) {
      return res.status(400).json({
        message: "Valid categoryId, productId and designId are required",
      });
    }
    if (!isPositiveWholeNumber(quantity)) {
      return res.status(400).json({
        message: "quantity must be a positive whole number",
      });
    }
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    let threshold = 0;
    if (minThreshold !== undefined) {
      threshold = Number(minThreshold);
      if (!Number.isSafeInteger(threshold) || threshold < 0) {
        return res.status(400).json({
          message: "minThreshold must be a non-negative whole number",
        });
      }
    }

    const design = await ProductDesign.findOne({
      _id: designId,
      productId,
      isActive: true,
    })
      .select("designCode")
      .lean();

    if (!design) {
      return res.status(400).json({
        message: "Selected model/design is invalid for this product",
      });
    }

    session = await mongoose.startSession();
    let printingJob;
    let inventory = null;

    await session.withTransaction(async () => {
      [printingJob] = await PrintingJob.create(
        [
          {
            categoryId,
            productId,
            designId,
            designCode: design.designCode,
            quantity: Number(quantity),
            status,
            notes,
            inventoryAdded: false,
            barcodeGenerationStatus:
              status === "COMPLETED"
                ? "PENDING"
                : "NOT_READY",
            barcodeExpectedCount:
              Number(quantity),
            barcodeGeneratedCount: 0,
            minThreshold: threshold,
            createdBy: req.user?.id,
          },
        ],
        { session },
      );

      if (status === "COMPLETED") {
        inventory = await applyCompletedJobInventory(printingJob, session);
      }
    });

    return res.status(201).json({
      message:
        status === "COMPLETED"
          ? "Printing completed: RAW stock deducted and PRINTED stock added"
          : "Printing job created successfully",
      printingJob,
      inventory,
      barcodeGeneration: printingJob.inventoryAdded
        ? {
            expectedCount: printingJob.barcodeExpectedCount,
            status: printingJob.barcodeGenerationStatus,
            endpoint: `/api/printing-jobs/${printingJob._id}/barcodes`,
          }
        : null,
    });
  } catch (err) {
    if (err.message === "Insufficient RAW inventory for this printing job") {
      return res.status(400).json({ message: err.message });
    }
    console.error("Create printing job error:", err);
    return res.status(500).json({ message: "Server error" });
  } finally {
    if (session) await session.endSession();
  }
};

// GET /api/printing-jobs
const listPrintingJobs = async (req, res) => {
  try {
    const printingJobs = await PrintingJob.find()
      .populate({
        path: "productId",
        select: "name skuBase categoryId",
        populate: { path: "categoryId", select: "name" },
      })
      .populate("designId", "name mode designCode")
      .populate("createdBy", "name email")
      .sort({ createdAt: -1 });

    return res.json({ printingJobs });
  } catch (err) {
    console.error("List printing jobs error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// GET /api/printing-jobs/:id
const getPrintingJobById = async (req, res) => {
  try {
    const printingJob = await PrintingJob.findById(req.params.id)
      .populate({
        path: "productId",
        select: "name skuBase categoryId",
        populate: { path: "categoryId", select: "name" },
      })
      .populate("designId", "name mode designCode")
      .populate("createdBy", "name email");

    if (!printingJob) {
      return res.status(404).json({ message: "Printing job not found" });
    }
    return res.json({ printingJob });
  } catch (err) {
    console.error("Get printing job error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// PUT /api/printing-jobs/:id
// A PENDING job moves inventory only once when it becomes COMPLETED.
const updatePrintingJob = async (req, res) => {
  let session;
  try {
    const { status, notes, minThreshold } = req.body;
    if (status !== undefined && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    session = await mongoose.startSession();
    let printingJob;
    let inventory = null;

    await session.withTransaction(async () => {
      printingJob = await PrintingJob.findById(req.params.id).session(session);
      if (!printingJob) throw new Error("Printing job not found");

      // Once stock has moved, do not permit a status change that would make
      // the job history disagree with real inventory.
      if (
        printingJob.inventoryAdded &&
        status !== undefined &&
        status !== "COMPLETED"
      ) {
        throw new Error("A completed printing job cannot be changed or cancelled");
      }

      if (notes !== undefined) printingJob.notes = notes;

      if (minThreshold !== undefined) {
        const threshold = Number(minThreshold);
        if (!Number.isSafeInteger(threshold) || threshold < 0) {
          throw new Error("minThreshold must be a non-negative whole number");
        }
        printingJob.minThreshold = threshold;
      }

      if (status === "COMPLETED" && !printingJob.inventoryAdded) {
        printingJob.status = "COMPLETED";
        inventory = await applyCompletedJobInventory(printingJob, session);
      } else if (status !== undefined) {
        printingJob.status = status;
        await printingJob.save({ session });
      } else {
        await printingJob.save({ session });
      }
    });

    return res.json({
      message: inventory
        ? "Printing completed: RAW stock deducted and PRINTED stock added"
        : "Printing job updated successfully",
      printingJob,
      inventory,
      barcodeGeneration: printingJob.inventoryAdded
        ? {
            expectedCount: printingJob.barcodeExpectedCount,
            status: printingJob.barcodeGenerationStatus,
            endpoint: `/api/printing-jobs/${printingJob._id}/barcodes`,
          }
        : null,
    });
  } catch (err) {
    if (
      err.message === "Printing job not found" ||
      err.message === "Insufficient RAW inventory for this printing job" ||
      err.message.includes("cannot be changed") ||
      err.message.includes("minThreshold")
    ) {
      return res.status(err.message === "Printing job not found" ? 404 : 400).json({
        message: err.message,
      });
    }
    console.error("Update printing job error:", err);
    return res.status(500).json({ message: "Server error" });
  } finally {
    if (session) await session.endSession();
  }
};

// DELETE /api/printing-jobs/:id
// Do not delete an inventory-applied job; it is an audit record for the move.
const deletePrintingJob = async (req, res) => {
  try {
    const printingJob = await PrintingJob.findById(req.params.id);
    if (!printingJob) {
      return res.status(404).json({ message: "Printing job not found" });
    }
    if (printingJob.inventoryAdded) {
      return res.status(400).json({
        message: "Completed printing jobs cannot be deleted because inventory was moved",
      });
    }

    await printingJob.deleteOne();
    return res.json({ message: "Printing job deleted successfully" });
  } catch (err) {
    console.error("Delete printing job error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// GET /api/printing-jobs/designs/:productId
const getPrintedDesignsByProduct = async (req, res) => {
  try {
    const designs = await ProductDesign.find({
      productId: req.params.productId,
      isActive: true,
    }).select("name mode designCode designUrl notes");

    return res.json({ designs });
  } catch (err) {
    console.error("Get product designs error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  createPrintingJob,
  listPrintingJobs,
  getPrintingJobById,
  updatePrintingJob,
  deletePrintingJob,
  getPrintedDesignsByProduct,
};
