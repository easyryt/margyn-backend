// src/controllers/inventoryController.js

const mongoose = require("../../../mongoose-context.cjs");

const Inventory = require("../models/Inventory");
const ProductDesign = require("../models/ProductDesign");
const Barcode = require("../models/Barcode");
const { addPrintedStock } = require("../services/inventory.service");

const isPositiveWholeNumber = (value) =>
  Number.isSafeInteger(Number(value)) && Number(value) > 0;

// ============================================================
// POST /api/inventory/raw
// body:
// {
//   productId,
//   quantity,
//   minThreshold?
// }
//
// RAW stock is held at product/model level.
// ============================================================
const addRawInventory = async (req, res) => {
  try {
    const {
      productId,
      quantity,
      minThreshold,
    } = req.body;

    // ----------------------------------------------------------
    // Validate productId
    // ----------------------------------------------------------
    if (
      !productId ||
      !mongoose.Types.ObjectId.isValid(productId)
    ) {
      return res.status(400).json({
        message: "A valid productId is required",
      });
    }

    // ----------------------------------------------------------
    // Validate quantity
    // ----------------------------------------------------------
    const stockQuantity = Number(quantity);

    if (
      !Number.isSafeInteger(stockQuantity) ||
      stockQuantity < 1
    ) {
      return res.status(400).json({
        message:
          "quantity must be a positive whole number",
      });
    }

    // ----------------------------------------------------------
    // Build update
    // ----------------------------------------------------------
    const update = {
      $inc: {
        quantity: stockQuantity,
      },

      $set: {
        isActive: true,
      },

      $setOnInsert: {
        productId,
        type: "RAW",
        designCode: null,
        minThreshold: 0,
        barcodes: [],
      },
    };

    // ----------------------------------------------------------
    // Keep existing RAW threshold behavior
    // ----------------------------------------------------------
    if (minThreshold !== undefined) {
      const threshold = Number(minThreshold);

      if (
        !Number.isSafeInteger(threshold) ||
        threshold < 0
      ) {
        return res.status(400).json({
          message:
            "minThreshold must be a non-negative whole number",
        });
      }

      update.$set.minThreshold = threshold;
    }

    // ----------------------------------------------------------
    // Add RAW stock
    // ----------------------------------------------------------
    const inventory =
      await Inventory.findOneAndUpdate(
        {
          productId,
          type: "RAW",
          designCode: null,
        },
        update,
        {
          new: true,
          upsert: true,
          runValidators: true,
        }
      );

    return res.status(201).json({
      message:
        "RAW stock added successfully",
      inventory,
    });
  } catch (err) {
    console.error(
      "Add RAW inventory error:",
      err
    );

    return res.status(500).json({
      message: "Server error",
    });
  }
};

// ============================================================
// POST /api/inventory/raw/design
// body:
// {
//   productId,
//   designId,
//   quantity,
//   minThreshold?
// }
//
// This keeps your existing RAW design logic.
// ============================================================
const addDesignToRawInventory = async (
  req,
  res
) => {
  try {
    const {
      productId,
      designId,
      quantity,
      minThreshold,
    } = req.body;

    // ----------------------------------------------------------
    // Validate required fields
    // ----------------------------------------------------------
    if (!productId || !designId) {
      return res.status(400).json({
        message:
          "productId and designId are required",
      });
    }

    // ----------------------------------------------------------
    // Validate quantity
    // ----------------------------------------------------------
    if (!isPositiveWholeNumber(quantity)) {
      return res.status(400).json({
        message:
          "quantity must be a positive whole number",
      });
    }

    const rawQuantity = Number(quantity);

    // ----------------------------------------------------------
    // Find design
    // ----------------------------------------------------------
    const design =
      await ProductDesign.findOne({
        _id: designId,
        productId,
        isActive: true,
      });

    if (!design) {
      return res.status(400).json({
        message:
          "Selected model/design does not belong to this product",
      });
    }

    // ----------------------------------------------------------
    // Add RAW stock
    // ----------------------------------------------------------
    const inventory =
      await Inventory.findOneAndUpdate(
        {
          productId,
          type: "RAW",
          designCode: design.designCode,
        },
        {
          $inc: {
            quantity: rawQuantity,
          },

          $set: {
            isActive: true,
          },

          $setOnInsert: {
            productId,
            type: "RAW",
            designCode: design.designCode,
            minThreshold:
              minThreshold ?? 0,
            barcodes: [],
          },
        },
        {
          new: true,
          upsert: true,
          runValidators: true,
        }
      );

    return res.status(201).json({
      message:
        "Model/design added to RAW inventory successfully",
      inventory,
    });
  } catch (err) {
    console.error(
      "Add design raw inventory error:",
      err
    );

    return res.status(500).json({
      message: "Server error",
    });
  }
};

