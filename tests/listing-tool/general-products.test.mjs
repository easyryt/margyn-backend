import assert from "node:assert/strict";
import test from "node:test";
import GeneralProduct from "../../src/tools/listing-tool/original/src/models/GeneralProduct.mjs";
import {
  LISTING_FIELDS, normalizeGeneralProduct, saveGeneralProduct,
  serializeGeneralProduct, serializeGeneralAnalytics, generalProductAnalyticsPipeline,
} from "../../src/tools/listing-tool/original/src/services/general-products.mjs";

function fixture(id = "parent-test", version = 1) {
  return {
    draft: { ...Object.fromEntries(LISTING_FIELDS.map((field) => [field, ""])), id,
      productName: "Universal Transparent Mobile Case Lanyard Insert Tabs Phone Charms Holder (Pack of 10)",
      category: "Beads & Charms", genericName: "Beads & Charms", productType: "Phone Charms Holder",
      quantity: "10", price: "64", wrongDefectiveReturnsPrice: "63", mrp: "399", gst: "18", weight: "10",
      inventory: "2000", hsn: "392640", manufacturerPincode: "Mobiro", variation: "Free Size",
      image1: "https://example.com/product.png", groupId: "Group 01", styleId: "tampered", sku: "tampered",
    },
    codes: { brandCode: "MBRO", categoryCode: "CHM", productCode: "HLDR", colorCode: "GLD" },
    parentVersion: version, productContext: "Lanyard insert tabs", variants: [{
      id: `${id}-variant`, productName: "Transparent Mobile Case Phone Charms Holder Insert Tabs (Pack of 10)", version: version + 1,
      overrides: { price: "70", wrongDefectiveReturnsPrice: "69", inventory: "8" },
    }],
  };
}

function modelDouble() {
  const records = [];
  const Model = {
    records,
    findOne: (filter) => ({ lean: async () => structuredClone(records.find((record) => {
      if (typeof filter.clientId === "string") return record.clientId === filter.clientId;
      return record.clientId !== filter.clientId.$ne && record.skus.some((sku) => filter.skus.$in.includes(sku));
    }) || null) }),
    async create(data) {
      if (records.some((record) => record.clientId === data.clientId || record.skus.some((sku) => data.skus.includes(sku)))) {
        throw Object.assign(new Error("Duplicate key"), { code: 11000 });
      }
      const record = { ...structuredClone(data), _id: String(records.length + 1).padStart(24, "0"), createdAt: new Date(), updatedAt: new Date() };
      records.push(record); return structuredClone(record);
    },
    async findOneAndUpdate(filter, update, options) {
      assert.equal(options.runValidators, true);
      const record = records.find((item) => item._id === filter._id && item.clientId === filter.clientId && item.revision === filter.revision);
      if (!record) return null;
      if (records.some((item) => item !== record && item.skus.some((sku) => update.$set.skus.includes(sku)))) throw Object.assign(new Error("Duplicate key"), { code: 11000 });
      Object.assign(record, structuredClone(update.$set), { revision: record.revision + update.$inc.revision, updatedAt: new Date() });
      return structuredClone(record);
    },
  };
  return Model;
}

test("general products use a separate collection and unique SKU index", () => {
  assert.equal(GeneralProduct.collection.name, "general_products");
  assert.ok(GeneralProduct.schema.indexes().some(([fields, options]) => fields.skus === 1 && options.unique));
});

test("save all parent/variant fields and derive trustworthy matching IDs", () => {
  const data = normalizeGeneralProduct(fixture());
  assert.equal(data.rows.length, 2);
  assert.equal(data.draft.sku, "MBRO-CHM-HLDR-GLD-10PC-V1");
  assert.equal(data.draft.styleId, data.draft.sku);
  assert.equal(data.rows[1].sku, "MBRO-CHM-HLDR-GLD-10PC-V2");
  assert.equal(data.rows[1].price, "70");
  assert.equal(data.rows[1].wrongDefectiveReturnsPrice, "69", "Store the actual return price, not the phone discount field");
  assert.equal(data.rows[1].inventory, "8");
  assert.deepEqual(data.rows.map((row) => row.groupId), ["1", "2"]);
  assert.equal(data.variants[0].groupId, "2");
  assert.equal(data.draft.manufacturerPincode, "Mobiro", "Preserve source values without inventing details");
  assert.equal(data.contentHash.length, 64);
  const codes = fixture(); codes.codes.productCode = "LONG-CHARMS-HOLDER";
  assert.equal(normalizeGeneralProduct(codes).draft.sku, "MBRO-CHM-LONGCHARMSHO-GLD-10PC-V1", "Match frontend SKU normalization");
});

