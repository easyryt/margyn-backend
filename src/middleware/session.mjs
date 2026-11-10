import { createHash, randomBytes } from "node:crypto";
import { cookieOptions } from "../config.mjs";
import {
  sessionUser,
  SESSION_COOKIE,
  SESSION_SECONDS,
} from "../services/auth.mjs";
import { AppError } from "../services/errors.mjs";
export const CART_COOKIE = "margyn_cart";
// Read the former cookie names only to preserve existing logins and guest carts.
export const LEGACY_SESSION_COOKIE = "packi_session";
export const LEGACY_CART_COOKIE = "packi_cart";
export function guestOwner(token) {
  return typeof token === "string" && /^[a-f0-9]{64}$/.test(token)
    ? "guest:" + createHash("sha256").update(token).digest("hex")
    : "";
}
export async function authenticate(req, res, next) {
  req.sessionToken =
    req.cookies[SESSION_COOKIE] || req.cookies[LEGACY_SESSION_COOKIE];
  req.user = await sessionUser(req.sessionToken);
  if (
    req.user &&
    !req.cookies[SESSION_COOKIE] &&
    req.cookies[LEGACY_SESSION_COOKIE]
  ) {
    res.cookie(SESSION_COOKIE, req.sessionToken, {
      ...cookieOptions(),
      maxAge: SESSION_SECONDS * 1000,
    });
    res.clearCookie(LEGACY_SESSION_COOKIE, cookieOptions());
  }
  next();
}
export function requireUser(req, _res, next) {
  if (!req.user) throw new AppError("Please sign in to continue.", 401);
  next();
}
export function requireAdmin(req, _res, next) {
  if (!req.user) throw new AppError("Please sign in to continue.", 401);
  if (req.user.role !== "admin")
    throw new AppError("Administrator access is required.", 403);
  next();
}
export function cartOwner(req, res, create = false) {
  if (req.user) return "user:" + req.user.id;
  let token = req.cookies[CART_COOKIE];
  if (!guestOwner(token) && guestOwner(req.cookies[LEGACY_CART_COOKIE])) {
    token = req.cookies[LEGACY_CART_COOKIE];
    res.cookie(CART_COOKIE, token, {
      ...cookieOptions(),
      maxAge: 30 * 86400000,
    });
    res.clearCookie(LEGACY_CART_COOKIE, cookieOptions());
  }
  if (!guestOwner(token) && create) {
    token = randomBytes(32).toString("hex");
    res.cookie(CART_COOKIE, token, {
      ...cookieOptions(),
      maxAge: 30 * 86400000,
    });
  }
  return guestOwner(token);
}
export function clientIp(req) {
  return process.env.TRUST_PROXY === "true"
    ? req.ip
    : req.socket.remoteAddress || "unknown";
}
