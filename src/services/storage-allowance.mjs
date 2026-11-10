import { createHash, randomUUID } from "node:crypto";
import { getDb, transaction } from "./db.mjs";
import { ensureTokenAccount, subscriptionSummary } from "./subscriptions.mjs";
import { AppError } from "./errors.mjs";

const API = "https://api.imagekit.io/v1/files";
const userKey = id => createHash("sha256").update(id).digest("hex").slice(0, 24);
export const userImageFolder = id => "/margyn/inventory/" + userKey(id);
const validSize = value => Number.isSafeInteger(value) && value >= 0;
export async function imageLibraryRequest(url, options = {}) {
  const key = process.env.IMAGEKIT_PRIVATE_KEY;
  if (!key) throw new AppError("The image library is not configured.", 503);
  const response = await globalThis.fetch(url, { ...options, headers: { ...options.headers,
    Authorization: "Basic " + Buffer.from(key + ":").toString("base64") }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new AppError(response.status === 404 ? "Image not found." : "The image library request failed. Please try again.", response.status === 404 ? 404 : 502);
  return response.status === 204 ? {} : response.json();
}
async function listFolder(folder) {
  const all = [];
  for (let skip = 0; skip < 100_000; skip += 1000) {
    let page;
    try { page = await imageLibraryRequest(API + "?" + new URLSearchParams({ path: folder, type: "file", fileType: "image", sort: "ASC_CREATED", limit: "1000", skip: String(skip) })); }
    catch (error) { if (error.status === 404) return all; throw error; }
    if (!Array.isArray(page)) throw new AppError("Storage usage could not be checked. Please try again.", 502);
    all.push(...page.filter(file => file.filePath?.startsWith(folder + "/")));
    if (page.length < 1000) return all;
  }
  throw new AppError("Your image library needs an administrator storage review.", 503);
}
async function ownedFiles(userId) {
  const db = await getDb();
  const folder = userImageFolder(userId);
  // ImageKit's path filter is not recursive. Enumerate both server-owned upload locations.
  const files = [...await listFolder(folder), ...await listFolder(folder + "/listings")];
  // Old shared scanner assets count toward usage but never grant library ownership.
  const designs = await db.collection(`listing_${userKey(userId)}_designs`).find({ imageFileId: { $type: "string", $ne: "" } }, { projection: { imageFileId: 1 } }).toArray();
  const known = await db.collection("storage_legacy_files").find({ userId }).toArray();
  const general = await db.collection(`listing_${userKey(userId)}_general_products`).find({}, { projection: { "draft.image1": 1 } }).toArray();
  const legacyUrls = new Set(general.map(row => row.draft?.image1).filter(url => typeof url === "string" && url.includes("/general-product-listings/")));
  if (legacyUrls.size) {
    for (const file of await listFolder("/general-product-listings")) {
      if (!legacyUrls.has(file.url)) continue;
      await db.collection("storage_legacy_files").updateOne({ _id: userId + ":" + file.fileId }, { $set: { userId, fileId: file.fileId } }, { upsert: true });
      files.push({ ...file, readOnly: true });
    }
  }
  const ids = new Set([...designs.map(row => row.imageFileId), ...known.map(row => row.fileId)]);
  for (const id of ids) {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id) || files.some(file => file.fileId === id)) continue;
    let file;
    try { file = await imageLibraryRequest(API + "/" + encodeURIComponent(id) + "/details"); }
    catch (error) { if (error.status === 404) continue; throw error; }
    if (!file.filePath?.startsWith("/design-library/") && !file.filePath?.startsWith("/general-product-listings/")) continue;
    await db.collection("storage_legacy_files").updateOne({ _id: userId + ":" + id }, { $set: { userId, fileId: id } }, { upsert: true });
    files.push({ ...file, readOnly: true });
  }
  return [...new Map(files.map(file => [file.fileId, file])).values()];
}
export async function withImageLibrary(userId, operation) {
  await ensureTokenAccount(userId);
  const leaseId = randomUUID();
  await transaction(async (db, session) => {
    let row = await db.collection("storage_accounts").findOne({ _id: userId }, { session });
    if (!row) {
      await db.collection("storage_accounts").insertOne({ _id: userId, usedBytes: 0, syncedAt: null }, { session });
      row = {};
    }
    if (row.leaseUntil > Date.now()) throw new AppError("Your image library is busy. Please try again shortly.", 429);
    await db.collection("storage_accounts").updateOne({ _id: userId }, { $set: { leaseId, leaseUntil: Date.now() + 360_000 } }, { session });
    // Serialize allowance changes and storage operations, including across workers.
    await db.collection("token_accounts").updateOne({ _id: userId }, { $inc: { revision: 1 } }, { session });
  });
  const db = await getDb();
  try {
    const files = await ownedFiles(userId);
    if (files.some(file => !validSize(file.size))) throw new AppError("Storage usage could not be verified. Please try again or contact your administrator.", 503);
    let usedBytes = files.reduce((sum, file) => sum + file.size, 0);
    await db.collection("storage_accounts").updateOne({ _id: userId, leaseId }, { $set: { usedBytes, syncedAt: Date.now() } });
    const library = {
      files: files.filter(file => !file.readOnly),
      async checkCapacity(extraBytes) {
        if (!validSize(extraBytes)) throw new AppError("Invalid image size.");
        await transaction(async (db, session) => {
          if (!(await db.collection("storage_accounts").findOne({ _id: userId, leaseId, leaseUntil: { $gt: Date.now() } }, { session }))) throw new AppError("Your file operation expired. Please try again.", 409);
          const account = await db.collection("token_accounts").findOne({ _id: userId }, { session });
          if (extraBytes > 0 && subscriptionSummary(account).status !== "active") throw new AppError("Your plan is inactive. Renew it before uploading images.", 403);
          if (extraBytes > 0 && usedBytes + extraBytes > account.storageLimitBytes) throw new AppError("Your storage limit has been reached. Delete saved images or choose a plan with more storage.", 402);
          // Renew immediately before the bounded provider request; touch both rows so
          // plan edits and renewal cannot race with one another across workers.
          await db.collection("storage_accounts").updateOne({ _id: userId, leaseId }, { $set: { leaseUntil: Date.now() + 360_000 } }, { session });
          await db.collection("token_accounts").updateOne({ _id: userId }, { $inc: { revision: 1 } }, { session });
        });
      },
      async saveUsage(bytes) {
        usedBytes = bytes;
        const result = await db.collection("storage_accounts").updateOne({ _id: userId, leaseId, leaseUntil: { $gt: Date.now() } }, { $set: { usedBytes, syncedAt: Date.now() } });
        if (!result.matchedCount) throw new AppError("Storage usage could not be saved. Refresh your image library.", 503);
      },
      get usedBytes() { return usedBytes; },
    };
    return await operation(library);
  } finally {
    await db.collection("storage_accounts").updateOne({ _id: userId, leaseId }, { $unset: { leaseId: "", leaseUntil: "" } });
  }
}
export async function refreshStorage(userId) {
  return withImageLibrary(userId, library => ({ usedBytes: library.usedBytes }));
}
export async function storeUserImage(userId, options) {
  return withImageLibrary(userId, async library => {
    const bytes = Buffer.isBuffer(options.file) ? options.file : Buffer.from(await options.file.arrayBuffer());
    const folder = userImageFolder(userId);
    const target = typeof options.folder === "string" && options.folder.startsWith(folder + "/") ? options.folder : folder;
    const existing = options.overwriteFile && options.useUniqueFileName === false
      ? library.files.find(file => file.filePath === target + "/" + options.fileName) : null;
    // Account storage measures current saved originals, excluding CDN derivatives/version history.
    await library.checkCapacity(Math.max(0, bytes.length - (existing?.size ?? 0)));
    const form = new FormData();
    form.set("file", new Blob([Uint8Array.from(bytes)]), options.fileName);
    form.set("fileName", options.fileName);
    form.set("folder", target);
    form.set("useUniqueFileName", String(options.useUniqueFileName !== false));
    if (options.overwriteFile) form.set("overwriteFile", "true");
    if (options.tags) form.set("tags", options.tags);
    const result = await imageLibraryRequest("https://upload.imagekit.io/api/v1/files/upload", { method: "POST", body: form });
    if (!result.fileId || !result.url) throw new AppError("The image library returned an invalid upload response.", 502);
    await library.saveUsage(library.usedBytes - (existing?.size ?? 0) + (validSize(result.size) ? result.size : bytes.length));
    return result;
  });
}
