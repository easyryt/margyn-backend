const mongoose = require('../../../mongoose-context.cjs');

const barcodeSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      index: true,
    },

    designCode: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    /* The completed printing job that produced this exact label batch. */
    printingJobId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PrintingJob',
      default: null,
      index: true,
    },

    /* Position within a printing-job batch: 1 through job.quantity. */
    labelSequence: {
      type: Number,
      default: null,
      min: 1,
    },

    /*
     * Every barcode generation request gets its own batch.
     *
     * Example:
     *
     * Batch A
     * 10:30:15
     * 50 barcodes
     *
     * Batch B
     * 14:20:42
     * 20 barcodes
     */
    generationBatchId: {
      type: String,
      trim: true,
      index: true,
      default: null,
    },

    /*
     * Exact time when this barcode generation request happened.
     * All barcodes created in one request receive the same generatedAt.
     */
    generatedAt: {
      type: Date,
      default: null,
      index: true,
    },

    status: {
      type: String,
      enum: ['AVAILABLE', 'USED'],
      default: 'AVAILABLE',
      index: true,
    },

    usedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

/*
 * Useful query indexes.
 */
barcodeSchema.index({
  productId: 1,
  designCode: 1,
  createdAt: -1,
});

barcodeSchema.index({
  productId: 1,
  designCode: 1,
  generationBatchId: 1,
});

barcodeSchema.index({
  productId: 1,
  designCode: 1,
  status: 1,
});

/* Exactly one label may occupy each position in a linked printing job. */
barcodeSchema.index(
  {
    printingJobId: 1,
    labelSequence: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      printingJobId: { $type: 'objectId' },
    },
  },
);

module.exports = mongoose.model('Barcode', barcodeSchema);
