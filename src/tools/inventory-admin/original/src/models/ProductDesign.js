const mongoose = require('../../../mongoose-context.cjs');

const productDesignSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
      // Example: Butterfly Front
    },

    mode: {
      type: String,
      required: true,
      trim: true,
      // Example: SCREEN_PRINT, HEAT_TRANSFER, EMBROIDERY
    },

    // Product Design SKU
    sku: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      // Example: TS-BUTTERFLY-BLUE
    },

    designCode: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      // Example: BUTTERFLY_BLUE
    },

    designUrl: {
      type: String,
      trim: true,
      default: '',
    },

    notes: {
      type: String,
      trim: true,
      default: '',
    },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

productDesignSchema.index(
  { productId: 1, designCode: 1 },
  { unique: true }
);

module.exports = mongoose.model('ProductDesign', productDesignSchema);