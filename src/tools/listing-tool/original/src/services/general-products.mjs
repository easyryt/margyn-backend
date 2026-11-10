import { createHash } from "node:crypto";

export const LISTING_FIELDS = [
  "id", "productName", "category", "variation", "price", "wrongDefectiveReturnsPrice", "mrp", "gst", "hsn",
  "weight", "inventory", "country", "manufacturer", "manufacturerAddress", "manufacturerPincode", "packer",
  "packerAddress", "packerPincode", "importer", "importerAddress", "importerPincode", "color", "genericName",
  "includedComponents", "material", "quantity", "length", "width", "theme", "productType", "image1", "image2",
  "image3", "image4", "styleId", "sku", "brand", "groupId", "description",
];
const OVERRIDE_FIELDS = LISTING_FIELDS.filter((field) => !["id", "productName", "sku", "styleId", "groupId"].includes(field));
const CODE_FIELDS = ["brandCode", "categoryCode", "productCode", "colorCode"];
export const generalProductError = (message, status = 400) => Object.assign(new Error(message), { status });
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function generalProductListingGroups(draft, variants) {
  const read = (value = "") => {
    const match = String(value).trim().match(/^(?:Group\s+)?(\d+)$/i);
    const numeric = match ? Number(match[1]) : 0;
    return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
  };
  const parent = read(draft.groupId) || 1;
  const reserved = new Set([parent, ...variants.map((variant) => read(variant.groupId)).filter(Boolean)]);
  const used = new Set([parent]);
  let next = parent + 1;
  return [String(parent), ...variants.map((variant) => {
    let group = read(variant.groupId);
    if (!group || used.has(group)) {
      while (reserved.has(next) || used.has(next)) next += 1;
      group = next++;
    }
    used.add(group);
    return String(group);
  })];
}

function text(value, field, maximum = 2000) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > maximum) throw generalProductError(`Invalid ${field}.`);
  return value.trim();
}

function identifier(value, field) {
  const result = text(value, field, 100);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(result)) throw generalProductError(`Invalid ${field}.`);
  return result;
}

