const crypto = require("crypto");
const mongoose = require("../../../mongoose-context.cjs");

const Barcode = require("../models/Barcode");
const Inventory = require("../models/Inventory");
const Product = require("../models/Product");
const ProductDesign = require("../models/ProductDesign");
const PrintingJob = require("../models/PrintingJob");
const {
  calculateBarcodeGenerationCount,
  assertExactBarcodeBatch,
  assertExactPrintingJobBarcodeBatch,
} = require("../services/barcode-generation.service");

/* -------------------------------------------------------------------------- */
/* Barcode code                                                               */
/* -------------------------------------------------------------------------- */

const makeBarcodeCode = (designCode) => {
  const clean = String(designCode)
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .toUpperCase();

  return `PR-${clean}-${crypto
    .randomUUID()
    .replace(/-/g, "")
    .slice(0, 20)
    .toUpperCase()}`;
};

const makeBarcodeDocuments = ({
  count,
  productId,
  designCode,
  generationBatchId,
  generatedAt,
  printingJobId = null,
}) => {
  const barcodes = [];
  const generatedCodes = new Set();

  while (barcodes.length < count) {
    const code = makeBarcodeCode(designCode);

    // A UUID collision is already extraordinarily unlikely. This check also
    // makes it impossible for one request to contain a duplicate code.
    if (generatedCodes.has(code)) {
      continue;
    }

    generatedCodes.add(code);
    barcodes.push({
      code,
      productId,
      designCode,
      generationBatchId,
      generatedAt,
      printingJobId,
      labelSequence:
        printingJobId
          ? barcodes.length + 1
          : null,
      status: "AVAILABLE",
      usedAt: null,
    });
  }

  return barcodes;
};

/* -------------------------------------------------------------------------- */
/* Generation batch ID                                                        */
/* -------------------------------------------------------------------------- */

const makeGenerationBatchId = () => {
  return `BATCH-${crypto
    .randomUUID()
    .replace(/-/g, "")
    .slice(0, 16)
    .toUpperCase()}`;
};

/* -------------------------------------------------------------------------- */
/* Generate barcodes                                                          */
/* -------------------------------------------------------------------------- */
/*
 * IMPORTANT:
 *
 * A completed PrintingJob is the authoritative source for a new barcode
 * batch. A 100-unit job always creates labels 1..100 for that job, even if
 * old AVAILABLE or USED labels exist for the same design.
 *
 * Inventory's pendingBarcodeQuantity exists only for the older direct
 * RAW-to-PRINTED transfer route, which has no PrintingJob. It also records an
 * exact newly printed quantity; global AVAILABLE-label reconciliation is not
 * used to decide a new batch size.
 */

