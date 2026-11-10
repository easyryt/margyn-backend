import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestBackend } from "./support/runtime.mjs";
import { providerUsage, meteredFetch, withAiUsage } from "../src/services/ai-usage.mjs";
import { getSubscription } from "../src/services/subscriptions.mjs";
import { getDb, closeDb } from "../src/services/db.mjs";

test("provider token totals include reasoning and cached input without double counting", () => {
  assert.deepEqual(providerUsage("openai", { usage: { input_tokens: 120, output_tokens: 80, total_tokens: 200,
    input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 40 } } }), { inputTokens: 120, outputTokens: 80, totalTokens: 200 });
  assert.deepEqual(providerUsage("gemini", { usageMetadata: { promptTokenCount: 90, cachedContentTokenCount: 50,
    candidatesTokenCount: 30, thoughtsTokenCount: 10, totalTokenCount: 130 } }), { inputTokens: 90, outputTokens: 40, totalTokens: 130 });
  assert.deepEqual(providerUsage("gemini", { usageMetadata: { promptTokenCount: 90, totalTokenCount: 90 } }), { inputTokens: 90, outputTokens: 0, totalTokens: 90 });
  for (const payload of [{}, { usage: { input_tokens: -1, output_tokens: 2, total_tokens: 1 } }, { usage: { input_tokens: 20, output_tokens: 2, total_tokens: 1 } }]) assert.equal(providerUsage("openai", payload), null);
});