test("validate every effective variant row before any database write", () => {
  for (const change of [
    (data) => { data.variants[0].productName = "Transparent ID Card Holders (Pack of 10)"; },
    (data) => { data.variants[0].overrides.quantity = "15"; },
    (data) => { data.variants[0].version = data.parentVersion; },
    (data) => { data.variants[0].id = data.draft.id; },
    (data) => { data.draft.price = "400"; },
    (data) => { data.draft.inventory = "1.5"; },
    (data) => { data.draft.image1 = "file:///private/image.png"; },
    (data) => { data.draft.gst = "101"; },
    (data) => { data.variants[0].groupId = "0"; },
    (data) => { data.variants[0].groupId = "2.5"; },
    (data) => { data.variants[0].groupId = "invalid"; },
  ]) {
    const data = fixture(); change(data);
    assert.throws(() => normalizeGeneralProduct(data), (error) => error.status === 400);
  }
});

test("store AI-generated SKU codes with the actual title pack quantity", async () => {
  const Model = modelDouble();
  const input = fixture();
  input.draft.quantity = "3";
  input.draft.productName = input.draft.productName.replace("Pack of 10", "Pack of 3");
  input.variants[0].productName = input.variants[0].productName.replace("Pack of 10", "Pack of 3");
  const { product } = await saveGeneralProduct(Model, input);
  assert.equal(product.draft.sku, "MBRO-CHM-HLDR-GLD-3PC-V1");
  assert.equal(product.draft.styleId, product.draft.sku);
  assert.equal(Model.records[0].rows[1].sku, "MBRO-CHM-HLDR-GLD-3PC-V2");
  const beads = fixture("blue-beads");
  beads.codes.productCode = "BEAD";
  beads.codes.colorCode = "BLU";
  beads.draft.productType = "Craft Beads";
  beads.draft.productName = "Blue Craft Beads for Jewellery Making (Pack of 10)";
  beads.variants[0].productName = "Blue Craft Beads for Bracelet Making (Pack of 10)";
  const saved = await saveGeneralProduct(Model, beads);
  assert.equal(saved.product.draft.sku, "MBRO-CHM-BEAD-BLU-10PC-V1");
  assert.equal(Model.records.length, 2);
});

test("an entire parent with 30 variants is stored in one atomic document", async () => {
  const Model = modelDouble();
  const data = fixture();
  data.variants = Array.from({ length: 30 }, (_, index) => ({
    ...data.variants[0], id: `variant-${index}`, version: index + 2,
  }));
  const result = await saveGeneralProduct(Model, data);
  assert.equal(result.action, "created");
  assert.equal(Model.records.length, 1);
  assert.equal(Model.records[0].rows.length, 31);
  assert.equal(result.product.variants.length, 30);
  assert.deepEqual(Model.records[0].rows.map((row) => row.groupId), Array.from({ length: 31 }, (_, index) => String(index + 1)));
});

test("legacy reads show distinct groups without changing the stored document", () => {
  const document = { ...fixture(), _id: "legacy", revision: 1 };
  const before = structuredClone(document);
  const product = serializeGeneralProduct(document);
  assert.equal(product.draft.groupId, "1");
  assert.equal(product.variants[0].groupId, "2");
  assert.deepEqual(document, before);
});