const generateBarcodes = async (req, res) => {
  let session;

  try {
    const {
      productId: requestedProductId,
      designId: requestedDesignId,
      printingJobId,
    } = req.body || {};

    let productId = requestedProductId;
    let designId = requestedDesignId;

    /* ---------------------------------------------------------------------- */
    /* Validation                                                             */
    /* ---------------------------------------------------------------------- */

    if (
      printingJobId &&
      !mongoose.Types.ObjectId.isValid(
        printingJobId,
      )
    ) {
      return res.status(400).json({
        message: "Invalid printingJobId",
      });
    }

    // A job route needs only the job ID. Always derive product/design on the
    // server, even when a client also supplied them, so mismatched IDs can
    // never generate labels for the wrong job.
    if (printingJobId) {
      const job = await PrintingJob.findById(
        printingJobId,
      )
        .select("productId designId")
        .lean();

      if (!job) {
        return res.status(404).json({
          message: "Printing job not found",
        });
      }

      productId = String(job.productId);
      designId = String(job.designId);
    }

    if (!productId || !designId) {
      return res.status(400).json({
        message:
          "productId and designId are required",
      });
    }

    if (
      !mongoose.Types.ObjectId.isValid(
        productId,
      )
    ) {
      return res.status(400).json({
        message: "Invalid productId",
      });
    }

    if (
      !mongoose.Types.ObjectId.isValid(
        designId,
      )
    ) {
      return res.status(400).json({
        message: "Invalid designId",
      });
    }

    /* ---------------------------------------------------------------------- */
    /* Validate design                                                        */
    /* ---------------------------------------------------------------------- */

    const design =
      await ProductDesign.findOne({
        _id: designId,
        productId,
        isActive: true,
      }).lean();

    if (!design) {
      return res.status(400).json({
        message:
          "Selected model/design does not belong to this product",
      });
    }

    /* ---------------------------------------------------------------------- */
    /* Start transaction                                                      */
    /* ---------------------------------------------------------------------- */

    session = await mongoose.startSession();

    let barcodes = [];
    let printedInventory = null;
    let requestedBarcodeCount = 0;
    let persistedBarcodeCount = 0;
    let printingJob = null;
    let generationSource = null;
    let reusedExistingBatch = false;
    let hasTrackedPrintQueue = false;
    let queuedPrintQuantity = 0;

    let generationBatchId =
      makeGenerationBatchId();

    /*
     * Every barcode generated by this request
     * gets the exact same generation timestamp.
     */
    let generatedAt = new Date();

    await session.withTransaction(async () => {
      /* -------------------------------------------------------------------- */
      /* Find PRINTED inventory                                               */
      /* -------------------------------------------------------------------- */

      printedInventory =
        await Inventory.findOne({
          productId,
          type: "PRINTED",
          designCode: design.designCode,
          isActive: true,
        }).session(session);

      if (!printedInventory) {
        throw new Error(
          "No PRINTED stock exists for this design",
        );
      }

      const printedQuantity = Number(
        printedInventory.quantity,
      );

      if (
        !Number.isSafeInteger(printedQuantity) ||
        printedQuantity < 0
      ) {
        throw new Error(
          "PRINTED stock quantity must be a non-negative whole number",
        );
      }

      /* -------------------------------------------------------------------- */
      /* Count currently available barcode labels                             */
      /* -------------------------------------------------------------------- */
      /*
       * USED labels belong to packed units. They must not be counted here,
       * otherwise later print jobs generate too few labels.
       */

      const existingAvailableBarcodeCount =
        await Barcode.countDocuments({
          productId,
          designCode:
            design.designCode,
          status: "AVAILABLE",
        }).session(session);

      /* -------------------------------------------------------------------- */
      /* Resolve one exact print batch                                        */
      /* -------------------------------------------------------------------- */

      hasTrackedPrintQueue =
        printedInventory.pendingBarcodeQuantity !== null &&
        printedInventory.pendingBarcodeQuantity !== undefined;

      if (hasTrackedPrintQueue) {
        queuedPrintQuantity = Number(
          printedInventory.pendingBarcodeQuantity,
        );

        if (
          !Number.isSafeInteger(queuedPrintQuantity) ||
          queuedPrintQuantity < 0
        ) {
          throw new Error(
            "Pending barcode quantity must be a non-negative whole number",
          );
        }
      }

      if (printingJobId) {
        printingJob = await PrintingJob.findOne({
          _id: printingJobId,
          productId,
          designId,
          designCode: design.designCode,
          status: "COMPLETED",
          inventoryAdded: true,
        }).session(session);

        if (!printingJob) {
          throw new Error(
            "Completed printing job not found for this product and design",
          );
        }
      } else {
        // Preserve the older product/design endpoint only when exactly one
        // job is waiting. With multiple completed jobs it is ambiguous, so
        // the caller must identify the job rather than risk the wrong count.
        const pendingPrintingJobs = await PrintingJob.find({
          productId,
          designId,
          designCode: design.designCode,
          status: "COMPLETED",
          inventoryAdded: true,
          barcodeGenerationStatus: "PENDING",
        })
          .sort({
            createdAt: -1,
            _id: -1,
          })
          .limit(2)
          .session(session);

        if (pendingPrintingJobs.length > 1) {
          throw new Error(
            "printingJobId is required when multiple completed printing jobs are pending",
          );
        }

        [printingJob] = pendingPrintingJobs;
      }

      let newBarcodeCount;

      if (printingJob) {
        if (
          printingJob.barcodeGenerationStatus ===
          "GENERATED"
        ) {
          const expectedBarcodeCount = Number(
            printingJob.barcodeExpectedCount ||
              printingJob.quantity,
          );

          generationBatchId =
            printingJob.barcodeGenerationBatchId;
          generatedAt =
            printingJob.barcodeGeneratedAt ||
            generatedAt;

          barcodes = await Barcode.find({
            printingJobId: printingJob._id,
          })
            .sort({
              labelSequence: 1,
              _id: 1,
            })
            .session(session);

          assertExactPrintingJobBarcodeBatch(
            barcodes,
            expectedBarcodeCount,
            printingJob._id,
            generationBatchId,
          );

          requestedBarcodeCount =
            expectedBarcodeCount;
          persistedBarcodeCount =
            barcodes.length;
          generationSource =
            "PRINTING_JOB_RETRY";
          reusedExistingBatch = true;
          return;
        }

        if (
          printingJob.barcodeGenerationStatus ===
          "GENERATING"
        ) {
          throw new Error(
            "Barcode generation is already in progress for this printing job",
          );
        }

        if (
          printingJob.barcodeGenerationStatus !==
          "PENDING"
        ) {
          throw new Error(
            "This printing job is not ready for barcode generation",
          );
        }

        newBarcodeCount = Number(
          printingJob.quantity,
        );

        if (
          !Number.isSafeInteger(newBarcodeCount) ||
          newBarcodeCount < 1
        ) {
          throw new Error(
            "Printing job quantity must be a positive whole number",
          );
        }

        if (
          hasTrackedPrintQueue &&
          queuedPrintQuantity < newBarcodeCount
        ) {
          throw new Error(
            "Pending barcode queue is inconsistent with this printing job",
          );
        }

        // Claim the job inside this transaction before creating any labels.
        // Competing requests either retry into GENERATED or return the same
        // completed batch; they never create a second partial batch.
        const claimedPrintingJob =
          await PrintingJob.findOneAndUpdate(
            {
              _id: printingJob._id,
              status: "COMPLETED",
              inventoryAdded: true,
              barcodeGenerationStatus: "PENDING",
            },
            {
              $set: {
                barcodeGenerationStatus: "GENERATING",
              },
            },
            {
              new: true,
              session,
            },
          );

        if (!claimedPrintingJob) {
          throw new Error(
            "Barcode generation is already in progress for this printing job",
          );
        }

        printingJob = claimedPrintingJob;
        generationSource = "PRINTING_JOB";
      } else {
        if (!hasTrackedPrintQueue || queuedPrintQuantity < 1) {
          throw new Error(
            "No exact barcode generation batch is pending for this design",
          );
        }

        if (queuedPrintQuantity > printedQuantity) {
          throw new Error(
            "Pending barcode quantity exceeds current PRINTED stock",
          );
        }

        newBarcodeCount = queuedPrintQuantity;
        generationSource = "PRINT_QUEUE";
      }

      requestedBarcodeCount = newBarcodeCount;

      if (newBarcodeCount <= 0) {
        throw new Error(
          "All PRINTED stock for this design already has barcodes",
        );
      }

      /* -------------------------------------------------------------------- */
      /* Create ONLY NEW barcode documents                                     */
      /* -------------------------------------------------------------------- */

      const barcodeDocuments = makeBarcodeDocuments({
        count: newBarcodeCount,
        productId,
        designCode: design.designCode,
        generationBatchId,
        generatedAt,
        printingJobId:
          printingJob?._id || null,
      });

      barcodes =
        await Barcode.insertMany(
          barcodeDocuments,
          {
            session,
            ordered: true,
          },
        );

      // `ordered: true` already makes insertion all-or-nothing. Keep an
      // explicit invariant as a final safeguard: never return a partial batch.
      assertExactBarcodeBatch(
        barcodes,
        newBarcodeCount,
      );

      if (printingJob) {
        const persistedJobBarcodes =
          await Barcode.find({
            printingJobId: printingJob._id,
          })
            .sort({
              labelSequence: 1,
              _id: 1,
            })
            .session(session);

        assertExactPrintingJobBarcodeBatch(
          persistedJobBarcodes,
          newBarcodeCount,
          printingJob._id,
          generationBatchId,
        );

        persistedBarcodeCount =
          persistedJobBarcodes.length;

        printingJob.barcodeGenerationStatus =
          "GENERATED";
        printingJob.barcodeGenerationBatchId =
          generationBatchId;
        printingJob.barcodeExpectedCount =
          newBarcodeCount;
        printingJob.barcodeGeneratedCount =
          persistedBarcodeCount;
        printingJob.barcodeGeneratedAt =
          generatedAt;
        await printingJob.save({ session });
      } else {
        persistedBarcodeCount =
          await Barcode.countDocuments({
            generationBatchId,
          }).session(session);

        if (persistedBarcodeCount !== newBarcodeCount) {
          throw new Error(
            `Barcode generation integrity check failed: expected ${newBarcodeCount}, persisted ${persistedBarcodeCount}`,
          );
        }
      }

      /* -------------------------------------------------------------------- */
      /* Recalculate AVAILABLE barcode count                                  */
      /* -------------------------------------------------------------------- */

      const availableBarcodeCount =
        await Barcode.countDocuments({
          productId,
          designCode:
            design.designCode,
          status: "AVAILABLE",
        }).session(session);

      if (
        availableBarcodeCount !==
        existingAvailableBarcodeCount +
          newBarcodeCount
      ) {
        throw new Error(
          "Barcode generation integrity check failed: available barcode count is inconsistent",
        );
      }

      /* -------------------------------------------------------------------- */
      /* Synchronize inventory                                                 */
      /* -------------------------------------------------------------------- */

      /*
       * `pendingBarcodeQuantity` is the exact new-print queue. It is never
       * derived from historical labels. `unbarcodedQuantity` remains a
       * compatibility/cache value for older clients.
       */
      const unbarcodedQuantity =
        Math.max(
          0,
          printedQuantity -
            availableBarcodeCount,
        );

      printedInventory =
        await Inventory.findOneAndUpdate(
          {
            _id:
              printedInventory._id,

            quantity:
              printedInventory.quantity,
          },
          {
            $set: {
              /*
               * Number of AVAILABLE barcode labels.
               */
            activeBarcodeCount:
              availableBarcodeCount,

              /*
               * Once this batch commits, its exact queued quantity is
               * consumed. Legacy inventory is marked queue-enabled as well.
               */
              pendingBarcodeQuantity:
                hasTrackedPrintQueue
                  ? queuedPrintQuantity -
                    newBarcodeCount
                  : 0,

              /*
               * Printed units still waiting
               * for barcode generation.
               */
              unbarcodedQuantity,
            },
          },
          {
            new: true,
            runValidators: true,
            session,
          },
        );

      if (!printedInventory) {
        throw new Error(
          "PRINTED inventory changed; please generate barcodes again",
        );
      }
    });

    /* ---------------------------------------------------------------------- */
    /* Response                                                               */
    /* ---------------------------------------------------------------------- */

    return res.status(
      reusedExistingBatch ? 200 : 201,
    ).json({
      message:
        reusedExistingBatch
          ? `${barcodes.length} barcode(s) returned from the existing batch`
          : `${barcodes.length} barcode(s) generated successfully`,

      generation: {
        batchId:
          generationBatchId,

        generatedAt,

        barcodeCount:
          barcodes.length,

        requestedBarcodeCount:
          requestedBarcodeCount,

        persistedBarcodeCount:
          persistedBarcodeCount,

        source:
          generationSource,

        printingJobId:
          printingJob?._id ||
          null,

        reusedExistingBatch,
      },

      design: {
        id: design._id,
        name: design.name,
        mode: design.mode,
        designCode:
          design.designCode,
      },

      printedInventory: {
        id:
          printedInventory._id,

        quantity:
          printedInventory.quantity,

        unbarcodedQuantity:
          printedInventory.unbarcodedQuantity,

        activeBarcodeCount:
          printedInventory.activeBarcodeCount,

        pendingBarcodeQuantity:
          printedInventory.pendingBarcodeQuantity,
      },

      barcodeCount:
        barcodes.length,

      barcodes,
    });
  } catch (error) {
    const clientErrors = [
      "No PRINTED stock exists for this design",
      "PRINTED stock quantity must be a non-negative whole number",
      "All PRINTED stock for this design already has barcodes",
      "PRINTED inventory changed; please generate barcodes again",
      "Pending barcode quantity must be a non-negative whole number",
      "Completed printing job not found for this product and design",
      "This printing job is not ready for barcode generation",
      "Printing job quantity must be a positive whole number",
      "No exact barcode generation batch is pending for this design",
      "Pending barcode quantity exceeds current PRINTED stock",
      "Pending barcode queue is inconsistent with this printing job",
    ];

    const conflictErrors = [
      "printingJobId is required when multiple completed printing jobs are pending",
      "Barcode generation is already in progress for this printing job",
    ];

    if (clientErrors.includes(error.message)) {
      return res.status(400).json({
        message: error.message,
      });
    }

    if (conflictErrors.includes(error.message)) {
      return res.status(409).json({
        message: error.message,
      });
    }

    console.error(
      "Generate barcodes error:",
      error,
    );

    return res.status(
      error.code === 11000
        ? 409
        : 500,
    ).json({
      message:
        error.code === 11000
          ? "A duplicate barcode was generated. Please try again."
          : "Server error",
    });
  } finally {
    if (session) {
      await session.endSession();
    }
  }
};