test("subscriptions enforce admin access, durable actual usage, expiry and concurrent request guards", { timeout: 120000 }, async t => {
  const origin = "http://subscriptions.test";
  const runtime = await startTestBackend(origin);
  t.after(() => runtime.close());
  function client() {
    let cookie = "";
    return {
      user: null,
      async request(path, method = "GET", body) {
        const response = await fetch(runtime.url + "/api" + path, { method, headers: { Origin: origin, Cookie: cookie,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const cookies = response.headers.getSetCookie();
        if (cookies.length) cookie = cookies.map(item => item.split(";")[0]).join("; ");
        return { status: response.status, data: await response.json() };
      },
      async login(phone) {
        const challenge = await this.request("/auth/request-otp", "POST", { phone });
        const verified = await this.request("/auth/verify-otp", "POST", { challengeId: challenge.data.challengeId, code: challenge.data.developmentCode });
        assert.equal(verified.status, 200); this.user = verified.data.user;
      },
    };
  }
  const guest = client(), admin = client(), alice = client(), bob = client();
  await admin.login("9876543201"); await alice.login("9876543256"); await bob.login("9876543257");
  const plan = { id: "starter", name: "Starter", tokenLimit: 1000, durationDays: 30 };
  async function assign(changes = {}) {
    const current = await getSubscription(alice.user.id);
    const result = await admin.request(`/admin/users/${alice.user.id}/subscription`, "PUT", {
      planId: null, tokenLimit: current.tokenLimit, status: "active", expiresAt: null, revision: current.revision, ...changes,
    });
    assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data.subscription;
  }
  const aiUrl = "https://api.openai.com/v1/responses";
  const options = { method: "POST", body: JSON.stringify({ model: "fixture-model" }) };
  const openai = (input = 12, output = 8) => Response.json({ usage: { input_tokens: input, output_tokens: output, total_tokens: input + output } });
  const run = work => withAiUsage(alice.user.id, "test/ai", work);

  await t.test("only administrators set plans or another account's allowance; default zero blocks AI", async () => {
    assert.equal((await guest.request("/subscription")).status, 401);
    assert.equal((await alice.request("/admin/subscriptions")).status, 403);
    assert.equal((await alice.request(`/admin/users/${bob.user.id}/subscription`, "PUT", {})).status, 403);
    assert.equal((await admin.request("/admin/subscription-settings", "PUT", { defaultTokenLimit: 0, plans: [plan] })).status, 200);
    const own = await alice.request("/subscription?userId=" + bob.user.id);
    assert.equal(own.data.subscription.canUseAi, false);
    assert.equal("tokenLimit" in own.data.subscription, false);
    assert.equal("usedTokens" in own.data.subscription, false);
    let calls = 0;
    await assert.rejects(run(() => meteredFetch(aiUrl, options, async () => { calls++; return openai(); })), error => error.status === 402);
    assert.equal(calls, 0);
    assert.equal((await alice.request("/tools/listing-tool/ai/variant-titles", "POST", {})).status, 402);
    for (const value of [-1, 1.5, "1000", null, 1_000_000_001]) {
      assert.equal((await admin.request("/admin/subscription-settings", "PUT", { defaultTokenLimit: value, plans: [] })).status, 400);
    }
    assert.equal((await admin.request("/admin/subscription-settings", "PUT", { defaultTokenLimit: 0, plans: [plan, plan] })).status, 400);
    assert.equal((await admin.request("/admin/users/missing/subscription", "PUT", {})).status, 404);
  });
  await t.test("plan assignment uses a snapshot and each provider call charges its actual usage", async () => {
    await assign({ planId: plan.id, tokenLimit: 1000, expiresAt: Date.now() + 86400000 });
    await run(async () => {
      await meteredFetch(aiUrl, options, async () => openai(120, 80));
      await meteredFetch("https://generativelanguage.googleapis.com/v1/models/fixture:generateContent", options,
        async () => Response.json({ usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 30, thoughtsTokenCount: 10, totalTokenCount: 130 } }));
    });
    const summary = await getSubscription(alice.user.id);
    assert.equal(summary.planName, "Starter"); assert.equal(summary.usedTokens, 330);
    assert.equal(summary.inputTokens, 210); assert.equal(summary.outputTokens, 120); assert.equal(summary.remainingTokens, 670);
    assert.equal((await getSubscription(bob.user.id)).usedTokens, 0);
    await admin.request("/admin/subscription-settings", "PUT", { defaultTokenLimit: 10, plans: [{ ...plan, tokenLimit: 99 }] });
    assert.equal((await getSubscription(alice.user.id)).tokenLimit, 1000);
    assert.equal((await getSubscription(bob.user.id)).tokenLimit, 0);
    // Failed application-level work and provider errors with usage still consume real tokens.
    await assert.rejects(run(async () => { await meteredFetch(aiUrl, options, async () => openai()); throw new Error("invalid generated result"); }), /invalid generated result/);
    await run(() => meteredFetch(aiUrl, options, async () => Response.json({ usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } }, { status: 500 })));
    assert.equal((await getSubscription(alice.user.id)).usedTokens, 355);
    const revision = (await getSubscription(alice.user.id)).revision;
    assert.equal((await admin.request(`/admin/users/${alice.user.id}/subscription`, "PUT", { planId: null, tokenLimit: 2000, status: "active", expiresAt: null, revision: revision - 1 })).status, 409);
    await assign({ tokenLimit: 2000 }); assert.equal((await getSubscription(alice.user.id)).usedTokens, 355);
  });
  await t.test("a final provider call is charged in full and budget errors cannot be swallowed into retries", async () => {
    await assign({ tokenLimit: 365 });
    let calls = 0;
    await assert.rejects(run(async () => {
      await meteredFetch(aiUrl, options, async () => { calls++; return openai(20, 5); });
      try { await meteredFetch(aiUrl, options, async () => { calls++; return openai(); }); } catch { /* Original handlers may retry or catch errors. */ }
      return "swallowed";
    }), error => error.status === 402);
    assert.equal(calls, 1); assert.equal((await getSubscription(alice.user.id)).usedTokens, 380);
    assert.equal((await getSubscription(alice.user.id)).remainingTokens, 0);
  });
  await t.test("paused, cancelled, expired and zero allowances block calls on the server", async () => {
    for (const changes of [{ status: "paused" }, { status: "cancelled" }, { expiresAt: Date.now() - 1 }]) {
      await assign({ tokenLimit: 1000, ...changes });
      assert.equal((await alice.request("/tools/listing-tool/ai/variant-titles", "POST", {})).status, 403);
    }
    await assign({ tokenLimit: 0 });
    await assert.rejects(run(() => meteredFetch(aiUrl, options, async () => { throw new Error("must not call"); })), error => error.status === 402);
    await assign({ tokenLimit: 1000, startNewPeriod: true });
    assert.equal((await getSubscription(alice.user.id)).usedTokens, 0);
  });
  await t.test("simultaneous requests share a database lease; admin cannot reset usage during a call", async () => {
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    const first = run(() => meteredFetch(aiUrl, options, async () => { enter(); await barrier; return openai(); }));
    await entered;
    try {
      await assert.rejects(run(() => meteredFetch(aiUrl, options, async () => { throw new Error("overlapping call"); })), error => error.status === 429);
      const current = await getSubscription(alice.user.id);
      assert.equal((await admin.request(`/admin/users/${alice.user.id}/subscription`, "PUT", { planId: null, tokenLimit: 1000, status: "active", expiresAt: null, startNewPeriod: true, revision: current.revision })).status, 409);
    } finally { release(); await first; }
    assert.equal((await getSubscription(alice.user.id)).usedTokens, 20);
    let active = 0, maximum = 0;
    await run(() => Promise.all(Array.from({ length: 3 }, () => meteredFetch(aiUrl, options, async () => {
      active++; maximum = Math.max(maximum, active); await new Promise(resolve => setImmediate(resolve)); active--; return openai();
    }))));
    assert.equal(maximum, 1); assert.equal((await getSubscription(alice.user.id)).usedTokens, 80);
  });
  await t.test("missing usage or an ambiguous timeout blocks further spending until explicit admin review", async () => {
    await run(() => meteredFetch(aiUrl, options, async () => Response.json({ output_text: "no usage" })));
    assert.equal((await getSubscription(alice.user.id)).unreportedCalls, 1);
    await assert.rejects(run(() => meteredFetch(aiUrl, options, async () => { throw new Error("free call"); })), error => error.status === 503);
    const blocked = await alice.request("/tools/listing-tool/ai/variant-titles", "POST", {});
    assert.equal(blocked.status, 503); assert.match(blocked.data.error, /usage is awaiting review/);
    await assign({ startNewPeriod: true });
    assert.equal((await getSubscription(alice.user.id)).unreportedCalls, 1);
    await assign({ clearUsageHold: true });
    await assert.rejects(run(() => meteredFetch(aiUrl, options, async () => { throw new Error("ambiguous network timeout"); })), /ambiguous network timeout/);
    assert.equal((await getSubscription(alice.user.id)).unreportedCalls, 1);
    await assign({ clearUsageHold: true });
    await run(() => meteredFetch(aiUrl, options, async () => Response.json({ error: { message: "rejected before generation" } }, { status: 403 })));
    assert.equal((await getSubscription(alice.user.id)).unreportedCalls, 0);
  });
  await t.test("usage and admin changes survive reconnects; ledger contains no prompts or credentials", async () => {
    const db = await getDb();
    const events = await db.collection("token_events").find({ userId: alice.user.id }).toArray();
    assert.ok(events.some(event => event.type === "subscription-update"));
    assert.ok(events.some(event => event.type === "provider-usage" && event.totalTokens === 200));
    const json = JSON.stringify(events);
    assert.ok(!json.includes("isolated-test")); assert.ok(!json.includes("Authorization"));
    const before = await getSubscription(alice.user.id);
    await closeDb(); assert.deepEqual(await getSubscription(alice.user.id), before);
  });
  await t.test("a crashed worker's stale provider lease requires review before another call", async () => {
    await (await getDb()).collection("token_accounts").updateOne({ _id: alice.user.id }, { $set: { leaseId: "crashed-worker", leaseUntil: Date.now() - 1 } });
    const recovered = await getSubscription(alice.user.id);
    assert.equal(recovered.unreportedCalls, 1);
    await assert.rejects(run(() => meteredFetch(aiUrl, options, async () => { throw new Error("must not retry interrupted request"); })), error => error.status === 503);
    assert.equal((await getSubscription(alice.user.id)).unreportedCalls, 1);
  });
});