function title(value, row) {
  const result = text(value, "product title", 100).replace(/[“”"']/g, "").replace(/\s+/g, " ");
  if (result.length < 20 || !result.toLowerCase().includes(row.productType.toLowerCase()) || !result.endsWith(`(Pack of ${Number(row.quantity)})`)) {
    throw generalProductError(`Title must include ${row.productType} and end with (Pack of ${Number(row.quantity)}).`);
  }
  if (/phone charms holder|lanyard insert tabs/i.test(row.productType) && /\b(id cards?|badge|name tag)\b/i.test(result)) {
    throw generalProductError("Phone charms holders must not be described as ID card holders.");
  }
  if ([...result.matchAll(/(?:pack of|set of)\s+(\d+)|(\d+)\s*(?:pcs|pieces)\b/gi)].some((match) => Number(match[1] || match[2]) !== Number(row.quantity))) {
    throw generalProductError("The title contains an incorrect pack quantity.");
  }
  return result;
}

export function generalProductSku(codes, quantity, version) {
  return `${CODE_FIELDS.map((field) => codes[field]).join("-")}-${Number(quantity)}PC-V${version}`;
}

function normalizeSku(value, field = "SKU") {
  const sku = text(value, field, 110).replace(/(?:\.D)+$/i, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(sku)) throw generalProductError(`${field} must contain 1–100 letters, numbers, hyphens, underscores or dots, starting with a letter or number.`);
  return sku;
}

function validateRow(row) {
  for (const field of ["category", "genericName", "productType"]) {
    if (!row[field] || row[field].length > 150) throw generalProductError(`Choose a valid ${field}.`);
  }
  const quantity = Number(row.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) throw generalProductError("Pack quantity must be between 1 and 9999.");
  row.productName = title(row.productName, row);
  for (const field of ["price", "wrongDefectiveReturnsPrice", "mrp", "weight", "inventory", "gst", "length", "width"]) {
    if (["length", "width"].includes(field) && !row[field]) continue;
    if (!row[field] || !Number.isFinite(Number(row[field])) || Number(row[field]) < 0) throw generalProductError(`Enter a valid ${field}.`);
  }
  if (!Number.isInteger(Number(row.inventory))) throw generalProductError("Inventory must be a whole number.");
  if (Number(row.gst) > 100) throw generalProductError("GST cannot exceed 100%.");
  if (Number(row.price) > Number(row.mrp)) throw generalProductError("Price cannot exceed MRP.");
  if (Number(row.wrongDefectiveReturnsPrice) > Number(row.price)) throw generalProductError("Wrong/defective returns price cannot exceed Meesho price.");
  for (const field of ["image1", "image2", "image3", "image4"]) {
    if (field !== "image1" && !row[field]) continue;
    try {
      const url = new URL(row[field]);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error();
    } catch { throw generalProductError(`Provide a hosted HTTPS ${field} URL.`); }
  }
}

export function normalizeGeneralProduct(input) {
  if (!isObject(input) || !isObject(input.draft) || !isObject(input.codes) || !Array.isArray(input.variants)) {
    throw generalProductError("Provide the parent product, SKU codes, and variants.");
  }
  if (input.variants.length > 500) throw generalProductError("A product can contain at most 500 variants.");
  const draft = Object.fromEntries(LISTING_FIELDS.map((field) => [field, text(input.draft[field], field)]));
  draft.id = identifier(draft.id, "product ID");
  const codes = Object.fromEntries(CODE_FIELDS.map((field) => {
    const code = text(input.codes[field], field, 100).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
    if (!code) throw generalProductError(`Enter a valid ${field}.`);
    return [field, code];
  }));
  const parentVersion = Number(input.parentVersion);
  if (!Number.isSafeInteger(parentVersion) || parentVersion < 1) throw generalProductError("Invalid parent version.");
  const ids = new Set([draft.id]);
  const variants = input.variants.map((variant) => {
    if (!isObject(variant)) throw generalProductError("Invalid variant.");
    const id = identifier(variant.id, "variant ID");
    if (ids.has(id)) throw generalProductError("Product and variant IDs must be unique.");
    ids.add(id);
    const version = Number(variant.version);
    if (!Number.isSafeInteger(version) || version <= parentVersion) throw generalProductError("Variant versions must follow the parent version.");
    if (variant.overrides !== undefined && !isObject(variant.overrides)) throw generalProductError("Invalid variant overrides.");
    const overrides = Object.fromEntries(OVERRIDE_FIELDS.filter((field) => Object.hasOwn(variant.overrides || {}, field))
      .map((field) => [field, text(variant.overrides[field], field)]));
    const groupId = text(variant.groupId, "variant Group ID", 100);
    if (groupId && !/^(?:Group\s+)?\d+$/i.test(groupId)) throw generalProductError("Variant Group ID must be a positive integer.");
    if (groupId && (!Number.isSafeInteger(Number(groupId.replace(/^Group\s+/i, ""))) || Number(groupId.replace(/^Group\s+/i, "")) < 1)) {
      throw generalProductError("Variant Group ID must be a positive integer.");
    }
    const skuOverride = variant.skuOverride === undefined || variant.skuOverride === null ? null : normalizeSku(variant.skuOverride, "Variant SKU");
    return { id, productName: text(variant.productName, "variant title", 100), version, groupId, overrides, skuOverride };
  });
  const groups = generalProductListingGroups(draft, variants);
  draft.groupId = groups[0];
  variants.forEach((variant, index) => { variant.groupId = groups[index + 1]; });
  const productContext = text(input.productContext, "product context", 500);
  const skuOverride = input.skuOverride === undefined || input.skuOverride === null ? null : normalizeSku(input.skuOverride, "Parent SKU");
  draft.sku = skuOverride ?? generalProductSku(codes, draft.quantity, parentVersion);
  draft.styleId = draft.sku;
  validateRow(draft);
  const rows = [draft, ...variants.map((variant) => {
    const row = { ...draft, ...variant.overrides, id: variant.id, productName: variant.productName, groupId: variant.groupId };
    row.sku = variant.skuOverride ?? generalProductSku(codes, row.quantity, variant.version);
    row.styleId = row.sku;
    validateRow(row);
    variant.productName = row.productName;
    return row;
  })];
  const skus = rows.map((row) => row.sku);
  if (new Set(skus).size !== skus.length) throw generalProductError("Each parent and variant must have a unique SKU.");
  const data = { clientId: draft.id, draft, codes, variants, parentVersion, productContext, skuOverride, rows, skus };
  const contentHash = createHash("sha256").update(JSON.stringify(data)).digest("hex");
  return { ...data, contentHash };
}

export function serializeGeneralProduct(document) {
  const data = typeof document.toObject === "function" ? document.toObject() : document;
  const groups = generalProductListingGroups(data.draft, data.variants);
  const sku = normalizeSku(data.draft.sku);
  return {
    draft: { ...data.draft, groupId: groups[0], sku, styleId: sku }, codes: data.codes,
    skuOverride: data.skuOverride == null ? null : normalizeSku(data.skuOverride),
    variants: data.variants.map((variant, index) => ({ ...variant, groupId: groups[index + 1],
      skuOverride: variant.skuOverride == null ? null : normalizeSku(variant.skuOverride) })),
    parentVersion: data.parentVersion, productContext: data.productContext,
    databaseId: String(data._id), databaseRevision: data.revision,
    createdAt: data.createdAt, updatedAt: data.updatedAt,
  };
}

export async function saveGeneralProduct(Model, input) {
  const normalized = normalizeGeneralProduct(input);
  const existing = await Model.findOne({ clientId: normalized.clientId }).lean();
  // Legacy .D records still occupy these identifiers until the seller saves
  // the updated family. Do not allow a new product to reuse their base SKU.
  const occupied = await Model.findOne({ clientId: { $ne: normalized.clientId },
    skus: { $in: normalized.skus.flatMap((sku) => [sku, `${sku}.D`, `${sku}.d`]) } }).lean();
  if (occupied) throw generalProductError("A SKU is already saved in another product. Choose a unique SKU; existing records were not overwritten.", 409);
  if (existing) {
    if (input.databaseId && String(existing._id) !== input.databaseId) throw generalProductError("Saved product ID does not match this product.", 409);
    if (existing.contentHash === normalized.contentHash) return { product: serializeGeneralProduct(existing), action: "unchanged" };
    if (!input.databaseId || !Number.isInteger(input.databaseRevision)) {
      throw generalProductError("This product is already saved. Reopen it from Saved general products before editing.", 409);
    }
    const updated = await Model.findOneAndUpdate(
      { _id: input.databaseId, clientId: normalized.clientId, revision: input.databaseRevision },
      { $set: normalized, $inc: { revision: 1 } },
      { returnDocument: "after", runValidators: true },
    );
    if (!updated) throw generalProductError("This product changed in another session. Reopen the latest saved version before saving.", 409);
    return { product: serializeGeneralProduct(updated), action: "updated" };
  }
  if (input.databaseId) throw generalProductError("The saved product no longer exists. Reopen the catalog before saving.", 404);
  try {
    const created = await Model.create({ ...normalized, revision: 1 });
    return { product: serializeGeneralProduct(created), action: "created" };
  } catch (error) {
    // Concurrent or repeated requests with identical content are idempotent.
    if (error.code === 11000) {
      const concurrent = await Model.findOne({ clientId: normalized.clientId }).lean();
      if (concurrent?.contentHash === normalized.contentHash) return { product: serializeGeneralProduct(concurrent), action: "unchanged" };
      throw generalProductError("One of these SKUs is already saved. Reopen the saved product or change the SKU codes/version; existing data was not overwritten.", 409);
    }
    throw error;
  }
}

export function generalProductAnalyticsPipeline(now = new Date()) {
  const numeric = (field) => ({ $convert: { input: `$rows.${field}`, to: "double", onError: 0, onNull: 0 } });
  const inventory = numeric("inventory");
  const price = numeric("price");
  const value = { $multiply: [inventory, price] };
  const distribution = (field) => [
    { $unwind: "$rows" },
    { $group: { _id: `$rows.${field}`, listings: { $sum: 1 }, inventory: { $sum: inventory }, value: { $sum: value } } },
    { $sort: { listings: -1, _id: 1 } },
  ];
  return [{ $facet: {
    products: [{ $group: {
      _id: null, totalProducts: { $sum: 1 }, totalVariants: { $sum: { $size: "$variants" } },
      productsWithVariants: { $sum: { $cond: [{ $gt: [{ $size: "$variants" }, 0] }, 1, 0] } },
      newProducts7Days: { $sum: { $cond: [{ $gte: ["$createdAt", new Date(now.getTime() - 7 * 86400000)] }, 1, 0] } },
      newProducts30Days: { $sum: { $cond: [{ $gte: ["$createdAt", new Date(now.getTime() - 30 * 86400000)] }, 1, 0] } },
    } }],
    listings: [{ $unwind: "$rows" }, { $group: {
      _id: null, totalListings: { $sum: 1 }, totalInventory: { $sum: inventory }, inventoryValue: { $sum: value },
      averagePrice: { $avg: price }, minimumPrice: { $min: price }, maximumPrice: { $max: price },
      lowStock: { $sum: { $cond: [{ $and: [{ $gt: [inventory, 0] }, { $lte: [inventory, 10] }] }, 1, 0] } },
      outOfStock: { $sum: { $cond: [{ $eq: [inventory, 0] }, 1, 0] } },
    } }],
    categories: distribution("category"), packSizes: distribution("quantity"),
  } }];
}

export function serializeGeneralAnalytics(result = {}) {
  const defaults = {
    totalProducts: 0, totalVariants: 0, productsWithVariants: 0, newProducts7Days: 0, newProducts30Days: 0,
    totalListings: 0, totalInventory: 0, inventoryValue: 0, averagePrice: 0, minimumPrice: 0, maximumPrice: 0, lowStock: 0, outOfStock: 0,
  };
  const stats = { ...defaults, ...result.products?.[0], ...result.listings?.[0] };
  delete stats._id;
  const map = (rows) => (rows || []).map(({ _id, ...data }) => ({ name: String(_id || "Not specified"), ...data }));
  return { stats, categories: map(result.categories), packSizes: map(result.packSizes) };
}
