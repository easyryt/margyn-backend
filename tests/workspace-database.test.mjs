import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoClient } from "mongodb";
import { startTestBackend } from "./support/runtime.mjs";
import { createWorkspaceDatabase } from "../src/tools/workspace-database.mjs";

test("tool collections use MONGODB_DB, start without legacy data, and isolate every seller", { timeout: 60000 }, async t => {
  const runtime = await startTestBackend();
  const client = new MongoClient(process.env.MONGODB_URI);
  const workspace = createWorkspaceDatabase({ namespace: "fixture", label: "test" });
  t.after(async () => { await workspace.close(); await client.close(); await runtime.close(); });
  await client.connect();
  const db = client.db(process.env.MONGODB_DB);
  const oldDb = client.db("legacy_listing_snapshot");
  await oldDb.collection("items").insertOne({ sku: "OLD-DATA", name: "Old listing" });
  await db.collection("items").insertOne({ sku: "OLD-UNSCOPED", name: "Unscoped old listing" });
  const Item = workspace.mongoose.model("WorkspaceItem", new workspace.mongoose.Schema({
    sku: { type: String, unique: true }, group: { type: workspace.mongoose.Schema.Types.ObjectId, ref: "WorkspaceGroup" },
  }), "items");
  const Group = workspace.mongoose.model("WorkspaceGroup", new workspace.mongoose.Schema({ name: String }), "groups");
  const first = "d0bc0c8b-d89e-4798-8379-6d8d1ba7e61a";
  const second = "8dba956d-589c-4d81-8653-b8bcf5931a74";
  let groupId, itemId, firstCollection;
  await t.test("new workspaces select the configured database and ignore both old stores", async () => {
    await workspace.run(first, async () => {
      assert.equal(workspace.mongoose.connection.name, process.env.MONGODB_DB);
      assert.equal(Item.db.name, process.env.MONGODB_DB);
      assert.equal(await Item.countDocuments(), 0);
      assert.equal(await Item.collection.countDocuments(), 0);
      firstCollection = Item.collection.name;
      assert.match(firstCollection, /^fixture_[a-f0-9]{24}_items$/);
      const group = await Group.create({ name: "First seller" });
      groupId = group._id;
      const item = await Item.create({ sku: "SAME-SKU", group: groupId });
      itemId = item._id;
      assert.equal((await Item.findById(itemId).populate("group")).group.name, "First seller");
      assert.ok((await Item.collection.indexes()).some(index => index.key.sku === 1 && index.unique));
    });
  });
  await t.test("same identifiers and native collection access remain private per account", async () => {
    await workspace.run(second, async () => {
      assert.equal(await Item.countDocuments(), 0);
      assert.notEqual(Item.collection.name, firstCollection);
      assert.equal(await Item.findById(itemId), null);
      assert.equal(await Group.findById(groupId), null);
      const group = await Group.create({ name: "Second seller" });
      await Item.create({ sku: "SAME-SKU", group: group._id });
      assert.equal(await Item.collection.countDocuments(), 1);
    });
    await workspace.run(first, async () => {
      assert.equal(await Item.countDocuments(), 1);
      assert.equal((await Item.findOne().populate("group")).group.name, "First seller");
    });
  });
  await t.test("nested reports join only the current seller's collections", async () => {
    for (const [user, expected] of [[first, "First seller"], [second, "Second seller"]]) {
      await workspace.run(user, async () => {
        const result = await Item.aggregate([{ $facet: { rows: [{ $lookup: { from: "groups", localField: "group", foreignField: "_id", pipeline: [{ $project: { name: 1 } }], as: "details" } }] } }]);
        assert.equal(result[0].rows[0].details[0].name, expected);
        const union = await Item.aggregate([{ $unionWith: { coll: "groups", pipeline: [{ $project: { name: 1 } }] } }]);
        assert.equal(union.find(row => row.name)?.name, expected);
        await assert.rejects(Item.aggregate([{ $lookup: { from: "products", localField: "sku", foreignField: "sku", as: "private" } }]), /outside your tool workspace/);
        await assert.rejects(Item.aggregate([{ $out: "products" }]), /Aggregate writes are unavailable/);
      });
    }
  });
  await t.test("old records and marketplace data remain intact and no per-seller databases are created", async () => {
    assert.equal(await oldDb.collection("items").countDocuments(), 1);
    assert.equal(await db.collection("items").countDocuments(), 1);
    assert.equal(await db.collection("products").countDocuments(), 6);
    const databases = await client.db("admin").admin().listDatabases({ nameOnly: true });
    assert.equal(databases.databases.some(({ name }) => /^margyn_(listing|inventory)/.test(name)), false);
  });
});