test("add variants to a saved family without replacing existing listings", async () => {
  const Model = modelDouble();
  const first = await saveGeneralProduct(Model, fixture());
  const edited = structuredClone(first.product);
  edited.variants.push(
    { id: "added-3", version: 3, groupId: "3", productName: "Universal Phone Charms Holder Tabs for Mobile Cases (Pack of 10)" },
    { id: "added-4", version: 4, groupId: "4", productName: "Clear Phone Charms Holder Inserts for Lanyards (Pack of 10)" },
  );
  const updated = await saveGeneralProduct(Model, edited);
  assert.equal(updated.action, "updated");
  assert.equal(updated.product.databaseId, first.product.databaseId);
  assert.equal(updated.product.databaseRevision, 2);
  assert.equal(Model.records.length, 1);
  assert.equal(Model.records[0].rows[0].image1, first.product.draft.image1);
  assert.deepEqual(updated.product.variants[0], first.product.variants[0]);
  assert.deepEqual(Model.records[0].rows.map((row) => row.groupId), ["1", "2", "3", "4"]);
  const afterRemoval = structuredClone(updated.product);
  afterRemoval.variants = afterRemoval.variants.slice(1);
  afterRemoval.variants.push({ id: "added-5", version: 5, groupId: "5", productName: "Phone Charms Holder Clear Tabs for Universal Lanyards (Pack of 10)" });
  await saveGeneralProduct(Model, afterRemoval);
  assert.deepEqual(Model.records[0].rows.map((row) => row.groupId), ["1", "3", "4", "5"], "Existing identifiers remain stable after removal and append");
  const stale = structuredClone(edited);
  stale.variants.push({ id: "stale-added", version: 6, groupId: "6", productName: "Phone Charms Holder Inserts for Mobile Lanyards (Pack of 10)" });
  await assert.rejects(saveGeneralProduct(Model, stale), (error) => error.status === 409);
  assert.equal(Model.records[0].variants.length, 3);
});

test("repeated saves are idempotent and keep the original database ID", async () => {
  const Model = modelDouble();
  const data = fixture();
  const first = await saveGeneralProduct(Model, data);
  const repeat = await saveGeneralProduct(Model, data);
  assert.equal(repeat.action, "unchanged");
  assert.equal(repeat.product.databaseId, first.product.databaseId);
  assert.equal(repeat.product.databaseRevision, 1);
  assert.equal(Model.records.length, 1);
});

test("saved edits update the same family and preserve variant overrides", async () => {
  const Model = modelDouble();
  const first = await saveGeneralProduct(Model, fixture());
  const edited = structuredClone(first.product);
  edited.variants[0].overrides.price = "80";
  edited.variants[0].overrides.inventory = "0";
  const update = await saveGeneralProduct(Model, edited);
  assert.equal(update.action, "updated");
  assert.equal(update.product.databaseId, first.product.databaseId);
  assert.equal(update.product.databaseRevision, 2);
  assert.equal(Model.records[0].rows[1].price, "80");
  assert.equal(Model.records[0].rows[1].inventory, "0");
  assert.equal(Model.records.length, 1);
});

test("stale edits and duplicate SKUs cannot overwrite existing products", async () => {
  const Model = modelDouble();
  const first = await saveGeneralProduct(Model, fixture());
  const edit = structuredClone(first.product); edit.draft.price = "90";
  await saveGeneralProduct(Model, edit);
  const stale = structuredClone(first.product); stale.draft.price = "95";
  await assert.rejects(saveGeneralProduct(Model, stale), (error) => error.status === 409);
  await assert.rejects(saveGeneralProduct(Model, fixture("another-parent")), (error) => error.status === 409);
  assert.equal(Model.records[0].draft.price, "90");
  assert.equal(Model.records.length, 1);
});

test("custom parent and variant SKUs survive save and reopen without a fixed pattern", async () => {
  const Model = modelDouble();
  const input = fixture();
  input.skuOverride = "my-necklace_001";
  input.variants[0].skuOverride = "my-necklace_special";
  const first = await saveGeneralProduct(Model, input);
  assert.equal(first.product.draft.sku, "my-necklace_001");
  assert.equal(first.product.draft.styleId, "my-necklace_001");
  assert.equal(first.product.skuOverride, "my-necklace_001");
  assert.equal(first.product.variants[0].skuOverride, "my-necklace_special");
  assert.equal(Model.records[0].rows[1].sku, "my-necklace_special");
  assert.equal(Model.records[0].rows[1].styleId, "my-necklace_special");
  assert.equal((await saveGeneralProduct(Model, first.product)).action, "unchanged");
  const reset = structuredClone(first.product);
  reset.skuOverride = null;
  reset.variants[0].skuOverride = null;
  const updated = await saveGeneralProduct(Model, reset);
  assert.equal(updated.product.draft.sku, "MBRO-CHM-HLDR-GLD-10PC-V1");
  assert.equal(updated.product.skuOverride, null);
  assert.equal(Model.records[0].rows[1].sku, "MBRO-CHM-HLDR-GLD-10PC-V2");
});

