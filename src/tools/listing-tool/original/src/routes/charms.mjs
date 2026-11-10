import express from "express";
import mongoose from "../../../mongoose-context.mjs";
import Charm from "../models/Charm.mjs";

const router = express.Router();

const FIELDS = [
  "productName", "description", "brand", "category", "material", "color", "theme", "type",
  "price", "wrongDefectiveReturnsPrice", "mrp", "gst", "hsn", "weight", "inventory", "country", "manufacturer",
  "manufacturerAddress", "manufacturerPincode", "packer", "packerAddress", "packerPincode",
  "importer", "importerAddress", "importerPincode", "genericName", "size", "quantity",
  "length", "width", "designName", "designCode", "designNumber", "designId", "sku", "styleId", "printType",
  "finish", "version", "image1", "image2", "image3", "image4", "groupId", "models",
];

const isId = (id) => mongoose.isObjectIdOrHexString(id);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function normalizeCharmSku(value) {
  const sku = String(value ?? "").trim().toUpperCase();
  if (!sku) return sku;

  const charmMarker = /\bWITH[\s-]+(?:CHARMS?|CHRMS?)\b/i;
  if (charmMarker.test(sku)) {
    return sku.replace(charmMarker, "WITH CHARMS");
  }

  const versionMatch = sku.match(/-(\d+(?:\.\d+)*\.V\d+)$/i);
  return versionMatch?.index !== undefined
    ? `${sku.slice(0, versionMatch.index)}-WITH CHARMS${sku.slice(versionMatch.index)}`
    : `${sku}-WITH CHARMS`;
}

function pick(body = {}) {
  return Object.fromEntries(FIELDS.filter((field) => Object.hasOwn(body, field)).map((field) => [field, body[field]]));
}

function clean(data) {
  const result = { ...data };
  for (const field of ["productName", "designName", "designCode", "designNumber", "sku", "groupId"]) {
    if (result[field] !== undefined && result[field] !== null) result[field] = String(result[field]).trim();
  }
  if (result.designCode) result.designCode = result.designCode.toUpperCase();
  if (Object.hasOwn(result, "sku")) {
    result.sku = normalizeCharmSku(result.sku);
    result.styleId = result.sku;
  } else {
    delete result.styleId;
  }
  return result;
}

function serialize(charm) {
  const result = typeof charm.toObject === "function" ? charm.toObject() : { ...charm };
  result.id = result._id.toString();
  delete result._id;
  delete result.__v;
  return result;
}

function validate(data) {
  for (const field of ["productName", "designName", "designCode", "designNumber", "sku", "groupId"]) {
    if (!data[field]?.trim()) throw fail(`Charm ${field} is required.`);
  }
  if (!Array.isArray(data.models) || !data.models.length) throw fail("At least one phone model is required.");
}

router.post("/", async (request, response, next) => {
  try {
    const data = clean(pick(request.body));
    validate(data);
    const charm = await Charm.create(data);
    response.status(201).json({ success: true, message: "Charm saved separately from the product.", charm: serialize(charm) });
  } catch (error) { next(error); }
});

router.get("/models", async (_request, response, next) => {
  try {
    const models = await Charm.aggregate([
      { $unwind: "$models" },
      {
        $project: {
          model: { $trim: { input: { $ifNull: ["$models.model", ""] } } },
        },
      },
      { $match: { model: { $ne: "" } } },
      { $group: { _id: "$model", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    response.json({
      success: true,
      count: models.length,
      models: models.map((item) => ({ name: item._id, count: item.count })),
    });
  } catch (error) { next(error); }
});

router.get("/", async (request, response, next) => {
  try {
    const filter = {};
    if (request.query.designNumber) {
      filter.designNumber = String(request.query.designNumber).trim();
    }
    if (request.query.model) {
      filter["models.model"] = String(request.query.model).trim();
    }
    const charms = await Charm.find(filter).sort({ createdAt: -1 }).lean();
    response.json({
      success: true,
      model: request.query.model ? String(request.query.model).trim() : undefined,
      count: charms.length,
      charms: charms.map(serialize),
    });
  } catch (error) { next(error); }
});

router.get("/:id", async (request, response, next) => {
  if (!isId(request.params.id)) return response.status(400).json({ success: false, message: "Invalid charm ID." });
  try {
    const charm = await Charm.findById(request.params.id).lean();
    if (!charm) throw fail("Charm not found.", 404);
    response.json({ success: true, charm: serialize(charm) });
  } catch (error) { next(error); }
});

router.patch("/:id", async (request, response, next) => {
  if (!isId(request.params.id)) return response.status(400).json({ success: false, message: "Invalid charm ID." });
  try {
    const update = clean(pick(request.body));
    delete update.designNumber;
    const charm = await Charm.findByIdAndUpdate(request.params.id, { $set: update }, { new: true, runValidators: true });
    if (!charm) throw fail("Charm not found.", 404);
    response.json({ success: true, message: "Charm updated successfully.", charm: serialize(charm) });
  } catch (error) { next(error); }
});

router.delete("/:id", async (request, response, next) => {
  if (!isId(request.params.id)) return response.status(400).json({ success: false, message: "Invalid charm ID." });
  try {
    const charm = await Charm.findByIdAndDelete(request.params.id);
    if (!charm) throw fail("Charm not found.", 404);
    response.json({ success: true, message: "Charm deleted successfully." });
  } catch (error) { next(error); }
});

export default router;
