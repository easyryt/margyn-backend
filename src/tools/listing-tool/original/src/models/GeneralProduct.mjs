import mongoose from "../../../mongoose-context.mjs";

// One atomic family document keeps the parent, variant titles, and editable
// overrides together. This never writes to the phone products collection.
const schema = new mongoose.Schema({
  clientId: { type: String, required: true, unique: true },
  draft: { type: mongoose.Schema.Types.Mixed, required: true },
  codes: { type: mongoose.Schema.Types.Mixed, required: true },
  variants: { type: [mongoose.Schema.Types.Mixed], default: [] },
  rows: { type: [mongoose.Schema.Types.Mixed], required: true },
  skus: { type: [String], required: true },
  parentVersion: { type: Number, required: true, min: 1 },
  productContext: { type: String, default: "" },
  skuOverride: { type: String, default: null },
  contentHash: { type: String, required: true },
  revision: { type: Number, required: true, min: 1 },
}, { timestamps: true, strict: "throw", collection: "general_products", bufferCommands: false });

schema.index({ skus: 1 }, { unique: true, name: "unique_general_product_skus" });
schema.index({ createdAt: -1 });
schema.index({ "draft.category": 1 });

export default mongoose.models.GeneralProduct || mongoose.model("GeneralProduct", schema);