/* -------------------------------------------------------------------------- */
/* List barcodes by product                                                   */
/* -------------------------------------------------------------------------- */

const listBarcodesByProduct = async (
  req,
  res,
) => {
  try {
    const filter = {
      productId:
        req.params.productId,
    };

    if (req.query.designCode) {
      filter.designCode = String(
        req.query.designCode,
      ).trim();
    }

    if (req.query.generationBatchId) {
      filter.generationBatchId =
        String(
          req.query.generationBatchId,
        ).trim();
    }

    if (req.query.status) {
      const status = String(
        req.query.status,
      ).trim();

      if (
        !["AVAILABLE", "USED"].includes(
          status,
        )
      ) {
        return res.status(400).json({
          message:
            "status must be AVAILABLE or USED",
        });
      }

      filter.status = status;
    }

    /* -------------------------------------------------------------------- */
    /* Optional creation-date filter                                        */
    /* -------------------------------------------------------------------- */

    if (req.query.from || req.query.to) {
      filter.createdAt = {};

      if (req.query.from) {
        const from = new Date(
          `${req.query.from}T00:00:00.000`,
        );

        if (Number.isNaN(from.getTime())) {
          return res.status(400).json({
            message:
              "from must be YYYY-MM-DD",
          });
        }

        filter.createdAt.$gte = from;
      }

      if (req.query.to) {
        const to = new Date(
          `${req.query.to}T23:59:59.999`,
        );

        if (Number.isNaN(to.getTime())) {
          return res.status(400).json({
            message:
              "to must be YYYY-MM-DD",
          });
        }

        filter.createdAt.$lte = to;
      }
    }

    /* -------------------------------------------------------------------- */
    /* Get barcodes                                                          */
    /* -------------------------------------------------------------------- */

    const barcodes =
      await Barcode.find(
        filter,
      )
        .sort({
          createdAt: -1,
          _id: -1,
        })
        .lean();

    /* -------------------------------------------------------------------- */
    /* Group by design                                                       */
    /* -------------------------------------------------------------------- */

    const barcodesByDesign =
      barcodes.reduce(
        (
          result,
          barcode,
        ) => {
          const key =
            barcode.designCode ||
            "NO_DESIGN";

          if (!result[key]) {
            result[key] = [];
          }

          result[key].push(
            barcode,
          );

          return result;
        },
        {},
      );

    /* -------------------------------------------------------------------- */
    /* Group by generation batch                                             */
    /* -------------------------------------------------------------------- */

    const barcodesByBatch =
      barcodes.reduce(
        (
          result,
          barcode,
        ) => {
          /*
           * New barcode records have generationBatchId.
           *
           * Older barcode records may not have one.
           */
          const key =
            barcode.generationBatchId ||
            `LEGACY-${barcode.createdAt
              ? new Date(
                  barcode.createdAt,
                )
                  .toISOString()
                  .slice(0, 19)
              : "UNKNOWN"}`;

          if (!result[key]) {
            result[key] = [];
          }

          result[key].push(
            barcode,
          );

          return result;
        },
        {},
      );

    /* -------------------------------------------------------------------- */
    /* Generation batch summaries                                            */
    /* -------------------------------------------------------------------- */

    const generationBatches =
      Object.entries(
        barcodesByBatch,
      )
        .map(
          (
            [batchId, rows],
          ) => {
            const first =
              rows[0];

            const availableCount =
              rows.filter(
                (row) =>
                  row.status ===
                  "AVAILABLE",
              ).length;

            const usedCount =
              rows.filter(
                (row) =>
                  row.status ===
                  "USED",
              ).length;

            return {
              batchId,

              generatedAt:
                first?.generatedAt ||
                first?.createdAt ||
                null,

              barcodeCount:
                rows.length,

              availableCount,

              usedCount,

              barcodes:
                rows,
            };
          },
        )
        .sort(
          (a, b) => {
            const timeA =
              a.generatedAt
                ? new Date(
                    a.generatedAt,
                  ).getTime()
                : 0;

            const timeB =
              b.generatedAt
                ? new Date(
                    b.generatedAt,
                  ).getTime()
                : 0;

            return (
              timeB - timeA
            );
          },
        );

    return res.json({
      total:
        barcodes.length,

      barcodes,

      barcodesByDesign,

      generationBatches,
    });
  } catch (error) {
    console.error(
      "List barcodes error:",
      error,
    );

    return res.status(500).json({
      message: "Server error",
    });
  }
};

