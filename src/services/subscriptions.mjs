import { randomUUID } from "node:crypto";
import { getDb, transaction } from "./db.mjs";
import { AppError } from "./errors.mjs";

const SETTINGS_ID = "token-subscriptions";
const MAX_TOKENS = 1_000_000_000;
export const DEFAULT_IMAGE_LIMIT = 10;
export const DEFAULT_STORAGE_BYTES = 100 * 1024 * 1024;
export function resourceNumber(value, label, max) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new AppError(`${label} must be a whole number from 0 to ${max.toLocaleString("en-IN")}.`);
  return value;
}
export const imageNumber = value => resourceNumber(value, "AI image allowance", 1_000_000);
export const storageNumber = value => resourceNumber(value, "Storage allowance in bytes", 1024 ** 4);
const supplied = (value, fallback) => value === undefined ? fallback : value;
export function tokenNumber(value, label = "Token allowance") {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TOKENS)
    throw new AppError(`${label} must be a whole number from 0 to 1,000,000,000.`);
  return value;
}
export async function getSubscriptionSettings() {
  const row = await (await getDb()).collection("site_settings").findOne({ _id: SETTINGS_ID });
  return { defaultTokenLimit: row?.defaultTokenLimit ?? 0,
    defaultImageLimit: row?.defaultImageLimit ?? DEFAULT_IMAGE_LIMIT,
    defaultStorageLimitBytes: row?.defaultStorageLimitBytes ?? DEFAULT_STORAGE_BYTES,
    plans: (row?.plans ?? []).map(plan => ({
    ...plan, pricePaise: plan.pricePaise ?? null, offers: plan.offers ?? [], published: plan.published !== false,
    imageLimit: plan.imageLimit ?? row?.defaultImageLimit ?? DEFAULT_IMAGE_LIMIT,
    storageLimitBytes: plan.storageLimitBytes ?? row?.defaultStorageLimitBytes ?? DEFAULT_STORAGE_BYTES,
  })) };
}
export async function saveSubscriptionSettings(input, adminId) {
  const defaultTokenLimit = tokenNumber(input.defaultTokenLimit);
  const previousSettings = await getSubscriptionSettings();
  const defaultImageLimit = imageNumber(supplied(input.defaultImageLimit, previousSettings.defaultImageLimit));
  const defaultStorageLimitBytes = storageNumber(supplied(input.defaultStorageLimitBytes, previousSettings.defaultStorageLimitBytes));
  if (!Array.isArray(input.plans) || input.plans.length > 20)
    throw new AppError("Add up to 20 subscription plans.");
  const previousPlans = previousSettings.plans;
  const ids = new Set();
  const plans = input.plans.map(plan => {
    if (!plan || typeof plan !== "object" || typeof plan.name !== "string" || !plan.name.trim() || plan.name.trim().length > 60)
      throw new AppError("Each plan needs a name of 1–60 characters.");
    const id = plan.id ?? randomUUID();
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || ids.has(id))
      throw new AppError("Each plan needs a unique identifier.");
    ids.add(id);
    if (!Number.isInteger(plan.durationDays) || plan.durationDays < 1 || plan.durationDays > 3650)
      throw new AppError("Plan duration must be 1–3,650 days.");
    const previous = previousPlans.find(previous => previous.id === id);
    const pricePaise = plan.pricePaise === undefined ? previous?.pricePaise ?? null : plan.pricePaise;
    if (pricePaise !== null && (!Number.isSafeInteger(pricePaise) || pricePaise < 0 || pricePaise > 100_000_000))
      throw new AppError("Plan price must be between ₹0 and ₹10,00,000, with at most two decimal places.");
    const offers = plan.offers === undefined ? previous?.offers ?? [] : plan.offers;
    if (!Array.isArray(offers) || offers.length > 12 || offers.some(offer => typeof offer !== "string" || !offer.trim() || offer.trim().length > 140))
      throw new AppError("Add up to 12 offers per plan, each between 1 and 140 characters.");
    if (plan.published !== undefined && typeof plan.published !== "boolean") throw new AppError("Choose whether this plan is visible to users.");
    const tokenLimit = tokenNumber(plan.tokenLimit);
    const published = plan.published === undefined ? previous?.published ?? true : plan.published;
    if (published && pricePaise !== null && tokenLimit === 0) throw new AppError("A purchasable AI plan needs a positive internal AI allowance.");
    return { id, name: plan.name.trim(), tokenLimit, durationDays: plan.durationDays,
      imageLimit: imageNumber(supplied(plan.imageLimit, previous?.imageLimit ?? defaultImageLimit)),
      storageLimitBytes: storageNumber(supplied(plan.storageLimitBytes, previous?.storageLimitBytes ?? defaultStorageLimitBytes)),
      pricePaise, offers: offers.map(offer => offer.trim()), published };
  });
  await (await getDb()).collection("site_settings").updateOne({ _id: SETTINGS_ID }, {
    $set: { defaultTokenLimit, defaultImageLimit, defaultStorageLimitBytes, plans, updatedBy: adminId, updatedAt: Date.now() },
  }, { upsert: true });
  return { defaultTokenLimit, defaultImageLimit, defaultStorageLimitBytes, plans };
}
export async function ensureTokenAccount(userId) {
  const db = await getDb();
  let account = await db.collection("token_accounts").findOne({ _id: userId });
  if (account?.leaseUntil && account.leaseUntil <= Date.now()) {
    // A crashed worker may have sent a billable request. Never silently reuse its allowance.
    const recovered = await db.collection("token_accounts").updateOne({ _id: userId, leaseId: account.leaseId, leaseUntil: account.leaseUntil }, {
      $inc: { unreportedCalls: 1, revision: 1 }, $unset: { leaseId: "", leaseUntil: "" },
    });
    if (recovered.modifiedCount) await db.collection("token_events").insertOne({ _id: randomUUID(), type: "interrupted-provider-call", userId,
      periodId: account.periodId, createdAt: Date.now(), uncertain: true });
    account = await db.collection("token_accounts").findOne({ _id: userId });
  }
  if (account) {
    if (account.imageLeaseUntil && account.imageLeaseUntil <= Date.now()) {
      // Keep the reserved image count after a crash, but do not retain a stale lock.
      await db.collection("token_accounts").updateOne({ _id: userId, imageLeaseId: account.imageLeaseId, imageLeaseUntil: account.imageLeaseUntil }, {
        $unset: { imageLeaseId: "", imageLeaseUntil: "" }, $inc: { revision: 1 },
      });
      account = await db.collection("token_accounts").findOne({ _id: userId });
    }
    if (account.imageLimit === undefined || account.storageLimitBytes === undefined) {
      const settings = await getSubscriptionSettings();
      const plan = settings.plans.find(plan => plan.id === account.planId);
      await db.collection("token_accounts").updateOne({ _id: userId, revision: account.revision }, { $set: {
        imageLimit: account.imageLimit ?? plan?.imageLimit ?? settings.defaultImageLimit,
        storageLimitBytes: account.storageLimitBytes ?? plan?.storageLimitBytes ?? settings.defaultStorageLimitBytes,
        usedImages: account.usedImages ?? 0,
      }, $inc: { revision: 1 } });
      return db.collection("token_accounts").findOne({ _id: userId });
    }
    return account;
  }
  if (!await db.collection("users").findOne({ _id: userId }, { projection: { _id: 1 } }))
    throw new AppError("User not found.", 404);
  const { defaultTokenLimit, defaultImageLimit, defaultStorageLimitBytes } = await getSubscriptionSettings();
  try {
    await db.collection("token_accounts").updateOne({ _id: userId }, { $setOnInsert: {
      planId: null, planName: "Starting allowance", status: "active", tokenLimit: defaultTokenLimit,
      imageLimit: defaultImageLimit, usedImages: 0, storageLimitBytes: defaultStorageLimitBytes,
      expiresAt: null, periodId: randomUUID(), periodStartedAt: Date.now(),
      usedTokens: 0, inputTokens: 0, outputTokens: 0, unreportedCalls: 0, revision: 0,
    } }, { upsert: true });
  } catch (error) { if (error.code !== 11000) throw error; }
  return db.collection("token_accounts").findOne({ _id: userId });
}
export function subscriptionSummary(account, now = Date.now()) {
  const status = account.status === "active" && account.expiresAt !== null && account.expiresAt <= now
    ? "expired" : account.status;
  return {
    planId: account.planId, planName: account.planName, status, tokenLimit: account.tokenLimit,
    expiresAt: account.expiresAt, periodStartedAt: account.periodStartedAt,
    usedTokens: account.usedTokens, inputTokens: account.inputTokens, outputTokens: account.outputTokens,
    remainingTokens: Math.max(0, account.tokenLimit - account.usedTokens),
    imageLimit: account.imageLimit ?? DEFAULT_IMAGE_LIMIT, usedImages: account.usedImages ?? 0,
    remainingImages: Math.max(0, (account.imageLimit ?? DEFAULT_IMAGE_LIMIT) - (account.usedImages ?? 0)),
    storageLimitBytes: account.storageLimitBytes ?? DEFAULT_STORAGE_BYTES,
    unreportedCalls: account.unreportedCalls, revision: account.revision,
    canUseAi: status === "active" && account.usedTokens < account.tokenLimit && account.unreportedCalls === 0,
  };
}
export async function getSubscription(userId) {
  const summary = subscriptionSummary(await ensureTokenAccount(userId));
  const storage = await (await getDb()).collection("storage_accounts").findOne({ _id: userId });
  return { ...summary, storageUsedBytes: storage?.usedBytes ?? 0, storageSyncedAt: storage?.syncedAt ?? null,
    canGenerateImages: summary.canUseAi && summary.remainingImages > 0 };
}
export function publicPlan(plan) {
  return { id: plan.id, name: plan.name, pricePaise: plan.pricePaise ?? null, durationDays: plan.durationDays, offers: plan.offers ?? [],
    imageLimit: plan.imageLimit ?? DEFAULT_IMAGE_LIMIT, storageLimitBytes: plan.storageLimitBytes ?? DEFAULT_STORAGE_BYTES };
}
export async function listPublicPlans() {
  return (await getSubscriptionSettings()).plans.filter(plan => plan.published).map(publicPlan);
}
export async function getPublicSubscription(userId) {
  const account = await ensureTokenAccount(userId);
  const summary = await getSubscription(userId);
  const plan = (await getSubscriptionSettings()).plans.find(plan => plan.id === account.planId);
  return { planId: summary.planId, planName: summary.planName === "Starting allowance" ? "Starter AI access" : summary.planName === "Custom allowance" ? "Custom AI access" : summary.planName,
    status: summary.status, expiresAt: summary.expiresAt, canUseAi: summary.canUseAi,
    requiresReview: summary.unreportedCalls > 0, offers: account.planOffers ?? plan?.offers ?? [],
    imageLimit: summary.imageLimit, usedImages: summary.usedImages, remainingImages: summary.remainingImages,
    canGenerateImages: summary.canGenerateImages, storageLimitBytes: summary.storageLimitBytes,
    storageUsedBytes: summary.storageUsedBytes, storageSyncedAt: summary.storageSyncedAt };
}
export async function listSubscriptions() {
  const db = await getDb();
  const users = await db.collection("users").find({}, { projection: { phone: 1, name: 1, role: 1 } }).sort({ createdAt: -1 }).toArray();
  return Promise.all(users.map(async user => ({ id: user._id, phone: user.phone, name: user.name || "", role: user.role,
    subscription: await getSubscription(user._id) })));
}
export function assertAiAccess(account) {
  const summary = subscriptionSummary(account);
  if (summary.status !== "active") throw new AppError(`Your AI subscription is ${summary.status}. Contact your administrator to renew or activate it.`, 403);
  if (summary.unreportedCalls) throw new AppError("AI usage is awaiting review. Contact your administrator.", 503);
  if (!summary.remainingTokens) throw new AppError("Your AI allowance has been reached. Choose an AI plan or contact your administrator.", 402);
}
export async function saveUserSubscription(userId, input, adminId) {
  const current = await ensureTokenAccount(userId);
  const settings = await getSubscriptionSettings();
  const plan = input.planId === null ? null : settings.plans.find(item => item.id === input.planId);
  if (input.planId !== null && !plan) throw new AppError("Choose an available subscription plan or Custom allowance.");
  const tokenLimit = tokenNumber(input.tokenLimit);
  const samePlan = input.planId === current.planId;
  const imageLimit = imageNumber(supplied(input.imageLimit, samePlan ? current.imageLimit : plan?.imageLimit ?? current.imageLimit));
  const storageLimitBytes = storageNumber(supplied(input.storageLimitBytes, samePlan ? current.storageLimitBytes : plan?.storageLimitBytes ?? current.storageLimitBytes));
  if (!["active", "paused", "cancelled"].includes(input.status)) throw new AppError("Choose Active, Paused or Cancelled.");
  if (input.expiresAt !== null && (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= 0 || input.expiresAt > 8_640_000_000_000_000))
    throw new AppError("Enter a valid subscription expiry date, or leave it empty.");
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw new AppError("Refresh this account before saving.");
  for (const key of ["startNewPeriod", "clearUsageHold"]) {
    if (input[key] !== undefined && typeof input[key] !== "boolean") throw new AppError("Invalid subscription setting.");
  }
  return transaction(async (db, session) => {
    const now = Date.now();
    const account = await db.collection("token_accounts").findOne({ _id: userId }, { session });
    if (account.revision !== input.revision) throw new AppError("This subscription changed. Refresh accounts and try again.", 409);
    if (account.leaseUntil > now || account.imageLeaseUntil > now) throw new AppError("An AI call is running for this user. Save after it finishes.", 409);
    if ((await db.collection("storage_accounts").findOne({ _id: userId }, { session }))?.leaseUntil > now) throw new AppError("A file operation is running for this user. Save after it finishes.", 409);
    const changes = { planId: plan?.id ?? null, planName: plan?.name ?? "Custom AI access", planOffers: plan?.offers ?? [], tokenLimit,
      imageLimit, storageLimitBytes, status: input.status, expiresAt: input.expiresAt, updatedBy: adminId, updatedAt: now };
    if (input.startNewPeriod) Object.assign(changes, { periodId: randomUUID(), periodStartedAt: now, usedTokens: 0, inputTokens: 0, outputTokens: 0, usedImages: 0 });
    if (input.clearUsageHold) changes.unreportedCalls = 0;
    const updated = await db.collection("token_accounts").findOneAndUpdate({ _id: userId, revision: input.revision },
      { $set: changes, $inc: { revision: 1 } }, { session, returnDocument: "after" });
    if (!updated) throw new AppError("This subscription changed. Refresh accounts and try again.", 409);
    await db.collection("token_events").insertOne({ _id: randomUUID(), type: "subscription-update", userId, adminId,
      createdAt: now, previous: subscriptionSummary(account), subscription: subscriptionSummary(updated),
      startNewPeriod: input.startNewPeriod === true, clearUsageHold: input.clearUsageHold === true }, { session });
    const storage = await db.collection("storage_accounts").findOne({ _id: userId }, { session });
    return { ...subscriptionSummary(updated), storageUsedBytes: storage?.usedBytes ?? 0, storageSyncedAt: storage?.syncedAt ?? null };
  });
}
