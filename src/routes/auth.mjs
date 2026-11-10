import { Router } from "express";
import {
  requestOtp,
  verifyOtp,
  revokeSession,
  SESSION_COOKIE,
  SESSION_SECONDS,
} from "../services/auth.mjs";
import { mergeGuestCart } from "../services/commerce.mjs";
import { cookieOptions } from "../config.mjs";
import { jsonInput } from "../middleware/http.mjs";
import {
  clientIp,
  guestOwner,
  CART_COOKIE,
  LEGACY_CART_COOKIE,
  LEGACY_SESSION_COOKIE,
} from "../middleware/session.mjs";
export const authRoutes = Router();
authRoutes.post("/request-otp", async (req, res) => {
  const input = jsonInput(req);
  res.json(await requestOtp(input.phone, clientIp(req)));
});
authRoutes.post("/verify-otp", async (req, res) => {
  const input = jsonInput(req);
  const { token, user } = await verifyOtp(
    input.challengeId,
    input.code,
    clientIp(req),
  );
  await mergeGuestCart(
    user.id,
    guestOwner(req.cookies[CART_COOKIE] || req.cookies[LEGACY_CART_COOKIE]),
  );
  res.cookie(SESSION_COOKIE, token, {
    ...cookieOptions(),
    maxAge: SESSION_SECONDS * 1000,
  });
  for (const name of [CART_COOKIE, LEGACY_CART_COOKIE, LEGACY_SESSION_COOKIE])
    res.clearCookie(name, cookieOptions());
  res.json({ user });
});
authRoutes.post("/logout", async (req, res) => {
  await revokeSession(req.sessionToken);
  res.clearCookie(SESSION_COOKIE, cookieOptions());
  res.clearCookie(LEGACY_SESSION_COOKIE, cookieOptions());
  res.json({ success: true });
});
authRoutes.get("/me", (req, res) => res.json({ user: req.user }));
