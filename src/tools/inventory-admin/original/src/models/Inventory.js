const mongoose = require("../../../mongoose-context.cjs");

/*
|--------------------------------------------------------------------------
| INVENTORY MODEL
|--------------------------------------------------------------------------
|
| RAW stock:
|   - Belongs to a product
|   - designCode is always null
|
| PRINTED stock:
|   - Belongs to a product + design
|   - designCode is required
|
| Barcode flow:
|
| quantity
|   = Total PRINTED stock currently in inventory
|
| unbarcodedQuantity
|   = PRINTED units that have NOT received a barcode yet
|
| pendingBarcodeQuantity
|   = Exact quantity added by new printing work that still needs a fresh
|     barcode batch. It is independent of historical barcode records.
|
| activeBarcodeCount
|   = AVAILABLE barcode labels currently assigned
|
| Example:
|
| Printing job completed with 10:
|
| quantity             = 10
| unbarcodedQuantity   = 10
| activeBarcodeCount   = 0
|
| Generate barcodes:
|
| quantity             = 10
| unbarcodedQuantity   = 0
| activeBarcodeCount   = 10
|
| Another printing job completed with 5:
|
| quantity             = 15
| unbarcodedQuantity   = 5
| activeBarcodeCount   = 10
|
|--------------------------------------------------------------------------
*/

const inventorySchema = new mongoose.Schema(
  {
    /*
    |--------------------------------------------------------------------------
    | Product
    |--------------------------------------------------------------------------
    */

    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
    },

    /*
    |--------------------------------------------------------------------------
    | Inventory Type
    |--------------------------------------------------------------------------
    */

    type: {
      type: String,
      enum: ["RAW", "PRINTED"],
      required: true,
      index: true,
    },

    /*
    |--------------------------------------------------------------------------
    | Design Code
    |--------------------------------------------------------------------------
    |
    | RAW:
    |   Always null
    |
    | PRINTED:
    |   Required
    |
    */

    designCode: {
      type: String,
      default: null,
      trim: true,
    },

    /*
    |--------------------------------------------------------------------------
    | Total Quantity
    |--------------------------------------------------------------------------
    |
    | Total stock currently present.
    |
    */

    quantity: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: "quantity must be a whole number",
      },
    },

    /*
    |--------------------------------------------------------------------------
    | Unbarcoded Quantity
    |--------------------------------------------------------------------------
    |
    | Only meaningful for PRINTED stock.
    |
    | This tells the barcode generator exactly how many
    | newly printed units still need a barcode.
    |
    | Example:
    |
    | Printed quantity = 10
    | Unbarcoded      = 10
    |
    | Generate 10 barcodes:
    |
    | Printed quantity = 10
    | Unbarcoded      = 0
    |
    */

    unbarcodedQuantity: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: "unbarcodedQuantity must be a whole number",
      },
    },

    /*
    |--------------------------------------------------------------------------
    | Pending Barcode Queue Quantity
    |--------------------------------------------------------------------------
    |
    | Every new PRINTED quantity increments this queue. Barcode generation
    | consumes this exact queue value, so stale AVAILABLE labels from older
    | batches can never make a newly printed batch generate fewer labels.
    |
    | A missing or `null` value marks legacy inventory created before this queue
    | existed. New PRINTED rows receive a numeric value through the controlled
    | stock-add paths, which avoids MongoDB attempting to increment a null.
    |
    */

    pendingBarcodeQuantity: {
      type: Number,
      min: 0,
      validate: {
        validator: (value) =>
          value == null || Number.isSafeInteger(value),
        message: "pendingBarcodeQuantity must be a whole number",
      },
    },

    /*
    |--------------------------------------------------------------------------
    | Active Barcode Count
    |--------------------------------------------------------------------------
    |
    | Number of AVAILABLE barcode records currently assigned
    | to this PRINTED inventory row.
    |
    | USED barcodes are not included.
    |
    */

    activeBarcodeCount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: "activeBarcodeCount must be a whole number",
      },
    },

    /*
    |--------------------------------------------------------------------------
    | Minimum Threshold
    |--------------------------------------------------------------------------
    */

    minThreshold: {
      type: Number,
      default: 0,
      min: 0,
    },

    /*
    |--------------------------------------------------------------------------
    | Active
    |--------------------------------------------------------------------------
    */

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    /*
    |--------------------------------------------------------------------------
    | Legacy Barcode Array
    |--------------------------------------------------------------------------
    |
    | Kept only for backward compatibility.
    |
    | Barcode collection is the authoritative barcode history.
    | Do not use this array for barcode counting.
    |
    */

    barcodes: {
      type: [String],
      default: [],
    },
  },
  {
    timestamps: true,
  },
);

/*
|--------------------------------------------------------------------------
| VALIDATION
|--------------------------------------------------------------------------
|
| RAW inventory:
|   designCode must always be null
|
| PRINTED inventory:
|   designCode must exist
|
*/

inventorySchema.pre("validate", function () {
  if (this.type === "RAW") {
    this.designCode = null;
  }

  if (
    this.type === "PRINTED" &&
    !this.designCode
  ) {
    throw new Error(
      "PRINTED inventory requires designCode",
    );
  }

  /*
  |----------------------------------------------------------------------
  | RAW stock should never have barcode-related quantities
  |----------------------------------------------------------------------
  */

  if (this.type === "RAW") {
    this.unbarcodedQuantity = 0;
    this.pendingBarcodeQuantity = null;
    this.activeBarcodeCount = 0;
  }

});

/*
|--------------------------------------------------------------------------
| MAIN UNIQUE INDEX
|--------------------------------------------------------------------------
|
| One RAW row:
|
|   product + RAW + null
|
| One PRINTED row:
|
|   product + PRINTED + designCode
|
*/

inventorySchema.index(
  {
    productId: 1,
    type: 1,
    designCode: 1,
  },
  {
    unique: true,
  },
);

/*
|--------------------------------------------------------------------------
| PRINTED STOCK LOOKUP INDEX
|--------------------------------------------------------------------------
|
| Useful for barcode generation and inventory operations.
|
*/

inventorySchema.index({
  productId: 1,
  type: 1,
  designCode: 1,
  isActive: 1,
});

/*
|--------------------------------------------------------------------------
| BARCODE-RELATED LOOKUP INDEX
|--------------------------------------------------------------------------
*/

inventorySchema.index({
  productId: 1,
  designCode: 1,
  type: 1,
  unbarcodedQuantity: 1,
});

/*
|--------------------------------------------------------------------------
| MODEL
|--------------------------------------------------------------------------
*/

module.exports = mongoose.model(
  "Inventory",
  inventorySchema,
);
