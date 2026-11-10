import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestBackend } from "./support/runtime.mjs";
import { getDb } from "../src/services/db.mjs";
import { originGuard } from "../src/middleware/http.mjs";
test("production origins explicitly allow the separate admin host", () => {
  const saved = { NODE_ENV: process.env.NODE_ENV, FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN, ADMIN_ORIGIN: process.env.ADMIN_ORIGIN };
  try {
    Object.assign(process.env, { NODE_ENV: "production", FRONTEND_ORIGIN: "https://shop.test", ADMIN_ORIGIN: "https://admin.test" });
    function check(origin) {
      let passed = false;
      originGuard({ method: "POST", get: () => origin }, { vary() {}, set() {} }, () => { passed = true; });
      return passed;
    }
    assert.equal(check("https://admin.test"), true); assert.equal(check("https://shop.test"), true);
    assert.throws(() => check("http://localhost:3001"), error => error.status === 403);
    assert.throws(() => check("https://untrusted.test"), error => error.status === 403);
    delete process.env.ADMIN_ORIGIN;
    assert.throws(() => check("http://localhost:3001"), error => error.status === 403);
  } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});
test("separate admin login rejects customers, verifies admin roles and preserves backend authorization", { timeout: 120000 }, async t => {
  const origin = "http://localhost:3001";
  const runtime = await startTestBackend("http://storefront.test");
  t.after(() => runtime.close());
  let cookie = "";
  async function request(path, body, headers = {}) {
    const response = await fetch(runtime.url + "/api" + path, { method: body === undefined ? "GET" : "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, data: await response.json() };
  }
  await t.test("unapproved origins and non-admin phone numbers cannot start admin login", async () => {
    assert.equal((await request("/admin/auth/request-otp", { phone: "9876543201" }, { Origin: "https://foreign.test" })).response.status, 403);
    assert.equal((await request("/admin/auth/request-otp", { phone: "9876543269" })).response.status, 403);
    assert.equal(await (await getDb()).collection("otp_challenges").countDocuments({ phone: "+919876543269" }), 0);
    assert.equal((await request("/admin/users")).response.status, 401);
  });
  await t.test("a customer OTP cannot be exchanged for an admin session", async () => {
    const challenge = (await request("/auth/request-otp", { phone: "9876543270" })).data;
    const denied = await request("/admin/auth/verify-otp", { challengeId: challenge.challengeId, code: challenge.developmentCode });
    assert.equal(denied.response.status, 403); assert.equal(denied.response.headers.getSetCookie().length, 0);
    const db = await getDb(), user = await db.collection("users").findOne({ phone: "+919876543270" });
    assert.equal(user.role, "customer"); assert.equal(await db.collection("sessions").countDocuments({ userId: user._id }), 0);
  });
  await t.test("admin OTP gives an HttpOnly session usable by existing admin APIs", async () => {
    const challenge = (await request("/admin/auth/request-otp", { phone: "9876543201" })).data;
    const verified = await request("/admin/auth/verify-otp", { challengeId: challenge.challengeId, code: challenge.developmentCode });
    assert.equal(verified.response.status, 200); assert.equal(verified.data.user.role, "admin");
    const session = verified.response.headers.getSetCookie().find(value => value.startsWith("margyn_session="));
    assert.match(session, /HttpOnly/i); cookie = session.split(";")[0];
    assert.equal((await request("/admin/users")).response.status, 200);
    assert.equal((await request("/admin/subscriptions")).response.status, 200);
    await request("/auth/logout", {});
    assert.equal((await request("/admin/users")).response.status, 401); cookie = "";
  });
  await t.test("revoked admin roles are checked again during verification", async () => {
    const challenge = (await request("/admin/auth/request-otp", { phone: "9876543204" })).data;
    const db = await getDb();
    await db.collection("users").updateOne({ phone: "+919876543204" }, { $set: { role: "customer" } });
    const result = await request("/admin/auth/verify-otp", { challengeId: challenge.challengeId, code: challenge.developmentCode });
    assert.equal(result.response.status, 403); assert.equal(result.response.headers.getSetCookie().length, 0);
  });
});
