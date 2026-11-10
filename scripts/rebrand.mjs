import { getDb, closeDb } from "../src/services/db.mjs";
try {
  const db = await getDb();
  const products = await db
    .collection("products")
    .updateMany(
      { vendor: { $in: ["PACKI", "Packi"] } },
      { $set: { vendor: "Margyn" } },
    );
  const carts = await db
    .collection("carts")
    .updateMany(
      { "entries.vendor": { $in: ["PACKI", "Packi"] } },
      { $set: { "entries.$[entry].vendor": "Margyn" } },
      { arrayFilters: [{ "entry.vendor": { $in: ["PACKI", "Packi"] } }] },
    );
  const orders = await db
    .collection("orders")
    .updateMany(
      { "items.vendor": { $in: ["PACKI", "Packi"] } },
      { $set: { "items.$[item].vendor": "Margyn" } },
      { arrayFilters: [{ "item.vendor": { $in: ["PACKI", "Packi"] } }] },
    );
  console.log(
    `Margyn branding updated: ${products.modifiedCount} products, ${carts.modifiedCount} carts, ${orders.modifiedCount} order snapshots. Account access, IDs, prices and inventory were preserved.`,
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await closeDb();
}
