const mongoose = require('../../../mongoose-context.cjs');

const purchaseItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    orderedQty: {
      type: Number,
      required: true,
      min: 1,
    },
    receivedQty: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { _id: false }
);

const purchaseOrderSchema = new mongoose.Schema(
  {
    supplierName: {
      type: String,
      required: true,
      trim: true,
    },
    notes: {
      type: String,
      trim: true,
      default: '',
    },
    purchaseDate: {
      type: Date,
      default: Date.now,
    },
    items: {
      type: [purchaseItemSchema],
      required: true,
      validate: {
        validator: function (v) {
          return Array.isArray(v) && v.length > 0;
        },
        message: 'At least one item is required in a purchase order',
      },
    },
    status: {
      type: String,
      enum: ['PENDING', 'VERIFIED'],
      default: 'PENDING',
    },
    textSummary: {
      type: String,
      default: '',
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PurchaseOrder', purchaseOrderSchema);
