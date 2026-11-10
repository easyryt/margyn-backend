import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { startTestBackend } from "./support/runtime.mjs";
import { getSubscription, getPublicSubscription, saveUserSubscription } from "../src/services/subscriptions.mjs";
import { runImageGeneration } from "../src/services/image-allowance.mjs";
import { storeUserImage, userImageFolder, refreshStorage } from "../src/services/storage-allowance.mjs";
import { getDb } from "../src/services/db.mjs";

test("free and plan image/storage allowances are enforced and preserved across renewals", { timeout: 120000 }, async t => {
  const origin = "http://resources.test";
  const runtime = await startTestBackend(origin);
  const realFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = realFetch; await runtime.close(); });
  function client() {
    let cookie = "";
    return { user: null,
      async request(path, method = "GET", body) {
        const response = await realFetch(runtime.url + "/api" + path, { method, headers: { Origin: origin, Cookie: cookie,
          ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) });
        const value = response.headers.getSetCookie().find(value => value.startsWith("margyn_session="));
        if (value) cookie = value.split(";")[0];
        return { status: response.status, data: await response.json() };
      },
      async login(phone) {
        const sent = await this.request("/auth/request-otp", "POST", { phone });
        const result = await this.request("/auth/verify-otp", "POST", { challengeId: sent.data.challengeId, code: sent.data.developmentCode });
        assert.equal(result.status, 200); this.user = result.data.user;
      },
    };
  }
  const admin = client(), alice = client(), bob = client();
  await admin.login("9876543201"); await alice.login("9876543281"); await bob.login("9876543282");
  const plan = { id: "resources", name: "Studio", tokenLimit: 5000, imageLimit: 8, storageLimitBytes: 200,
    durationDays: 30, pricePaise: 0, offers: ["Listing assistance"], published: true };
  const settings = { defaultTokenLimit: 1000, defaultImageLimit: 3, defaultStorageLimitBytes: 100, plans: [plan] };
  assert.equal((await admin.request("/admin/subscription-settings", "PUT", settings)).status, 200);
  const id = alice.user.id;
  async function assign(changes) {
    const current = await getSubscription(id);
    return saveUserSubscription(id, { planId: null, tokenLimit: current.tokenLimit, imageLimit: current.imageLimit,
      storageLimitBytes: current.storageLimitBytes, status: "active", expiresAt: null, revision: current.revision, ...changes }, admin.user.id);
  }
  const files = new Map();
  let uploadCalls = 0, holdUpload;
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.startsWith("https://upload.imagekit.io/")) {
      uploadCalls++;
      if (holdUpload) await holdUpload;
      const form = options.body;
      const folder = form.get("folder"), name = form.get("fileName");
      const previous = form.get("overwriteFile") === "true" && [...files.values()].find(file => file.filePath === folder + "/" + name);
      const file = { fileId: previous?.fileId ?? "file_" + uploadCalls, filePath: folder + "/" + name, name,
        url: "https://ik.imagekit.io/t9rd9hyjk/" + name, size: form.get("file").size };
      files.set(file.fileId, file); return Response.json(file);
    }
    if (value.startsWith("https://api.imagekit.io/v1/files")) {
      const parsed = new URL(value);
      if (parsed.searchParams.has("path")) {
        const folder = parsed.searchParams.get("path"), skip = Number(parsed.searchParams.get("skip"));
        return Response.json([...files.values()].filter(file => file.filePath.slice(0, file.filePath.lastIndexOf("/")) === folder).slice(skip, skip + 1000));
      }
      const fileId = parsed.pathname.split("/")[3];
      if (options.method === "DELETE") { files.delete(fileId); return new Response(null, { status: 204 }); }
      return files.has(fileId) ? Response.json(files.get(fileId)) : Response.json({}, { status: 404 });
    }
    if (/^https:\/\/(api.openai.com|generativelanguage.googleapis.com)/.test(value)) throw new Error("No real AI requests are allowed in quota tests.");
    return realFetch(url, options);
  };
  const upload = (size, name = "image-" + uploadCalls + ".png", extra = {}) => storeUserImage(id, { file: Buffer.alloc(size), fileName: name, ...extra });
  const imageResponse = count => Response.json({ images: Array.from({ length: count }, () => ({ dataUrl: "data:image/png;base64,AA==" })) });
  const generate = (reserved, completed = reserved) => runImageGeneration(id, async (reserve, record) => { await reserve(reserved); return record(imageResponse(completed)); });

  await t.test("free defaults, public benefits and strict validation", async () => {
    const sub = await getPublicSubscription(id);
    assert.equal(sub.imageLimit, 3); assert.equal(sub.storageLimitBytes, 100); assert.equal(sub.usedImages, 0);
    assert.equal(/token/i.test(JSON.stringify(sub)), false);
    const catalog = (await alice.request("/subscription/plans")).data.plans;
    assert.equal(catalog[0].imageLimit, 8); assert.equal(catalog[0].storageLimitBytes, 200);
    assert.equal(/token/i.test(JSON.stringify(catalog)), false);
    for (const invalid of [-1, 1.5, null, "100"]) {
      assert.equal((await admin.request("/admin/subscription-settings", "PUT", { ...settings, defaultImageLimit: invalid })).status, 400);
      assert.equal((await admin.request("/admin/subscription-settings", "PUT", { ...settings, plans: [{ ...plan, storageLimitBytes: invalid }] })).status, 400);
    }
    assert.equal((await alice.request("/admin/subscription-settings", "PUT", settings)).status, 403);
  });
  await t.test("completed views count once, failures refund and requests cannot bypass image limits", async () => {
    await generate(2, 1); assert.equal((await getSubscription(id)).usedImages, 1);
    let called = false;
    await assert.rejects(runImageGeneration(id, async reserve => { await reserve(3); called = true; }), error => error.status === 402);
    assert.equal(called, false);
    await assert.rejects(runImageGeneration(id, async reserve => { await reserve(1); throw new Error("failed output"); }), /failed output/);
    assert.equal((await getSubscription(id)).usedImages, 1);
    await generate(2); assert.equal((await getSubscription(id)).remainingImages, 0);
    assert.equal((await getPublicSubscription(id)).canGenerateImages, false);
    await assert.rejects(generate(1), error => error.status === 402);
    assert.equal((await getSubscription(bob.user.id)).usedImages, 0);
    const form = new FormData(); form.set("view", "charm-only");
    for (const name of ["cover", "charm"]) form.set(name, new Blob(["fixture"], { type: "image/png" }), name + ".png");
    const blocked = await alice.request("/tools/image-generator/generate-charms", "POST", form);
    assert.equal(blocked.status, 402, JSON.stringify(blocked.data));
    assert.match(blocked.data.error, /image allowance/i);
  });
  await t.test("image reservations guard admin changes and concurrent workers", async () => {
    await assign({ startNewPeriod: true });
    let release, started;
    const ready = new Promise(resolve => { started = resolve; });
    const pending = runImageGeneration(id, async (reserve, record) => {
      await reserve(1); started(); await new Promise(resolve => { release = resolve; }); return record(imageResponse(1));
    });
    await ready;
    await assert.rejects(generate(1), error => error.status === 429);
    await assert.rejects(assign({ imageLimit: 10 }), error => error.status === 409);
    release(); await pending;
  });
  await t.test("storage blocks before upload and replacement/deletion release bytes", async () => {
    const first = await upload(40, "first.png"); await upload(60, "second.png", { folder: userImageFolder(id) + "/listings" });
    assert.equal((await getSubscription(id)).storageUsedBytes, 100);
    const before = uploadCalls; await assert.rejects(upload(1), error => error.status === 402); assert.equal(uploadCalls, before);
    await upload(20, "first.png", { useUniqueFileName: false, overwriteFile: true });
    assert.equal((await getSubscription(id)).storageUsedBytes, 80);
    await assign({ storageLimitBytes: 50 });
    assert.equal((await getSubscription(id)).storageUsedBytes, 80);
    await assert.rejects(upload(1), error => error.status === 402);
    await upload(10, "first.png", { useUniqueFileName: false, overwriteFile: true });
    assert.equal((await getSubscription(id)).storageUsedBytes, 70);
    assert.equal((await bob.request("/tools/inventory-admin/imagekit/delete", "DELETE", { fileId: first.fileId })).status, 404);
    assert.ok(files.has(first.fileId));
    assert.equal((await alice.request("/tools/inventory-admin/imagekit/delete", "DELETE", { fileId: first.fileId })).status, 200);
    assert.equal((await getSubscription(id)).storageUsedBytes, 60);
  });
  await t.test("storage locks serialize uploads and plan changes", async () => {
    await assign({ storageLimitBytes: 200 });
    let release, started;
    const ready = new Promise(resolve => { started = resolve; });
    holdUpload = new Promise(resolve => { release = resolve; });
    const previous = globalThis.fetch;
    globalThis.fetch = async (url, options) => { if (String(url).startsWith("https://upload.imagekit.io/")) started(); return previous(url, options); };
    const pending = upload(20); await ready;
    await assert.rejects(upload(1), error => error.status === 429);
    await assert.rejects(assign({ storageLimitBytes: 100 }), error => error.status === 409);
    release(); await pending; holdUpload = null; globalThis.fetch = previous;
  });
  await t.test("purchases reset AI images, retain bytes and snapshot plan benefits", async () => {
    const before = await getSubscription(id);
    const bought = await alice.request("/subscription/purchases", "POST", { planId: plan.id, idempotencyKey: "resource-fixture-purchase" });
    assert.equal(bought.status, 201, JSON.stringify(bought.data)); assert.equal(bought.data.purchase.status, "active");
    const after = await getSubscription(id);
    assert.equal(after.imageLimit, 8); assert.equal(after.usedImages, 0); assert.equal(after.storageLimitBytes, 200);
    assert.equal(after.storageUsedBytes, before.storageUsedBytes);
    await admin.request("/admin/subscription-settings", "PUT", { ...settings, plans: [{ ...plan, imageLimit: 20, storageLimitBytes: 400 }] });
    assert.equal((await getSubscription(id)).imageLimit, 8); assert.equal((await getSubscription(id)).storageLimitBytes, 200);
    const current = await getSubscription(id);
    await saveUserSubscription(id, { planId: plan.id, tokenLimit: current.tokenLimit, status: "active", expiresAt: current.expiresAt, revision: current.revision }, admin.user.id);
    assert.equal((await getSubscription(id)).imageLimit, 8); assert.equal((await getSubscription(id)).storageLimitBytes, 200);
  });
  await t.test("expired plans block additions, allow deletion, and reconciliation counts all pages", async () => {
    await assign({ expiresAt: Date.now() - 1000 });
    await assert.rejects(upload(1), error => error.status === 403);
    for (let index = 0; index < 1001; index++) files.set("bulk_" + index, { fileId: "bulk_" + index, filePath: userImageFolder(id) + "/bulk-" + index, size: 1 });
    await refreshStorage(id);
    assert.equal((await getSubscription(id)).storageUsedBytes, 1081);
    const refreshed = await alice.request("/subscription/storage/refresh", "POST", {});
    assert.equal(refreshed.status, 200); assert.equal(refreshed.data.subscription.storageUsedBytes, 1081);
    assert.equal(/token/i.test(JSON.stringify(refreshed.data)), false);
    const db = await getDb();
    assert.equal((await db.collection("storage_accounts").findOne({ _id: id })).leaseId, undefined);
  });
  await t.test("a stale image worker retains its reserved usage without keeping the account locked", async () => {
    const db = await getDb();
    await db.collection("token_accounts").updateOne({ _id: id }, { $set: { usedImages: 3, imageLeaseId: "crashed-image-worker", imageLeaseUntil: Date.now() - 1 } });
    assert.equal((await getSubscription(id)).usedImages, 3);
    assert.equal((await db.collection("token_accounts").findOne({ _id: id })).imageLeaseId, undefined);
    await assign({ imageLimit: 5 });
    assert.equal((await getSubscription(id)).imageLimit, 5);
  });
  await t.test("unverified file sizes block new writes and release the storage lock", async () => {
    files.set("missing_size", { fileId: "missing_size", filePath: userImageFolder(id) + "/unknown.png" });
    const before = uploadCalls;
    await assert.rejects(upload(1), error => error.status === 503);
    assert.equal(uploadCalls, before);
    assert.equal((await (await getDb()).collection("storage_accounts").findOne({ _id: id })).leaseId, undefined);
    files.delete("missing_size");
  });
  await t.test("older shared listing references count bytes without permitting deletion", async () => {
    const db = await getDb();
    const key = createHash("sha256").update(id).digest("hex").slice(0, 24);
    files.set("legacy_asset", { fileId: "legacy_asset", filePath: "/design-library/legacy.png", size: 7 });
    await db.collection(`listing_${key}_designs`).insertOne({ imageFileId: "legacy_asset" });
    await refreshStorage(id);
    assert.equal((await getSubscription(id)).storageUsedBytes, 1088);
    const list = await alice.request("/tools/inventory-admin/imagekit/list");
    assert.equal(list.status, 200); assert.equal(list.data.images.some(image => image.fileId === "legacy_asset"), false);
    assert.equal((await alice.request("/tools/inventory-admin/imagekit/delete", "DELETE", { fileId: "legacy_asset" })).status, 404);
    assert.ok(files.has("legacy_asset"));
    await db.collection(`listing_${key}_designs`).deleteMany({ imageFileId: "legacy_asset" });
    await refreshStorage(id); assert.equal((await getSubscription(id)).storageUsedBytes, 1088);
    files.delete("legacy_asset"); await refreshStorage(id);
    assert.equal((await getSubscription(id)).storageUsedBytes, 1081);
  });
});
