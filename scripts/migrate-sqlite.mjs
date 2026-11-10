import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
process.env.DATA_DIR = path.resolve(
  fileURLToPath(new URL("../", import.meta.url)),
  process.env.LEGACY_DATA_DIR || "../margyn-2026/.data",
);
import { getDb as legacy } from "./legacy/sqlite.mjs";
import {
  listProducts as oldProducts,
  listUsers as oldUsers,
} from "./legacy/sqlite.mjs";
import { getDb, closeDb } from "../src/services/db.mjs";
import { validateProduct } from "../src/services/store.mjs";
try {
  if (
    !fs.existsSync(
      path.resolve(process.env.DATA_DIR || ".data", "packi.sqlite"),
    )
  )
    throw new Error("No previous SQLite database found. Nothing was changed.");
  const db = await getDb();
  let products = 0,
    users = 0;
  for (const previous of oldProducts(true)) {
    const packSize = Number(
      previous.unit.match(/(?:of|pack)\s*(\d+)/i)?.[1] || 1,
    );
    const price = Math.round((previous.price / packSize) * 100) / 100;
    const data = validateProduct({
      ...previous,
      price,
      compareAt: Math.round((previous.compareAt / packSize) * 100) / 100,
      unit: "piece",
      packSize,
      vendor: "Margyn",
      verified: false,
      specification: "Standard quality",
      sizes: ["Standard"],
      gstRate: 0,
      tiers: [{ minCartons: previous.minOrder, price }],
    });
    const result = await db.collection("products").updateOne(
      { _id: previous.id },
      {
        $setOnInsert: {
          ...data,
          slug: data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          createdAt: previous.createdAt,
          updatedAt: previous.updatedAt,
        },
      },
      { upsert: true },
    );
    products += result.upsertedCount;
  }
  for (const previous of oldUsers()) {
    const result = await db.collection("users").updateOne(
      { phone: previous.phone },
      {
        $setOnInsert: {
          _id: previous.id,
          phone: previous.phone,
          role: previous.role,
          createdAt: previous.createdAt,
        },
      },
      { upsert: true },
    );
    users += result.upsertedCount;
  }
  for (const image of legacy().prepare("SELECT * FROM media").all())
    await db.collection("media").updateOne(
      { _id: image.id },
      {
        $setOnInsert: {
          mime: image.mime,
          data: Buffer.from(image.data),
          createdAt: image.created_at,
          provider: "legacy",
        },
      },
      { upsert: true },
    );
  console.log(
    `Migration complete: ${products} products and ${users} accounts added. Existing MongoDB records and the SQLite database were preserved.`,
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await closeDb();
}
