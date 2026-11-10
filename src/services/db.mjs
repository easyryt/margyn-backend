import { closeInventoryDatabase } from "../tools/inventory-admin/mongoose-context.mjs";
import { closeListingDatabase } from "../tools/listing-tool/mongoose-context.mjs";
import dns from "node:dns";
const configuredDns = process.env.MONGODB_DNS_SERVERS?.split(",")
  .map((value) => value.trim())
  .filter(Boolean);
if (
  configuredDns?.length &&
  dns.getServers().join(",") !== configuredDns.join(",")
)
  dns.setServers(configuredDns);
import { MongoClient } from "mongodb";
import { AppError } from "./errors.mjs";
const stateKey = Symbol.for("margyn.mongo");
export async function getDb() {
  if (!process.env.MONGODB_URI)
    throw new AppError(
      "MongoDB is not configured. Set MONGODB_URI on the server.",
      503,
    );
  const databaseName = process.env.MONGODB_DB || "margyn_marketplace";
  let state = globalThis[stateKey];
  if (!state) {
    const client = new MongoClient(process.env.MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
    });
    state = { client, promise: null };
    globalThis[stateKey] = state;
    state.promise = (async () => {
      await client.connect();
      const db = client.db(databaseName);
      await Promise.all([
        db.collection("users").createIndex({ phone: 1 }, { unique: true }),
        db
          .collection("sessions")
          .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        db
          .collection("otp_challenges")
          .createIndex({ phone: 1 }, { unique: true }),
        db
          .collection("otp_challenges")
          .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        db
          .collection("rate_limits")
          .createIndex({ resetsAt: 1 }, { expireAfterSeconds: 0 }),
        db.collection("products").createIndex({ sku: 1 }, { unique: true }),
        db
          .collection("products")
          .createIndex({ status: 1, featured: -1, createdAt: -1 }),
        db
          .collection("carts")
          .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        db
          .collection("orders")
          .createIndex({ userId: 1, idempotencyKey: 1 }, { unique: true }),
        db
          .collection("orders")
          .createIndex({ orderNumber: 1 }, { unique: true }),
        db.collection("orders").createIndex({ createdAt: -1 }),
        db.collection("coupons").createIndex({ code: 1 }, { unique: true }),
        db.collection("token_events").createIndex({ userId: 1, createdAt: -1 }),
        db.collection("storage_legacy_files").createIndex({ userId: 1 }),
        db.collection("ai_plan_purchases").createIndex({ userId: 1, idempotencyKey: 1 }, { unique: true }),
        db.collection("ai_plan_purchases").createIndex({ orderId: 1 }, { unique: true, sparse: true }),
        db.collection("ai_plan_purchases").createIndex({ paymentId: 1 }, { unique: true, sparse: true }),
      ]);
      return db;
    })().catch(async () => {
      delete globalThis[stateKey];
      await client.close().catch(() => {});
      throw new AppError(
        "Cannot connect to MongoDB. Check the connection settings and Atlas network access.",
        503,
      );
    });
  }
  return state.promise;
}
export async function transaction(work) {
  const db = await getDb();
  return globalThis[stateKey].client.withSession((session) =>
    session.withTransaction(() => work(db, session), {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
      maxCommitTimeMS: 15000,
    }),
  );
}
export async function closeDb() {
  await closeInventoryDatabase();
  await closeListingDatabase();
  const state = globalThis[stateKey];
  delete globalThis[stateKey];
  if (state) {
    await state.promise.catch(() => {});
    await state.client.close();
  }
}
export function publicUser(row) {
  return row
    ? {
        id: row._id,
        phone: row.phone,
        name: row.name || "",
        role: row.role,
        createdAt: row.createdAt,
      }
    : null;
}
