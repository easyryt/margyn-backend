import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getDb, transaction } from "./db.mjs";
import { AppError } from "./errors.mjs";
import { ensureTokenAccount, getSubscriptionSettings, publicPlan } from "./subscriptions.mjs";

export function paymentConfiguration() {
  const id = process.env.RAZORPAY_KEY_ID?.trim() || "";
  return { mode: "test", available: /^rzp_test_[A-Za-z0-9]+$/.test(id) && Boolean(process.env.RAZORPAY_KEY_SECRET?.trim()) };
}
function keys() {
  if (!paymentConfiguration().available) throw new AppError("AI plan test payments are not configured yet. Contact your administrator.", 503);
  return { id: process.env.RAZORPAY_KEY_ID.trim(), secret: process.env.RAZORPAY_KEY_SECRET.trim() };
}
async function razorpay(path, body) {
  const { id, secret } = keys();
  let response;
  try {
    response = await fetch("https://api.razorpay.com/v1" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: "Basic " + Buffer.from(id + ":" + secret).toString("base64"), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
    });
  } catch { throw new AppError("The payment service could not be reached. Please try again shortly.", 503); }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) throw new AppError("The payment service could not complete this request. Please try again or contact your administrator.", 502);
  return payload;
}
export function validSignature(message, signature, secret) {
  if (typeof signature !== "string" || !/^[a-f0-9]{64}$/i.test(signature) || !secret) return false;
  return timingSafeEqual(createHmac("sha256", secret).update(message).digest(), Buffer.from(signature, "hex"));
}
function summary(row) {
  return { id: row._id, plan: publicPlan(row.plan), status: row.status, createdAt: row.createdAt,
    activatedAt: row.activatedAt ?? null, paymentId: row.paymentId ?? null, mode: "test" };
}
export async function listPurchases(userId) {
  const rows = await (await getDb()).collection("ai_plan_purchases").find({ userId }).sort({ createdAt: -1 }).limit(20).toArray();
  return rows.map(summary);
}
export async function listAdminPurchases() {
  const db = await getDb();
  const rows = await db.collection("ai_plan_purchases").find({}).sort({ createdAt: -1 }).limit(100).toArray();
  return Promise.all(rows.map(async row => {
    const user = await db.collection("users").findOne({ _id: row.userId }, { projection: { phone: 1, name: 1 } });
    return { ...summary(row), userId: row.userId, phone: user?.phone || "", name: user?.name || "" };
  }));
}
async function activate(id, paymentId = null) {
  const db = await getDb();
  const initial = await db.collection("ai_plan_purchases").findOne({ _id: id });
  if (!initial) throw new AppError("Plan purchase not found.", 404);
  await ensureTokenAccount(initial.userId);
  return transaction(async (db, session) => {
    const purchase = await db.collection("ai_plan_purchases").findOne({ _id: id }, { session });
    if (purchase.status === "active") return summary(purchase);
    if (purchase.paymentId && purchase.paymentId !== paymentId) throw new AppError("Payment does not match this purchase.", 409);
    const account = await db.collection("token_accounts").findOne({ _id: purchase.userId }, { session });
    const now = Date.now();
    const paid = { status: "paid", paidAt: purchase.paidAt ?? now, ...(paymentId ? { paymentId } : {}) };
    const storage = await db.collection("storage_accounts").findOne({ _id: purchase.userId }, { session });
    if (account.leaseUntil > now || account.imageLeaseUntil > now || storage?.leaseUntil > now || account.unreportedCalls) {
      await db.collection("ai_plan_purchases").updateOne({ _id: id }, { $set: paid }, { session });
      return summary({ ...purchase, ...paid });
    }
    if (purchase.plan.pricePaise === 0) {
      const claimId = purchase.userId + ":" + purchase.plan.id;
      const claim = await db.collection("ai_free_plan_claims").findOne({ _id: claimId }, { session });
      if (claim?.availableAt > now) throw new AppError("This free AI plan has already been claimed for this period.", 409);
      await db.collection("ai_free_plan_claims").updateOne({ _id: claimId }, { $set: { availableAt: now + purchase.plan.durationDays * 86400000 } }, { session, upsert: true });
    }
    await db.collection("token_accounts").updateOne({ _id: purchase.userId }, { $set: {
      planId: purchase.plan.id, planName: purchase.plan.name, planOffers: purchase.plan.offers,
      tokenLimit: purchase.plan.tokenLimit, status: "active", expiresAt: now + purchase.plan.durationDays * 86400000,
      imageLimit: purchase.plan.imageLimit ?? account.imageLimit, storageLimitBytes: purchase.plan.storageLimitBytes ?? account.storageLimitBytes, usedImages: 0,
      periodId: randomUUID(), periodStartedAt: now, usedTokens: 0, inputTokens: 0, outputTokens: 0,
      updatedAt: now, lastPurchaseId: id,
    }, $inc: { revision: 1 } }, { session });
    await db.collection("token_events").insertOne({ _id: randomUUID(), type: "plan-purchase", userId: purchase.userId,
      purchaseId: id, planId: purchase.plan.id, createdAt: now, amountPaise: purchase.plan.pricePaise, mode: "test" }, { session });
    const updated = { ...purchase, ...paid, status: "active", activatedAt: now };
    await db.collection("ai_plan_purchases").updateOne({ _id: id }, { $set: { ...paid, status: "active", activatedAt: now } }, { session });
    return summary(updated);
  }).catch(error => {
    if (error.code === 11000) throw new AppError("This plan purchase or payment has already been processed.", 409);
    throw error;
  });
}
function checkout(row) {
  return { purchase: summary(row), checkout: row.status === "pending" && row.orderId ? {
    keyId: row.keyId, orderId: row.orderId, amount: row.plan.pricePaise, currency: "INR", mode: "test",
  } : null };
}
export async function resumePlanCheckout(userId, id) {
  const row = await (await getDb()).collection("ai_plan_purchases").findOne({ _id: id, userId });
  if (!row) throw new AppError("Plan purchase not found.", 404);
  if ((await ensureTokenAccount(userId)).unreportedCalls) throw new AppError("Your AI access needs an administrator review before starting a payment.", 409);
  if (row.keyId !== process.env.RAZORPAY_KEY_ID) throw new AppError("This checkout needs a payment configuration review.", 409);
  return checkout(row);
}
export async function createPlanPurchase(user, input) {
  if (typeof input.planId !== "string" || typeof input.idempotencyKey !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(input.idempotencyKey))
    throw new AppError("Choose an AI plan and retry checkout.");
  const db = await getDb();
  const existing = await db.collection("ai_plan_purchases").findOne({ userId: user.id, idempotencyKey: input.idempotencyKey });
  if (existing) {
    if (existing.plan.id !== input.planId) throw new AppError("This checkout belongs to another plan. Start a new checkout.", 409);
    if (existing.status === "creating") throw new AppError("Checkout is still being prepared. Please try again shortly.", 409);
    if (existing.status === "failed") throw new AppError("Start a new checkout to try this plan again.", 409);
    return checkout(existing);
  }
  const plan = (await getSubscriptionSettings()).plans.find(plan => plan.id === input.planId && plan.published);
  if (!plan) throw new AppError("This AI plan is no longer available.", 404);
  if (plan.pricePaise === null) throw new AppError("Pricing for this AI plan is being set up. Please check back soon.", 409);
  if ((await ensureTokenAccount(user.id)).unreportedCalls) throw new AppError("Your AI access needs an administrator review before starting a payment.", 409);
  if (plan.pricePaise > 0) keys();
  const row = { _id: randomUUID(), userId: user.id, idempotencyKey: input.idempotencyKey, plan: structuredClone(plan),
    status: "creating", createdAt: Date.now(), mode: "test", keyId: plan.pricePaise > 0 ? process.env.RAZORPAY_KEY_ID : null };
  try { await db.collection("ai_plan_purchases").insertOne(row); }
  catch (error) { if (error.code === 11000) throw new AppError("Checkout is already being prepared. Please try again shortly.", 409); throw error; }
  if (plan.pricePaise === 0) {
    try { return { purchase: await activate(row._id), checkout: null }; }
    catch (error) {
      await db.collection("ai_plan_purchases").updateOne({ _id: row._id }, { $set: { status: "failed" } });
      throw error;
    }
  }
  try {
    const order = await razorpay("/orders", { amount: plan.pricePaise, currency: "INR", receipt: row._id, notes: { purchaseId: row._id } });
    if (typeof order.id !== "string" || !/^order_[a-zA-Z0-9]+$/.test(order.id) || order.amount !== plan.pricePaise || order.currency !== "INR")
      throw new AppError("The payment service returned an invalid checkout. Please try again.", 502);
    await db.collection("ai_plan_purchases").updateOne({ _id: row._id }, { $set: { orderId: order.id, status: "pending" } });
    return checkout({ ...row, orderId: order.id, status: "pending" });
  } catch (error) {
    await db.collection("ai_plan_purchases").updateOne({ _id: row._id }, { $set: { status: "failed" } });
    throw error;
  }
}
async function confirmCaptured(purchase, paymentId) {
  if (!/^pay_[a-zA-Z0-9]+$/.test(paymentId || "")) throw new AppError("Invalid payment reference.");
  if (purchase.keyId !== process.env.RAZORPAY_KEY_ID) throw new AppError("This checkout needs a payment configuration review.", 409);
  let payment = await razorpay("/payments/" + encodeURIComponent(paymentId));
  const matches = value => value.id === paymentId && value.order_id === purchase.orderId && value.amount === purchase.plan.pricePaise && value.currency === "INR";
  if (!matches(payment))
    throw new AppError("The payment does not match this AI plan purchase.", 400);
  if (payment.status === "authorized") {
    try { payment = await razorpay("/payments/" + encodeURIComponent(paymentId) + "/capture", { amount: purchase.plan.pricePaise, currency: "INR" }); }
    catch { payment = await razorpay("/payments/" + encodeURIComponent(paymentId)); }
  }
  if (!matches(payment)) throw new AppError("The captured payment does not match this AI plan purchase.", 400);
  if (payment.status !== "captured" || payment.captured !== true) throw new AppError("Payment is still being confirmed. Use Check payment in a moment.", 409);
  return activate(purchase._id, paymentId);
}
export async function verifyPlanPayment(userId, input) {
  if (typeof input.purchaseId !== "string" || typeof input.razorpay_payment_id !== "string") throw new AppError("Invalid payment reference.");
  const purchase = await (await getDb()).collection("ai_plan_purchases").findOne({ _id: input.purchaseId, userId });
  if (!purchase) throw new AppError("Plan purchase not found.", 404);
  const { secret } = keys();
  if (!purchase.orderId || input.razorpay_order_id !== purchase.orderId || !validSignature(purchase.orderId + "|" + input.razorpay_payment_id, input.razorpay_signature, secret))
    throw new AppError("Payment verification failed. Please use Check payment or contact your administrator.", 400);
  return confirmCaptured(purchase, input.razorpay_payment_id);
}
export async function refreshPlanPurchase(userId, id) {
  const purchase = await (await getDb()).collection("ai_plan_purchases").findOne({ _id: id, userId });
  if (!purchase) throw new AppError("Plan purchase not found.", 404);
  if (purchase.status === "active") return summary(purchase);
  if (purchase.status === "paid") return activate(purchase._id, purchase.paymentId ?? null);
  if (!purchase.orderId) throw new AppError("This checkout could not be prepared. Start a new checkout.", 409);
  const result = await razorpay("/orders/" + encodeURIComponent(purchase.orderId) + "/payments");
  const captured = result.items?.find(payment => payment.status === "captured" && payment.captured === true)
    ?? result.items?.find(payment => payment.status === "authorized");
  if (!captured) throw new AppError("Payment has not been confirmed yet. No AI plan has been activated.", 409);
  return confirmCaptured(purchase, captured.id);
}
export async function planPaymentWebhook(req, res) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET?.trim();
  if (!secret) throw new AppError("Payment webhooks are not configured.", 503);
  if (!Buffer.isBuffer(req.body) || !validSignature(req.body, req.get("x-razorpay-signature"), secret)) throw new AppError("Invalid webhook signature.", 400);
  let event;
  try { event = JSON.parse(req.body.toString("utf8")); } catch { throw new AppError("Invalid payment event."); }
  if (!["payment.captured", "order.paid"].includes(event.event)) return res.json({ received: true });
  const payment = event.payload?.payment?.entity;
  const purchase = payment?.order_id && await (await getDb()).collection("ai_plan_purchases").findOne({ orderId: payment.order_id });
  if (purchase) await confirmCaptured(purchase, payment.id);
  res.json({ received: true });
}