/* -------------------------------------------------------------------------- */
/* Update barcode status                                                      */
/* -------------------------------------------------------------------------- */

const updateBarcodeStatus = async (
  req,
  res,
) => {
  let session;

  try {
    const { status } = req.body;

    if (
      !["AVAILABLE", "USED"].includes(
        status,
      )
    ) {
      return res.status(400).json({
        message:
          "status must be AVAILABLE or USED",
      });
    }

    session =
      await mongoose.startSession();

    let updatedBarcode = null;

    await session.withTransaction(
      async () => {
        const barcode =
          await Barcode.findById(
            req.params.id,
          ).session(session);

        if (!barcode) {
          throw new Error(
            "Barcode not found",
          );
        }

        const previousStatus =
          barcode.status;

        if (previousStatus !== status) {
          const inventory = await Inventory.findOneAndUpdate(
            status === "USED"
              ? {
                  productId: barcode.productId,
                  type: "PRINTED",
                  designCode: barcode.designCode,
                  isActive: true,
                  quantity: { $gte: 1 },
                }
              : {
                  productId: barcode.productId,
                  type: "PRINTED",
                  designCode: barcode.designCode,
                  isActive: true,
                },
            {
              $inc: {
                // Marking a barcode USED is a packing action. Restoring it
                // to AVAILABLE reverses that packing action.
                quantity: status === "USED" ? -1 : 1,
              },
            },
            { new: true, session },
          );

          if (!inventory) {
            throw new Error(
              "No printed stock available for this barcode SKU",
            );
          }

          barcode.status = status;
          barcode.usedAt =
            status === "USED"
              ? new Date()
              : null;

          await barcode.save({ session });

          const availableCount = await Barcode.countDocuments({
            productId: barcode.productId,
            designCode: barcode.designCode,
            status: "AVAILABLE",
          }).session(session);

          const unbarcodedQuantity = calculateBarcodeGenerationCount(
            inventory.quantity,
            availableCount,
          );

          const synchronizedInventory = await Inventory.findOneAndUpdate(
            { _id: inventory._id, quantity: inventory.quantity },
            {
              $set: {
                activeBarcodeCount: availableCount,
                unbarcodedQuantity,
              },
            },
            { new: true, runValidators: true, session },
          );

          if (!synchronizedInventory) {
            throw new Error(
              "PRINTED inventory changed; please update the barcode again",
            );
          }
        }

        updatedBarcode =
          barcode;
      },
    );

    return res.json({
      message:
        "Barcode status updated successfully",

      barcode:
        updatedBarcode,
    });
  } catch (error) {
    console.error(
      "Update barcode status error:",
      error,
    );

    if (
      error.message ===
      "Barcode not found"
    ) {
      return res.status(404).json({
        message:
          "Barcode not found",
      });
    }

    if (
      error.message ===
        "No printed stock available for this barcode SKU" ||
      error.message ===
        "PRINTED inventory changed; please update the barcode again"
    ) {
      return res.status(400).json({
        message: error.message,
      });
    }

    return res.status(500).json({
      message: "Server error",
    });
  } finally {
    if (session) {
      await session.endSession();
    }
  }
};

