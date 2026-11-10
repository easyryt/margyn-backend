const mongoose = require("../../../mongoose-context.cjs");

const printingJobSchema = new mongoose.Schema(
  {
    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    designId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProductDesign",
      required: true,
    },
    designCode: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isSafeInteger,
        message: "quantity must be a whole number",
      },
    },
    status: {
      type: String,
      enum: ["PENDING", "COMPLETED", "CANCELLED"],
      default: "PENDING",
    },
    notes: {
      type: String,
      trim: true,
      default: "",
    },
    inventoryAdded: {
      type: Boolean,
      default: false,
    },
    /*
     * Barcode generation belongs to the printing job, not to an aggregate
     * inventory total. This makes a 100-unit print job generate one exact
     * 100-label batch even when old labels exist for the same design.
     */
    barcodeGenerationStatus: {
      type: String,
      enum: [
        "NOT_READY",
        "PENDING",
        "GENERATING",
        "GENERATED",
        "LEGACY_UNLINKED",
      ],
      default: "NOT_READY",
      index: true,
    },
    barcodeGenerationBatchId: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },
    barcodeExpectedCount: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: "barcodeExpectedCount must be a whole number",
      },
    },
    barcodeGeneratedCount: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: "barcodeGeneratedCount must be a whole number",
      },
    },
    barcodeGeneratedAt: {
      type: Date,
      default: null,
    },
    minThreshold: {
      type: Number,
      default: 0,
      min: 0,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true },
);

printingJobSchema.index({
  productId: 1,
  designId: 1,
  barcodeGenerationStatus: 1,
  createdAt: -1,
});

module.exports = mongoose.model("PrintingJob", printingJobSchema);
