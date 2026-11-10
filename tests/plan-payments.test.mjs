import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { startTestBackend } from "./support/runtime.mjs";
import { getDb } from "../src/services/db.mjs";
import { ensureTokenAccount, getSubscription } from "../src/services/subscriptions.mjs";
const origin = "http://ai-plans.test";
const realFetch = globalThis.fetch;

test("AI plans expose offers without usage details and activate only verified test purchases", { timeout: 120000 }, async t => {
  const runtime = await startTestBackend(origin);
  t.after(async () => { globalThis.fetch = realFetch; await runtime.close(); });
  let orderCalls = 0, failProvider = false, allowCapture = false, capturedCalls = 0;
  const orders = new Map(), payments = new Map();
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith("https://api.razorpay.com/v1/")) return realFetch(url, options);
    assert.equal(options.headers.Authorization, "Basic " + Buffer.from("rzp_test_isolated:isolated-test-razorpay-secret").toString("base64"));
    if (failProvider) return Response.json({ error: { description: process.env.RAZORPAY_KEY_SECRET } }, { status: 401 });
    const path = new URL(url).pathname;
    if (path === "/v1/orders" && options.method === "POST") {
      const body = JSON.parse(options.body), id = "order_fixture" + ++orderCalls;
      assert.equal(body.partial_payment, undefined);
      const order = { id, amount: body.amount, currency: body.currency, receipt: body.receipt };
      orders.set(id, order); return Response.json(order);
    }
    if (path.endsWith("/capture")) {
      const id = path.split("/").at(-2), payment = payments.get(id), body = JSON.parse(options.body);
      assert.equal(body.amount, payment.amount); assert.equal(body.currency, "INR");
      const updated = allowCapture ? { ...payment, status: "captured", captured: true } : payment;
      if (allowCapture) capturedCalls++;
      payments.set(id, updated); return Response.json(updated);
    }
    if (path.startsWith("/v1/payments/")) return Response.json(payments.get(path.split("/").at(-1)) || {}, { status: 200 });
    if (/\/orders\/[^/]+\/payments$/.test(path)) return Response.json({ items: [...payments.values()].filter(payment => payment.order_id === path.split("/")[3]) });
    throw new Error("Unexpected payment API request: " + path);
  };
  function client() {
    let cookie = "";
    return { user: null,
      async request(path, method = "GET", body) {
        const response = await realFetch(runtime.url + "/api" + path, { method, headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const session = response.headers.getSetCookie().find(value => value.startsWith("margyn_session="));
        if (session) cookie = session.split(";")[0];
        return { status: response.status, data: await response.json() };
      },
      async login(phone) {
        const challenge = (await this.request("/auth/request-otp", "POST", { phone })).data;
        const result = await this.request("/auth/verify-otp", "POST", { challengeId: challenge.challengeId, code: challenge.developmentCode });
        assert.equal(result.status, 200); this.user = result.data.user;
        await ensureTokenAccount(this.user.id);
        await (await getDb()).collection("token_accounts").updateOne({ _id: this.user.id }, { $set: { tokenLimit: 0 } });
      },
    };
  }
  const admin = client(), alice = client(), bob = client(), guest = client();
  await admin.login("9876543201"); await alice.login("9876543271"); await bob.login("9876543272");
  const paid = { id: "studio", name: "Studio AI", tokenLimit: 1000, durationDays: 30, pricePaise: 19900, offers: ["AI product images", "AI listing assistance"], published: true };
  const free = { ...paid, id: "free", name: "Free AI", tokenLimit: 50, pricePaise: 0 };
  const legacy = { id: "basic", name: "Basic AI", tokenLimit: 100, durationDays: 30 };
  const hidden = { ...paid, id: "hidden", published: false };
  const save = plans => admin.request("/admin/subscription-settings", "PUT", { defaultTokenLimit: 0, plans });
  const create = (owner, planId = "studio", idempotencyKey = randomUUID(), extra = {}) => owner.request("/subscription/purchases", "POST", { planId, idempotencyKey, ...extra });
  function paymentFor(data, changes = {}) {
    const payment = { id: "pay_fixture" + payments.size, order_id: data.checkout.orderId, amount: data.checkout.amount, currency: "INR", status: "captured", captured: true, ...changes };
    payments.set(payment.id, payment); return payment;
  }
  function callback(data, payment) {
    return { purchaseId: data.purchase.id, razorpay_order_id: data.checkout.orderId, razorpay_payment_id: payment.id,
      razorpay_signature: createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(data.checkout.orderId + "|" + payment.id).digest("hex") };
  }
  await t.test("saved legacy and new plans are visible, hidden plans stay private, and public data has no usage counters", async () => {
    assert.equal((await save([paid, free, legacy, hidden])).status, 200);
    const catalog = await alice.request("/subscription/plans");
    assert.deepEqual(catalog.data.plans.map(plan => plan.id), ["studio", "free", "basic"]);
    assert.deepEqual(catalog.data.plans[0].offers, paid.offers);
    assert.equal(catalog.data.plans[2].pricePaise, null);
    assert.equal(/token/i.test(JSON.stringify(catalog.data)), false);
    assert.equal(/token/i.test(JSON.stringify((await alice.request("/subscription")).data)), false);
    assert.equal((await guest.request("/subscription/plans")).status, 401);
    assert.equal((await create(guest)).status, 401);
    assert.equal((await create(alice, "hidden")).status, 404);
    assert.equal((await create(alice, "basic")).status, 409);
    assert.equal((await alice.request("/admin/subscription-settings", "PUT", {})).status, 403);
    for (const changes of [{ pricePaise: -1 }, { pricePaise: 1.5 }, { offers: ["x".repeat(141)] }, { offers: Array(13).fill("AI") }, { published: "yes" }, { tokenLimit: 0 }])
      assert.equal((await save([{ ...paid, ...changes }])).status, 400);
  });
  let purchase, captured;
  await t.test("checkout uses server prices and snapshots; request retries do not create another order", async () => {
    const key = randomUUID();
    const result = await create(alice, "studio", key, { amount: 1, tokenLimit: 999999 });
    assert.equal(result.status, 201); purchase = result.data;
    assert.equal(purchase.checkout.amount, 19900); assert.equal(purchase.checkout.mode, "test"); assert.equal(orderCalls, 1);
    assert.equal(/token/i.test(JSON.stringify(purchase)), false);
    const repeated = await create(alice, "studio", key);
    assert.equal(repeated.data.purchase.id, purchase.purchase.id); assert.equal(orderCalls, 1);
    assert.equal((await create(alice, "free", key)).status, 409);
    assert.equal((await getSubscription(alice.user.id)).canUseAi, false);
    await save([{ ...paid, pricePaise: 49900, tokenLimit: 2000, offers: ["New offer"] }, free, legacy]);
    assert.equal((await alice.request(`/subscription/purchases/${purchase.purchase.id}/checkout`)).data.checkout.amount, 19900);
    assert.equal((await bob.request(`/subscription/purchases/${purchase.purchase.id}/checkout`)).status, 404);
  });
  await t.test("forged, wrong-owner, wrong-amount and uncaptured payments do not grant AI access", async () => {
    captured = paymentFor(purchase);
    const valid = callback(purchase, captured);
    assert.equal((await alice.request("/subscription/verify-payment", "POST", { ...valid, razorpay_signature: "0".repeat(64) })).status, 400);
    assert.equal((await bob.request("/subscription/verify-payment", "POST", valid)).status, 404);
    payments.set(captured.id, { ...captured, amount: 1 });
    assert.equal((await alice.request("/subscription/verify-payment", "POST", valid)).status, 400);
    payments.set(captured.id, { ...captured, status: "authorized", captured: false });
    assert.equal((await alice.request("/subscription/verify-payment", "POST", valid)).status, 409);
    assert.equal((await getSubscription(alice.user.id)).canUseAi, false);
    payments.set(captured.id, captured);
  });
  await t.test("captured payment activates the purchased snapshot once, including repeat callbacks", async () => {
    const valid = callback(purchase, captured);
    const result = await alice.request("/subscription/verify-payment", "POST", valid);
    assert.equal(result.status, 200); assert.equal(result.data.purchase.status, "active");
    assert.deepEqual(result.data.subscription.offers, paid.offers); assert.equal(/token/i.test(JSON.stringify(result.data)), false);
    const internal = await getSubscription(alice.user.id);
    assert.equal(internal.tokenLimit, 1000); assert.ok(internal.expiresAt > Date.now() + 29 * 86400000);
    await (await getDb()).collection("token_accounts").updateOne({ _id: alice.user.id }, { $set: { usedTokens: 100, inputTokens: 60, outputTokens: 40 } });
    const repeats = await Promise.all([alice.request("/subscription/verify-payment", "POST", valid), alice.request("/subscription/verify-payment", "POST", valid)]);
    assert.ok(repeats.every(result => result.status === 200)); assert.equal((await getSubscription(alice.user.id)).usedTokens, 100);
    assert.equal(await (await getDb()).collection("token_events").countDocuments({ purchaseId: purchase.purchase.id, type: "plan-purchase" }), 1);
    await save([paid, free, legacy, hidden]);
  });
  await t.test("signed raw-body webhooks recover a closed checkout and are idempotent", async () => {
    const data = (await create(bob)).data, payment = paymentFor(data);
    const raw = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: payment } } });
    const signature = createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest("hex");
    const send = (body, value) => realFetch(runtime.url + "/api/subscription/payments/razorpay/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Razorpay-Signature": value }, body });
    assert.equal((await send(raw, "0".repeat(64))).status, 400);
    assert.equal((await send(raw + " ", signature)).status, 400);
    assert.equal((await send(raw, signature)).status, 200); assert.equal((await send(raw, signature)).status, 200);
    assert.equal((await getSubscription(bob.user.id)).canUseAi, true);
    assert.equal(await (await getDb()).collection("token_events").countDocuments({ purchaseId: data.purchase.id, type: "plan-purchase" }), 1);
    assert.equal((await alice.request(`/subscription/purchases/${data.purchase.id}/refresh`, "POST", {})).status, 404);
    assert.ok((await alice.request("/subscription/purchases")).data.purchases.every(row => row.id !== data.purchase.id));
  });
  await t.test("Check payment recovers missing callbacks and activation waits for an active AI call", async () => {
    const data = (await create(alice)).data, payment = paymentFor(data);
    await (await getDb()).collection("token_accounts").updateOne({ _id: alice.user.id }, { $set: { leaseId: "in-flight", leaseUntil: Date.now() + 60000 } });
    const confirmed = await alice.request("/subscription/verify-payment", "POST", callback(data, payment));
    assert.equal(confirmed.status, 200); assert.equal(confirmed.data.purchase.status, "paid");
    assert.equal((await getSubscription(alice.user.id)).usedTokens, 100);
    await (await getDb()).collection("token_accounts").updateOne({ _id: alice.user.id }, { $unset: { leaseId: "", leaseUntil: "" } });
    const activated = await alice.request(`/subscription/purchases/${data.purchase.id}/refresh`, "POST", {});
    assert.equal(activated.status, 200); assert.equal(activated.data.purchase.status, "active");
    const missingCallback = (await create(bob)).data;
    paymentFor(missingCallback);
    assert.equal((await bob.request(`/subscription/purchases/${missingCallback.purchase.id}/refresh`, "POST", {})).data.purchase.status, "active");
  });
  await t.test("free plans cannot be repeatedly claimed to reset AI usage", async () => {
    const result = await create(alice, "free");
    assert.equal(result.status, 201); assert.equal(result.data.purchase.status, "active"); assert.equal(result.data.checkout, null);
    assert.equal((await create(alice, "free")).status, 409);
    assert.equal((await getSubscription(alice.user.id)).tokenLimit, 50);
    assert.equal((await create(alice, "free", randomUUID(), { tokenLimit: 9999999 })).status, 409);
  });
  await t.test("test-only configuration blocks live keys and provider errors never expose secrets", async () => {
    const before = orderCalls;
    await (await getDb()).collection("token_accounts").updateOne({ _id: alice.user.id }, { $set: { unreportedCalls: 1 } });
    assert.equal((await create(alice)).status, 409); assert.equal(orderCalls, before);
    await (await getDb()).collection("token_accounts").updateOne({ _id: alice.user.id }, { $set: { unreportedCalls: 0 } });
    const id = process.env.RAZORPAY_KEY_ID;
    process.env.RAZORPAY_KEY_ID = "rzp_live_forbidden";
    assert.equal((await create(alice)).status, 503);
    process.env.RAZORPAY_KEY_ID = id;
    failProvider = true;
    const result = await create(alice);
    assert.equal(result.status, 502); assert.ok(!JSON.stringify(result.data).includes(process.env.RAZORPAY_KEY_SECRET));
    failProvider = false;
    const adminData = (await admin.request("/admin/subscriptions")).data;
    assert.ok(adminData.purchases.length >= 5);
    assert.ok(!JSON.stringify(adminData).includes(process.env.RAZORPAY_KEY_SECRET));
  });
  await t.test("authorized test payments are captured for the exact quoted amount before activation", async () => {
    const data = (await create(alice)).data;
    const payment = paymentFor(data, { status: "authorized", captured: false });
    allowCapture = true;
    try {
      const result = await alice.request("/subscription/verify-payment", "POST", callback(data, payment));
      assert.equal(result.status, 200); assert.equal(result.data.purchase.status, "active");
      assert.equal(capturedCalls, 1); assert.equal(payments.get(payment.id).captured, true);
    } finally { allowCapture = false; }
  });
});