/* -------------------------------------------------------------------------- */
/* Packed barcodes                                                            */
/* -------------------------------------------------------------------------- */

const getPackedBarcodes = async (
  req,
  res,
) => {
  try {
    const page = Math.max(
      Number.parseInt(
        req.query.page,
        10,
      ) || 1,
      1,
    );

    const limit = Math.min(
      Math.max(
        Number.parseInt(
          req.query.limit,
          10,
        ) || 50,
        1,
      ),
      200,
    );

    const filter = {
      status: "USED",
      usedAt: {
        $ne: null,
      },
    };

    if (req.query.productId) {
      filter.productId =
        req.query.productId;
    }

    if (req.query.designCode) {
      filter.designCode = String(
        req.query.designCode,
      ).trim();
    }

    if (
      req.query.from ||
      req.query.to
    ) {
      filter.usedAt = {};

      if (req.query.from) {
        const from = new Date(
          `${req.query.from}T00:00:00.000`,
        );

        if (Number.isNaN(from.getTime())) {
          return res.status(400).json({
            message:
              "from must be YYYY-MM-DD",
          });
        }

        filter.usedAt.$gte = from;
      }

      if (req.query.to) {
        const to = new Date(
          `${req.query.to}T23:59:59.999`,
        );

        if (Number.isNaN(to.getTime())) {
          return res.status(400).json({
            message:
              "to must be YYYY-MM-DD",
          });
        }

        filter.usedAt.$lte = to;
      }
    }

    const [
      totalPacked,
      barcodes,
    ] = await Promise.all([
      Barcode.countDocuments(
        filter,
      ),

      Barcode.find(filter)
        .sort({
          usedAt: -1,
          _id: -1,
        })
        .skip(
          (page - 1) * limit,
        )
        .limit(limit)
        .lean(),
    ]);

    const productIds = [
      ...new Set(
        barcodes.map(
          (barcode) =>
            String(
              barcode.productId,
            ),
        ),
      ),
    ];

    const designPairs = [
      ...new Map(
        barcodes.map(
          (barcode) => [
            `${barcode.productId}:${barcode.designCode}`,
            {
              productId:
                barcode.productId,

              designCode:
                barcode.designCode,
            },
          ],
        ),
      ).values(),
    ];

    const [
      products,
      designs,
    ] = await Promise.all([
      Product.find({
        _id: {
          $in: productIds,
        },
      })
        .select(
          "_id name skuBase categoryId",
        )
        .lean(),

      designPairs.length
        ? ProductDesign.find({
            $or: designPairs,
          })
            .select(
              "_id productId name mode designCode designUrl",
            )
            .lean()
        : [],
    ]);

    const productMap =
      new Map(
        products.map(
          (product) => [
            String(product._id),
            product,
          ],
        ),
      );

    const designMap =
      new Map(
        designs.map(
          (design) => [
            `${design.productId}:${design.designCode}`,
            design,
          ],
        ),
      );

    const packedItems =
      barcodes.map(
        (barcode) => {
          const product =
            productMap.get(
              String(
                barcode.productId,
              ),
            );

          const design =
            designMap.get(
              `${barcode.productId}:${barcode.designCode}`,
            );

          return {
            barcodeId:
              barcode._id,

            barcode:
              barcode.code,

            status:
              barcode.status,

            packedAt:
              barcode.usedAt,

            generatedAt:
              barcode.generatedAt ||
              barcode.createdAt,

            generationBatchId:
              barcode.generationBatchId ||
              null,

            product:
              product
                ? {
                    id:
                      product._id,

                    name:
                      product.name,

                    skuBase:
                      product.skuBase,

                    categoryId:
                      product.categoryId,
                  }
                : null,

            design: {
              id:
                design?._id ||
                null,

              name:
                design?.name ||
                barcode.designCode,

              mode:
                design?.mode ||
                null,

              code:
                barcode.designCode,

              image:
                design?.designUrl ||
                null,
            },
          };
        },
      );

    return res.json({
      totalPacked,

      page,

      limit,

      totalPages:
        Math.ceil(
          totalPacked /
            limit,
        ),

      packedItems,
    });
  } catch (error) {
    console.error(
      "Get packed barcodes error:",
      error,
    );

    return res.status(500).json({
      message: "Server error",
    });
  }
};

