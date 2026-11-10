import { Router } from "express";
import { getDb } from "../services/db.mjs";
import { AppError, normalizePhone } from "../services/errors.mjs";
import { requestOtp, verifyOtp, revokeSession, rateLimit, SESSION_COOKIE, SESSION_SECONDS } from "../services/auth.mjs";
import { jsonInput } from "../middleware/http.mjs";
import { clientIp, LEGACY_SESSION_COOKIE } from "../middleware/session.mjs";
import { cookieOptions } from "../config.mjs";
export const adminAuthRoutes = Router();
adminAuthRoutes.post("/request-otp", async (req, res) => {
  await rateLimit("admin-login:" + clientIp(req), 20, 3600);
  const phone = normalizePhone(jsonInput(req).phone);
  const admin = await (await getDb()).collection("users").findOne({ phone, role: "admin" }, { projection: { _id: 1 } });
  if (!admin) throw new AppError("This number does not have administrator access.", 403);
  res.json(await requestOtp(phone, clientIp(req)));
});
adminAuthRoutes.post("/verify-otp", async (req, res) => {
  const input = jsonInput(req);
  const { token, user } = await verifyOtp(input.challengeId, input.code, clientIp(req));
  if (user.role !== "admin") {
    await revokeSession(token);
    throw new AppError("Administrator access is required.", 403);
  }
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(), maxAge: SESSION_SECONDS * 1000 });
  res.clearCookie(LEGACY_SESSION_COOKIE, cookieOptions());
  res.json({ user });
});
