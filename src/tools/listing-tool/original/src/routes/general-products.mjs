import express from "express";
import mongoose from "../../../mongoose-context.mjs";
import GeneralProduct from "../models/GeneralProduct.mjs";
import {
  generalProductError, normalizeGeneralProduct, saveGeneralProduct,
  serializeGeneralProduct, generalProductAnalyticsPipeline, serializeGeneralAnalytics,
} from "../services/general-products.mjs";

export function createGeneralProductRouter(Model = GeneralProduct, ready = () => mongoose.connection.readyState === 1) {
  const router = express.Router();
  router.use((_request, _response, next) => {
    if (!ready()) return next(generalProductError("MongoDB is unavailable. Your unsaved batch is still available on this page.", 503));
    next();
  });
  router.get("/analytics", async (_request, response, next) => {
    try {
      const [result] = await Model.aggregate(generalProductAnalyticsPipeline());
      response.json({ success: true, ...serializeGeneralAnalytics(result) });
    } catch (error) { next(error); }
  });
  router.get("/", async (request, response, next) => {
    try {
      const page = Math.max(1, Math.min(100000, Number.parseInt(String(request.query.page), 10) || 1));
      const limit = Math.max(1, Math.min(100, Number.parseInt(String(request.query.limit), 10) || 20));
      const filter = {};
      if (typeof request.query.category === "string" && request.query.category.trim()) filter["rows.category"] = request.query.category.trim();
      if (typeof request.query.q === "string" && request.query.q.trim()) {
        const regex = new RegExp(request.query.q.trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        filter.$or = ["draft.productName", "draft.productType", "skus", "variants.productName"].map((field) => ({ [field]: regex }));
      }
      const [products, total] = await Promise.all([
        Model.find(filter).select("-rows -skus -contentHash").sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        Model.countDocuments(filter),
      ]);
      response.json({ success: true, products: products.map(serializeGeneralProduct), pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
    } catch (error) { next(error); }
  });
  router.post("/batch", async (request, response, next) => {
    try {
      const products = request.body?.products;
      if (!Array.isArray(products) || !products.length || products.length > 100) throw generalProductError("Save between 1 and 100 parent products in one batch.");
      const ids = new Set();
      const skus = new Set();
      for (const product of products) {
        const normalized = normalizeGeneralProduct(product);
        if (ids.has(normalized.clientId)) throw generalProductError("A parent product appears twice in this batch.");
        ids.add(normalized.clientId);
        for (const sku of normalized.skus) {
          if (skus.has(sku)) throw generalProductError(`Duplicate SKU in this batch: ${sku}`);
          skus.add(sku);
        }
      }
      await Model.init(); // Wait for the unique SKU index before accepting writes.
      const saved = [];
      const errors = [];
      const counts = { created: 0, updated: 0, unchanged: 0 };
      for (const product of products) {
        try {
          const result = await saveGeneralProduct(Model, product);
          saved.push(result.product);
          counts[result.action] += 1;
        } catch (error) {
          errors.push({ clientId: product.draft.id, sku: generalProductSkuForMessage(product), status: error.status || (error.code === 11000 ? 409 : 500),
            message: error.code === 11000 ? "A SKU is already saved in another product. Existing records were not overwritten." : error.status ? error.message : "Unable to save this product. Try again; successful saves are safe to retry." });
        }
      }
      response.json({ success: !errors.length, saved, errors, counts });
    } catch (error) { next(error); }
  });
  router.get("/:id", async (request, response, next) => {
    try {
      if (!mongoose.isObjectIdOrHexString(request.params.id)) throw generalProductError("Invalid saved product ID.");
      const product = await Model.findById(request.params.id).lean();
      if (!product) throw generalProductError("General product not found.", 404);
      response.json({ success: true, product: serializeGeneralProduct(product) });
    } catch (error) { next(error); }
  });
  router.delete("/:id", async (request, response, next) => {
    try {
      if (!mongoose.isObjectIdOrHexString(request.params.id)) throw generalProductError("Invalid saved product ID.");
      const revision = Number(request.query.revision);
      if (!Number.isInteger(revision) || revision < 1) throw generalProductError("The saved product revision is required.");
      const deleted = await Model.findOneAndDelete({ _id: request.params.id, revision });
      if (!deleted) throw generalProductError("This product changed or was already removed. Refresh the saved catalog first.", 409);
      response.json({ success: true, message: "General product and its variants deleted. Phone products were not changed." });
    } catch (error) { next(error); }
  });
  return router;
}

function generalProductSkuForMessage(product) {
  return product.draft.sku || product.draft.productName;
}

export default createGeneralProductRouter();