test("remove legacy suffixes on read/save and prevent base-SKU collisions", async () => {
  const Model = modelDouble();
  await saveGeneralProduct(Model, fixture());
  const legacy = Model.records[0];
  legacy.draft.sku += ".D"; legacy.draft.styleId += ".D";
  legacy.skus = legacy.skus.map((sku) => `${sku}.D`);
  legacy.contentHash = "legacy-content-hash";
  const before = structuredClone(legacy);
  const loaded = serializeGeneralProduct(legacy);
  assert.equal(loaded.draft.sku, "MBRO-CHM-HLDR-GLD-10PC-V1");
  assert.deepEqual(legacy, before, "Reading does not migrate stored data");
  await assert.rejects(saveGeneralProduct(Model, fixture("duplicate-parent")), (error) => error.status === 409);
  const updated = await saveGeneralProduct(Model, loaded);
  assert.equal(updated.action, "updated");
  assert.equal(Model.records[0].skus[0], "MBRO-CHM-HLDR-GLD-10PC-V1");
  const edited = structuredClone(updated.product);
  edited.skuOverride = "SELLER-CUSTOM.D";
  edited.variants[0].skuOverride = "SELLER-VARIANT.d";
  await saveGeneralProduct(Model, edited);
  assert.deepEqual(Model.records[0].skus, ["SELLER-CUSTOM", "SELLER-VARIANT"]);
});

test("reject blank, unsafe, duplicate and already occupied custom SKUs", async () => {
  for (const sku of ["", " ", "invalid sku", "=FORMULA", "a".repeat(101)]) {
    const input = fixture(); input.skuOverride = sku;
    assert.throws(() => normalizeGeneralProduct(input), (error) => error.status === 400);
  }
  const duplicate = fixture(); duplicate.skuOverride = "SAME"; duplicate.variants[0].skuOverride = "SAME.D";
  assert.throws(() => normalizeGeneralProduct(duplicate), /unique SKU/);
  const Model = modelDouble();
  const first = fixture(); first.skuOverride = "CUSTOM-PARENT"; first.variants[0].skuOverride = "CUSTOM-VARIANT";
  await saveGeneralProduct(Model, first);
  const other = fixture("other-product", 5); other.skuOverride = "CUSTOM-VARIANT";
  await assert.rejects(saveGeneralProduct(Model, other), (error) => error.status === 409);
  assert.equal(Model.records.length, 1);
});

test("analytics aggregate the saved effective rows, not just the parents", () => {
  const [pipeline] = generalProductAnalyticsPipeline(new Date("2026-10-07T12:00:00Z"));
  assert.deepEqual(pipeline.$facet.listings[0], { $unwind: "$rows" });
  assert.ok(pipeline.$facet.listings[1].$group.inventoryValue);
  assert.ok(pipeline.$facet.products[0].$group.totalVariants);
  assert.equal(serializeGeneralAnalytics().stats.totalListings, 0);
  const result = serializeGeneralAnalytics({
    products: [{ _id: null, totalProducts: 2, totalVariants: 30 }],
    listings: [{ _id: null, totalListings: 32, totalInventory: 123, inventoryValue: 456 }],
    categories: [{ _id: "Beads & Charms", listings: 32, inventory: 123, value: 456 }],
  });
  assert.equal(result.stats.totalProducts, 2);
  assert.equal(result.stats.totalListings, 32);
  assert.equal(result.stats.inventoryValue, 456);
  assert.equal(result.categories[0].name, "Beads & Charms");
  assert.equal(Object.hasOwn(result.stats, "_id"), false);
});
