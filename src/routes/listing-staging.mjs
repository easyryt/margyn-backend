import express, { Router } from "express";
import cookieParser from "cookie-parser";
import { authenticate, requireUser } from "../middleware/session.mjs";
import { POST, OPTIONS } from "../tools/listing-tool/frontend/app/api/meesho-upload/route.mjs";
export const listingStagingRoutes = Router();
function webRequest(req) {
  const headers = new Headers();
  for (const name of ["origin", "content-type", "sec-fetch-site", "x-listing-extension"]) if (req.get(name)) headers.set(name, req.get(name));
  const origin = (process.env.FRONTEND_ORIGIN || "http://localhost:3000").replace(/\/$/, "");
  return new Request(origin + "/api/meesho-upload", { method: req.method, headers, ...(req.method === "POST" ? { body: JSON.stringify(req.body) } : {}) });
}
async function send(result, res) { for (const [key, value] of result.headers) res.set(key, value); res.status(result.status).send(Buffer.from(await result.arrayBuffer())); }
listingStagingRoutes.options("/", async (req, res) => send(await OPTIONS(webRequest(req)), res));
listingStagingRoutes.post("/", express.json({ limit: "5650000b", type: "application/json" }), async (req, res, next) => {
  // The original extension resolves only with its ID and a staged-image capability.
  if (req.body?.action === "resolve") return send(await POST(webRequest(req)), res);
  next();
}, cookieParser(), authenticate, requireUser, async (req, res) => send(await POST(webRequest(req)), res));
