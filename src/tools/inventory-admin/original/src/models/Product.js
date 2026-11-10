const mongoose = require('../../../mongoose-context.cjs');

const productSchema = new mongoose.Schema(
  {
    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      required: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
    },

    // Dynamic attributes defined by category.metaFields
    attributes: {
      type: Object,
      required: true,
    },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Product', productSchema);