import mongoose from "../../../mongoose-context.mjs";
import Product from "./Product.mjs";

// Same listing fields as Product, but MongoDB stores these in `charms`.
// designNumber is a link to a product design and is intentionally not unique.
const charmSchema = Product.schema.clone();
charmSchema.remove("parentId");
charmSchema.remove("variantNumber");
charmSchema.remove("variantType");

charmSchema.add({
  sourceProductId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Product",
    default: undefined,
  },
  sourceKind: {
    type: String,
    enum: ["parent", "variant"],
    default: undefined,
  },
  sourceVariantNumber: {
    type: Number,
    default: undefined,
  },
});

charmSchema.clearIndexes();
charmSchema.index({ createdAt: -1 });
charmSchema.index({ designNumber: 1 });
charmSchema.index({ sourceProductId: 1 });
charmSchema.index({ "models.model": 1, createdAt: -1 });
charmSchema.index({ sku: 1 }, { unique: true, sparse: true, name: "unique_charm_sku" });

const Charm = mongoose.models.Charm || mongoose.model("Charm", charmSchema, "charms");
export default Charm;