/* -------------------------------------------------------------------------- */
/* Today's barcode report                                                    */
/* -------------------------------------------------------------------------- */

const getBarcodeTodayReport = async (
  req,
  res,
) => {
  try {
    const start = new Date();

    start.setHours(
      0,
      0,
      0,
      0,
    );

    const end = new Date();

    end.setHours(
      23,
      59,
      59,
      999,
    );

    const filter = {
      createdAt: {
        $gte: start,
        $lte: end,
      },
    };

    if (req.query.productId) {
      filter.productId =
        req.query.productId;
    }

    const report =
      await Barcode.aggregate([
        {
          $match: filter,
        },

        {
          $group: {
            _id: {
              productId:
                "$productId",

              designCode:
                "$designCode",

              status:
                "$status",
            },

            quantity: {
              $sum: 1,
            },
          },
        },

        {
          $sort: {
            "_id.designCode": 1,
            "_id.status": 1,
          },
        },
      ]);

    return res.json({
      totalGenerated:
        report.reduce(
          (
            sum,
            item,
          ) =>
            sum +
            item.quantity,
          0,
        ),

      report,
    });
  } catch (error) {
    console.error(
      "Get barcode today report error:",
      error,
    );

    return res.status(500).json({
      message: "Server error",
    });
  }
};

/* -------------------------------------------------------------------------- */
/* Exports                                                                    */
/* -------------------------------------------------------------------------- */

module.exports = {
  generateBarcodes,
  listBarcodesByProduct,
  updateBarcodeStatus,
  getBarcodeTodayReport,
  getPackedBarcodes,
};