// ============================================================
// POST /api/inventory/transfer-to-printed
// body:
// {
//   productId,
//   designId,
//   quantity
// }
//
// Moves RAW stock to PRINTED stock.
// ============================================================
const transferRawToPrintedInventory = async (
  req,
  res
) => {
  let session;
  try {
    const {
      productId,
      designId,
      quantity,
    } = req.body;

    // ----------------------------------------------------------
    // Validate required fields
    // ----------------------------------------------------------
    if (
      !mongoose.Types.ObjectId.isValid(productId) ||
      !mongoose.Types.ObjectId.isValid(designId)
    ) {
      return res.status(400).json({
        message:
          "A valid productId and designId are required",
      });
    }

    // ----------------------------------------------------------
    // Validate quantity
    // ----------------------------------------------------------
    if (!isPositiveWholeNumber(quantity)) {
      return res.status(400).json({
        message:
          "quantity must be a positive whole number",
      });
    }

    // ----------------------------------------------------------
    // Find design
    // ----------------------------------------------------------
    const design =
      await ProductDesign.findOne({
        _id: designId,
        productId,
        isActive: true,
      });

    if (!design) {
      return res.status(400).json({
        message:
          "Selected model/design does not belong to this product",
      });
    }

    const moveQuantity = Number(quantity);
    let rawInventory;
    let printedInventory;

    session = await mongoose.startSession();

    await session.withTransaction(async () => {
      // Preserve the older design-specific RAW workflow while also supporting
      // the newer product-level RAW row used by printing jobs. Prefer stock
      // explicitly assigned to this design, then fall back to product-level.
      rawInventory = await Inventory.findOneAndUpdate(
        {
          productId,
          type: "RAW",
          designCode: design.designCode,
          quantity: { $gte: moveQuantity },
        },
        { $inc: { quantity: -moveQuantity } },
        { new: true, session },
      );

      if (!rawInventory) {
        rawInventory = await Inventory.findOneAndUpdate(
          {
            productId,
            type: "RAW",
            designCode: null,
            quantity: { $gte: moveQuantity },
          },
          { $inc: { quantity: -moveQuantity } },
          { new: true, session },
        );
      }

      if (!rawInventory) {
        throw new Error("Insufficient RAW inventory for this product");
      }

      // Each newly printed item starts out needing one barcode label. The
      // shared helper also normalizes legacy null queue values safely.
      printedInventory = await addPrintedStock(
        productId,
        design.designCode,
        moveQuantity,
        session,
      );
    });

    return res.json({
      message:
        "RAW stock transferred to PRINTED stock successfully",

      rawInventory,

      printedInventory,
    });
  } catch (err) {
    if (err.message === "Insufficient RAW inventory for this product") {
      return res.status(400).json({ message: err.message });
    }

    console.error(
      "Transfer RAW to PRINTED inventory error:",
      err
    );

    return res.status(500).json({
      message: "Server error",
    });
  } finally {
    if (session) {
      await session.endSession();
    }
  }
};

