import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { startTestBackend } from "./support/runtime.mjs";
import { getDb } from "../src/services/db.mjs";

test("explicit OTP response mode works in production without SMS", { timeout: 120000 }, async t => {
  const origin = "http://otp-response.test";
  const runtime = await startTestBackend(origin);
  const keys = ["NODE_ENV", "OTP_PROVIDER", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_VERIFY_SERVICE_SID"];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const realFetch = globalThis.fetch;
  let smsCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith("https://verify.twilio.com/")) {
      smsCalls++;
      return Response.json({ status: String(url).endsWith("/VerificationCheck") ? "approved" : "pending", sid: "VE_isolated_fixture" });
    }
    return realFetch(url, options);
  };
  t.after(async () => {
    globalThis.fetch = realFetch;
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    await runtime.close();
  });
  process.env.NODE_ENV = "production";
  for (const key of keys.filter(key => key.startsWith("TWILIO_"))) delete process.env[key];
  async function request(path, body, cookie = "") {
    const response = await realFetch(runtime.url + "/api" + path, { method: body === undefined ? "GET" : "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookies: response.headers.getSetCookie() };
  }
  const send = phone => request("/auth/request-otp", { phone });
  const verify = (challenge, code = challenge.otp) => request("/auth/verify-otp", { challengeId: challenge.challengeId, code });

  await t.test("production still requires an explicitly selected response mode", async () => {
    delete process.env.OTP_PROVIDER;
    assert.equal((await send("9876543280")).status, 503);
    process.env.OTP_PROVIDER = "development";
    assert.equal((await send("9876543281")).status, 503);
    assert.equal(smsCalls, 0);
  });
  await t.test("test mode returns a random OTP, stores its hash and issues a secure session after verification", async () => {
    process.env.OTP_PROVIDER = "test";
    const sent = await send("9876543282");
    assert.equal(sent.status, 200);
    assert.match(sent.data.otp, /^\d{6}$/);
    assert.equal(sent.data.developmentCode, sent.data.otp);
    assert.equal(sent.data.resendAfter, 60);
    const stored = await (await getDb()).collection("otp_challenges").findOne({ _id: sent.data.challengeId });
    assert.equal(stored.provider, "test");
    assert.equal(stored.hash, createHash("sha256").update(sent.data.challengeId + sent.data.otp).digest("hex"));
    assert.equal(stored.otp, undefined);
    const wrong = sent.data.otp === "111111" ? "222222" : "111111";
    assert.equal((await verify(sent.data, wrong)).status, 400);
    const verified = await verify(sent.data);
    assert.equal(verified.status, 200); assert.equal(verified.data.user.role, "customer");
    const cookie = verified.cookies.find(value => value.startsWith("margyn_session="));
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Lax/);
    assert.equal((await request("/auth/me", undefined, cookie.split(";")[0])).data.user.id, verified.data.user.id);
    assert.equal((await verify(sent.data)).status, 400);
    assert.equal(smsCalls, 0);
  });
  await t.test("resend cooldown, expiry and attempt limits still apply", async () => {
    const expired = await send("9876543283");
    assert.equal((await send("9876543283")).status, 429);
    await (await getDb()).collection("otp_challenges").updateOne({ _id: expired.data.challengeId }, { $set: { expiresAt: new Date(0) } });
    assert.equal((await verify(expired.data)).status, 400);
    const sent = await send("9876543284");
    const wrong = sent.data.otp === "111111" ? "222222" : "111111";
    for (let attempt = 0; attempt < 5; attempt++) assert.equal((await verify(sent.data, wrong)).status, 400);
    assert.equal((await verify(sent.data)).status, 400);
  });
  await t.test("admin response-mode login still requires an administrator role", async () => {
    assert.equal((await request("/admin/auth/request-otp", { phone: "9876543282" })).status, 403);
    const sent = await request("/admin/auth/request-otp", { phone: "9876543201" });
    assert.equal(sent.status, 200); assert.match(sent.data.otp, /^\d{6}$/);
    const result = await request("/admin/auth/verify-otp", { challengeId: sent.data.challengeId, code: sent.data.otp });
    assert.equal(result.status, 200); assert.equal(result.data.user.role, "admin");
    assert.equal(smsCalls, 0);
  });
  await t.test("turning test mode off rejects outstanding response-mode challenges", async () => {
    const sent = await send("9876543285");
    process.env.OTP_PROVIDER = "twilio";
    const result = await verify(sent.data);
    assert.equal(result.status, 400); assert.deepEqual(result.cookies, []);
    assert.equal(smsCalls, 0);
  });
  await t.test("Twilio responses do not expose OTPs", async () => {
    Object.assign(process.env, { OTP_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: "AC_isolated_fixture", TWILIO_AUTH_TOKEN: "isolated-fixture-token", TWILIO_VERIFY_SERVICE_SID: "VA_isolated_fixture" });
    const sent = await send("9876543286");
    assert.equal(sent.status, 200);
    assert.equal(sent.data.otp, undefined); assert.equal(sent.data.developmentCode, undefined);
    assert.equal(smsCalls, 1);
    assert.equal((await verify(sent.data, "123456")).status, 200);
    assert.equal(smsCalls, 2);
  });
});
