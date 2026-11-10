const mongoose = require('../../../mongoose-context.cjs');

const metaFieldSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      trim: true,          // e.g. "brand", "model", "material"
    },
    label: {
      type: String,
      required: true,
      trim: true,          // e.g. "Brand", "Model", "Material Type"
    },
    type: {
      type: String,
      enum: ['string', 'number', 'boolean'],
      default: 'string',
    },
    required: {
      type: Boolean,
      default: true,
    },
  },
  { _id: false }
);

const categorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,          // e.g. "Mobile Covers", "Charms"
    },
    metaFields: {
      type: [metaFieldSchema],
      default: [],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Category', categorySchema);