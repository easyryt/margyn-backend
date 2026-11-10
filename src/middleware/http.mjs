import multer from "multer";
import { AppError } from "../services/errors.mjs";
export function originGuard(req, res, next) {
  const allowed = new Set(
    [(
      process.env.FRONTEND_ORIGIN ||
      process.env.APP_ORIGIN ||
      "http://localhost:3000"
    ), process.env.ADMIN_ORIGIN ?? (process.env.NODE_ENV === "production" ? "" : "http://localhost:3001,http://127.0.0.1:3001")].join(",")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const origin = req.get("origin");
  res.vary("Origin");
  if (origin && !allowed.has(origin))
    throw new AppError("This request origin is not allowed.", 403);
  if (origin) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Credentials", "true");
  }
  if (req.method === "OPTIONS") {
    res.set(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    );
    res.set("Access-Control-Allow-Headers", "Content-Type");
    return res.sendStatus(204);
  }
  if (!["GET", "HEAD"].includes(req.method) && !origin)
    throw new AppError("An approved request origin is required.", 403);
  next();
}
export function jsonInput(req) {
  if (!req.is("application/json")) throw new AppError("Send JSON data.", 415);
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body))
    throw new AppError("The request data is invalid.");
  return req.body;
}
export function errorHandler(error, _req, res, _next) {
  if (res.headersSent) return res.end();
  if (error instanceof multer.MulterError)
    return res
      .status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400)
      .json({
        error:
          error.code === "LIMIT_FILE_SIZE"
            ? "Choose an image smaller than 5 MB."
            : "Choose one valid image file.",
      });
  if (error.type === "entity.too.large")
    return res.status(413).json({ error: "The request is too large." });
  if (error.type === "entity.parse.failed")
    return res.status(400).json({ error: "The request data is invalid." });
  if (error instanceof AppError) {
    if (error.retryAfter) res.set("Retry-After", String(error.retryAfter));
    return res
      .status(error.status)
      .json({ error: error.message, retryAfter: error.retryAfter });
  }
  console.error(
    "Margyn API error:",
    error instanceof Error ? error.message : "Unknown error",
  );
  return res
    .status(500)
    .json({ error: "Something went wrong. Please try again." });
}