// ============================================================
// GET /api/inventory/design/:productId
//
// IMPORTANT:
//
// This is the inventory LIST endpoint.
//
// It shows ALL active designs belonging to the product.
//
// If PRINTED inventory exists:
//     show actual quantity.
//
// If PRINTED inventory doesn't exist:
//     show quantity 0.
//
// RAW inventory is NOT returned here.
//
// IMPORTANT:
// We do NOT create inventory records for quantity 0.
// ============================================================
const getDesignInventoryByProduct = async (
  req,
  res
) => {
  try {
    const { productId } = req.params;

    // ----------------------------------------------------------
    // Validate productId
    // ----------------------------------------------------------
    if (
      !mongoose.Types.ObjectId.isValid(
        productId
      )
    ) {
      return res.status(400).json({
        message: "Invalid product ID",
      });
    }

    // ==========================================================
    // STEP 1
    // Get ALL active designs for this product
    //
    // This is the important part.
    //
    // The list is based on ProductDesign,
    // NOT Inventory.
    // ==========================================================
    const designs =
      await ProductDesign.find({
        productId,
        isActive: true,
      })
        .select(
          "_id designCode designUrl name mode sku"
        )
        .sort({
          name: 1,
          designCode: 1,
        })
        .lean();

    // ==========================================================
    // STEP 2
    // Get only PRINTED inventory
    //
    // RAW rows are ignored.
    // ==========================================================
    const inventory =
      await Inventory.find({
        productId,
        type: "PRINTED",
        isActive: true,
      })
        .lean();

    // ==========================================================
    // STEP 3
    // Create inventory lookup by designCode
    // ==========================================================
    const inventoryMap = {};

    inventory.forEach((row) => {
      inventoryMap[row.designCode] = row;
    });

    // ==========================================================
    // STEP 4
    // Get barcode statistics
    // ==========================================================
    const barcodeStats =
      await Barcode.aggregate([
        {
          $match: {
            productId:
              new mongoose.Types.ObjectId(
                productId
              ),
          },
        },

        {
          $group: {
            _id: "$designCode",

            totalBarcodes: {
              $sum: 1,
            },

            availableBarcodes: {
              $sum: {
                $cond: [
                  {
                    $eq: [
                      "$status",
                      "AVAILABLE",
                    ],
                  },
                  1,
                  0,
                ],
              },
            },

            usedBarcodes: {
              $sum: {
                $cond: [
                  {
                    $eq: [
                      "$status",
                      "USED",
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]);

    // ==========================================================
    // STEP 5
    // Create barcode lookup
    // ==========================================================
    const barcodeStatsByDesign = {};

    barcodeStats.forEach((item) => {
      barcodeStatsByDesign[
        item._id
      ] = {
        totalBarcodes:
          item.totalBarcodes,

        availableBarcodes:
          item.availableBarcodes,

        usedBarcodes:
          item.usedBarcodes,
      };
    });

    // ==========================================================
    // STEP 6
    // Build final list
    //
    // IMPORTANT:
    // Loop through DESIGNS, not inventory.
    //
    // Therefore every design appears.
    // ==========================================================
    const detailedInventory =
      designs.map((design) => {
        // ------------------------------------------------------
        // Find existing PRINTED inventory
        // ------------------------------------------------------
        const stock =
          inventoryMap[
            design.designCode
          ];

        // ------------------------------------------------------
        // Find barcode stats
        // ------------------------------------------------------
        const stats =
          barcodeStatsByDesign[
            design.designCode
          ] || {
            totalBarcodes: 0,
            availableBarcodes: 0,
            usedBarcodes: 0,
          };

        // ------------------------------------------------------
        // Return design + stock
        // ------------------------------------------------------
        return {
          // Inventory document ID.
          // null means no PRINTED inventory record exists yet.
          _id:
            stock?._id || null,

          // Product
          productId,

          // This list only represents PRINTED stock
          type: "PRINTED",

          // Product design information
          designId: design._id,

          designCode:
            design.designCode,

          designName:
            design.name || null,

          designSku:
            design.sku || null,

          mode:
            design.mode || null,

          designUrl:
            design.designUrl || "",

          // ----------------------------------------------------
          // STOCK
          //
          // Existing inventory -> actual quantity
          // No inventory      -> 0
          // ----------------------------------------------------
          quantity:
            stock?.quantity ?? 0,

          // ----------------------------------------------------
          // Barcode count
          // ----------------------------------------------------
          activeBarcodeCount:
            stock?.activeBarcodeCount ?? 0,

          // ----------------------------------------------------
          // Threshold
          //
          // Existing record -> existing threshold
          // No record        -> 0
          //
          // This does NOT save/change anything.
          // ----------------------------------------------------
          minThreshold:
            stock?.minThreshold ?? 0,

          // ----------------------------------------------------
          // Barcode statistics
          // ----------------------------------------------------
          totalBarcodes:
            stats.totalBarcodes,

          availableBarcodes:
            stats.availableBarcodes,

          usedBarcodes:
            stats.usedBarcodes,

          // ----------------------------------------------------
          // Helpful frontend flag
          // ----------------------------------------------------
          hasInventory:
            Boolean(stock),
        };
      });

    // ==========================================================
    // STEP 7
    // Return response
    // ==========================================================
    return res.json({
      inventory: detailedInventory,
    });
  } catch (err) {
    console.error(
      "Get design inventory error:",
      err
    );

    return res.status(500).json({
      message: "Server error",
    });
  }
};

// ============================================================
// PATCH /api/inventory/:id
//
// Update inventory threshold.
//
// UNCHANGED.
// Works for existing RAW or PRINTED records.
// ============================================================
const updateInventoryThreshold = async (
  req,
  res
) => {
  try {
    const { id } = req.params;

    const {
      minThreshold,
    } = req.body;

    // ----------------------------------------------------------
    // Validate ID
    // ----------------------------------------------------------
    if (
      !mongoose.Types.ObjectId.isValid(id)
    ) {
      return res.status(400).json({
        message: "Invalid inventory ID",
      });
    }

    // ----------------------------------------------------------
    // Validate threshold
    // ----------------------------------------------------------
    const threshold =
      Number(minThreshold);

    if (
      minThreshold === undefined ||
      isNaN(threshold) ||
      threshold < 0
    ) {
      return res.status(400).json({
        message:
          "minThreshold must be a non-negative number",
      });
    }

    // ----------------------------------------------------------
    // Update threshold
    // ----------------------------------------------------------
    const updated =
      await Inventory.findByIdAndUpdate(
        id,

        {
          $set: {
            minThreshold: threshold,
          },
        },

        {
          new: true,
          runValidators: true,
        }
      );

    if (!updated) {
      return res.status(404).json({
        message:
          "Inventory record not found",
      });
    }

    return res.json({
      message:
        "Threshold updated",

      inventory: updated,
    });
  } catch (err) {
    console.error(
      "Update inventory threshold error:",
      err
    );

    return res.status(500).json({
      message: "Server error",
    });
  }
};

// ============================================================
// GET /api/inventory/low-stock
//
// UNCHANGED.
//
// RAW inventory can still participate in low-stock logic.
// ============================================================
const getLowStockInventory = async (
  req,
  res
) => {
  try {
    const lowStockItems =
      await Inventory.aggregate([
        // ------------------------------------------------------
        // Find low stock items
        // ------------------------------------------------------
        {
          $match: {
            isActive: true,

            minThreshold: {
              $gt: 0,
            },

            $expr: {
              $lte: [
                "$quantity",
                "$minThreshold",
              ],
            },
          },
        },

        // ------------------------------------------------------
        // Product
        // ------------------------------------------------------
        {
          $lookup: {
            from: "products",

            localField: "productId",

            foreignField: "_id",

            as: "product",
          },
        },

        {
          $unwind: {
            path: "$product",

            preserveNullAndEmptyArrays: true,
          },
        },

        // ------------------------------------------------------
        // Design
        // ------------------------------------------------------
        {
          $lookup: {
            from: "productdesigns",

            let: {
              code: "$designCode",
            },

            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: [
                      "$designCode",
                      "$$code",
                    ],
                  },
                },
              },

              {
                $project: {
                  name: 1,
                  mode: 1,
                  designCode: 1,
                  designUrl: 1,
                },
              },
            ],

            as: "design",
          },
        },

        {
          $unwind: {
            path: "$design",

            preserveNullAndEmptyArrays: true,
          },
        },

        // ------------------------------------------------------
        // Response fields
        // ------------------------------------------------------
        {
          $project: {
            _id: 1,

            productId: 1,

            productName:
              "$product.name",

            designCode: 1,

            designName:
              "$design.name",

            mode:
              "$design.mode",

            designUrl:
              "$design.designUrl",

            quantity: 1,

            minThreshold: 1,

            deficit: {
              $subtract: [
                "$minThreshold",
                "$quantity",
              ],
            },

            type: 1,
          },
        },

        // ------------------------------------------------------
        // Highest deficit first
        // ------------------------------------------------------
        {
          $sort: {
            deficit: -1,
          },
        },
      ]);

    return res.json({
      lowStockItems,
    });
  } catch (err) {
    console.error(
      "Low-stock query error:",
      err
    );

    return res.status(500).json({
      message: "Server error",
    });
  }
};

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  addRawInventory,
  addDesignToRawInventory,
  transferRawToPrintedInventory,
  getDesignInventoryByProduct,
  updateInventoryThreshold,
  getLowStockInventory,
};
