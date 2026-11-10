import { Router } from "express";
import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import multer from "multer";
import sharp from "sharp";
import { requireUser } from "../middleware/session.mjs";
import { AppError } from "../services/errors.mjs";
import { rateLimit } from "../services/auth.mjs";
import { withInventoryUser } from "../tools/inventory-admin/mongoose-context.mjs";
import InventoryImageKit from "../tools/inventory-admin/imagekit.mjs";
const require = createRequire(import.meta.url);
const original = "../tools/inventory-admin/original/src/";
const routes = [
  ["/categories", "category"], ["/products", "product"], ["/inventory", "inventory"],
  ["/purchase-orders", "purchase"], ["/printing-jobs", "printing"], ["/barcodes", "barcode"],
  ["/packing", "packing"], ["/dashboard", "dashboard"], ["/product-designs", "productDesign"],
].map(([path, name]) => [path, require(original + "routes/" + name + ".routes.js")]);
const User = require(original + "models/User.js");
const Product = require(original + "models/Product.js");
const PackingSession = require(original + "models/PackingSession.js");
const { register } = require(original + "controllers/auth.controller.js");
const { updateInventoryThreshold } = require(original + "controllers/inventory.controller.js");
const { getProducts } = require(original + "controllers/product.controller.js");
const { getPrintedDesignsByProduct } = require(original + "controllers/printing.controller.js");
const { getBarcodeTodayReport } = require(original + "controllers/barcode.controller.js");
const uploads = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 12, parts: 14 },
  fileFilter(_req, file, done) { const allowed = ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype); done(allowed ? null : new AppError("Choose a JPG, PNG or WebP image.", 415), allowed); },
});
async function upload(req, res) {
  await new Promise((resolve, reject) => uploads.single("file")(req, res, error => error ? reject(error) : resolve()));
  if (!req.file) throw new AppError("Choose an image to upload.", 400);
  const meta = await sharp(req.file.buffer, { limitInputPixels: 40000000 }).metadata().catch(() => null);
  if (!meta || !["jpeg", "png", "webp"].includes(meta.format)) throw new AppError("The image contents are invalid.", 400);
  return req.file;
}
export const inventoryAdminRoutes = Router();
inventoryAdminRoutes.use(requireUser);
inventoryAdminRoutes.use(async (req, res, next) => {
  const json = res.json.bind(res);
  res.json = body => {
    if (typeof body?.barcodeGeneration?.endpoint === "string" && body.barcodeGeneration.endpoint.startsWith("/api/")) body = { ...body, barcodeGeneration: { ...body.barcodeGeneration, endpoint: "/api/tools/inventory-admin/" + body.barcodeGeneration.endpoint.slice(5) } };
    return json(body);
  };
  const owner = req.user;
  const inventoryId = createHash("sha256").update("inventory-owner:" + owner.id).digest("hex").slice(0, 24);
  req.inventoryIdentity = { id: inventoryId, role: "ADMIN" };
  if (!["GET", "HEAD"].includes(req.method)) await rateLimit("inventory-write:" + owner.id, 300, 3600);
  await withInventoryUser(owner.id, () => next(), async () => {
    if (!await User.exists({ _id: inventoryId })) await User.create({ _id: inventoryId, name: owner.name || "Workspace owner", email: inventoryId + "@inventory.margyn.local", password: randomBytes(32).toString("hex"), role: "ADMIN" });
  });
});
// Preserve the original Next proxy query conventions inside the Express namespace.
inventoryAdminRoutes.get("/printing-jobs", (req, res, next) => req.query.kind === "products" ? getProducts(req, res) : next());
inventoryAdminRoutes.get("/printing-jobs/:id", (req, res, next) => {
  if (req.query.kind !== "designs") return next();
  req.params.productId = req.params.id;
  return getPrintedDesignsByProduct(req, res);
});
inventoryAdminRoutes.get("/barcodes", getBarcodeTodayReport);
inventoryAdminRoutes.post("/inventory/raw", async (req, _res, next) => {
  const id = req.body?.productId;
  if (typeof id === "string" && /^[a-f0-9]{24}$/i.test(id) && !await Product.exists({ _id: id, isActive: true })) throw new AppError("Model not found in your inventory workspace.", 404);
  next();
});
inventoryAdminRoutes.patch("/inventory/threshold/:id", (req, res) => updateInventoryThreshold(req, res));
inventoryAdminRoutes.post("/auth/register", (req, res) => {
  // Legacy staff accounts stay inside this private workspace; JWTs do not authorize Margyn APIs.
  const json = res.json.bind(res);
  res.json = body => { if (body && typeof body === "object") { const { token: _token, ...publicResult } = body; return json(publicResult); } return json(body); };
  return register(req, res);
});
inventoryAdminRoutes.get("/imagekit-auth", (_req, res) => {
  if (!process.env.IMAGEKIT_PRIVATE_KEY) throw new AppError("The image library is not configured.", 503);
  // The original upload UI now posts to this server. No unrestricted ImageKit signature is issued.
  res.json({ token: "margyn-server-upload", signature: "server-managed", expire: 0 });
});
inventoryAdminRoutes.post("/imagekit/upload", async (req, res) => {
  const file = await upload(req, res);
  await rateLimit("inventory-images:" + req.inventoryIdentity.id, 120, 3600);
  const name = file.originalname.replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 180) || "image";
  const result = await new InventoryImageKit().upload({ file: file.buffer, fileName: name });
  res.status(201).json(result);
});
inventoryAdminRoutes.get("/imagekit/list", async (_req, res) => {
  const files = await new InventoryImageKit().listFiles();
  res.json({ images: files.map(({ fileId, name, url, thumbnail, height, width, size, createdAt }) => ({ fileId, name, url, thumbnail, height, width, size, createdAt })) });
});
inventoryAdminRoutes.delete("/imagekit/delete", async (req, res) => {
  await new InventoryImageKit().deleteFile(req.body?.fileId);
  res.json({ message: "File deleted successfully" });
});
inventoryAdminRoutes.put("/imagekit/replace", async (req, res) => {
  const file = await upload(req, res);
  const library = new InventoryImageKit();
  const existing = await library.getFileDetails(req.body?.fileId);
  const result = await library.upload({ file: file.buffer, fileName: existing.name,
    folder: existing.filePath.slice(0, existing.filePath.lastIndexOf("/")), useUniqueFileName: false, overwriteFile: true });
  res.json({ message: "File replaced successfully", fileId: result.fileId, name: result.name, url: result.url });
});
for (const [path, router] of routes) inventoryAdminRoutes.use(path, router);
inventoryAdminRoutes.use((error, _req, res, _next) => {
  let status = error instanceof AppError ? error.status : 500;
  let message = error instanceof AppError ? error.message : "The inventory request could not be completed. Please try again.";
  if (error instanceof multer.MulterError) { status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400; message = error.code === "LIMIT_FILE_SIZE" ? "Each image must be 10 MB or smaller." : "Upload one image at a time."; }
  if (error.retryAfter) res.set("Retry-After", String(error.retryAfter));
  res.status(status).json({ message, error: message });
});
