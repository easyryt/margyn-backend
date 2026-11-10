import { Router } from "express";
import multer from "multer";
import { requireUser } from "../middleware/session.mjs";
import { AppError } from "../services/errors.mjs";
import { rateLimit } from "../services/auth.mjs";
import { withAiUsage } from "../services/ai-usage.mjs";
import { withListingUser } from "../tools/listing-tool/mongoose-context.mjs";
import products from "../tools/listing-tool/original/src/routes/products.mjs";
import charms from "../tools/listing-tool/original/src/routes/charms.mjs";
import designs from "../tools/listing-tool/original/src/routes/designs.mjs";
import generalProducts from "../tools/listing-tool/original/src/routes/general-products.mjs";
import { POST as productCopy } from "../tools/listing-tool/frontend/app/api/ai/product-copy/route.mjs";
import { POST as variantTitles } from "../tools/listing-tool/frontend/app/api/ai/variant-titles/route.mjs";
import { POST as generalCopy } from "../tools/listing-tool/frontend/app/api/ai/general-product-copy/route.mjs";
import { POST as generalTitles } from "../tools/listing-tool/frontend/app/api/ai/general-product-variant-titles/route.mjs";
const ai = { "product-copy": productCopy, "variant-titles": variantTitles, "general-product-copy": generalCopy, "general-product-variant-titles": generalTitles };
const multipart = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 24, fieldSize: 65536 },
  fileFilter(_req, file, next) { const valid = ["image/png", "image/jpeg", "image/webp"].includes(file.mimetype); next(valid ? null : new AppError("Choose a PNG, JPG or WebP image.", 415), valid); },
});
export const listingToolRoutes = Router();
listingToolRoutes.use(requireUser);
listingToolRoutes.use(async (req, _res, next) => {
  if (!["GET", "HEAD"].includes(req.method)) await rateLimit("listing-write:" + req.user.id, 240, 3600);
  await withListingUser(req.user.id, () => next());
});
listingToolRoutes.use("/products", products);
listingToolRoutes.use("/charms", charms);
listingToolRoutes.use("/designs", designs);
listingToolRoutes.use("/general-products", generalProducts);
listingToolRoutes.post("/ai/:action", async (req, res) => {
  const handler = Object.hasOwn(ai, req.params.action) && ai[req.params.action];
  if (!handler) throw new AppError("Listing action not found.", 404);
  await rateLimit("listing-ai:" + req.user.id, 60, 3600);
  let input;
  if (["product-copy", "general-product-copy"].includes(req.params.action)) {
    await new Promise((resolve, reject) => multipart.single("image")(req, res, error => error ? reject(error) : resolve()));
    const form = new FormData();
    for (const [name, value] of Object.entries(req.body || {})) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (typeof item !== "string") throw new AppError("Use plain-text listing settings.");
        form.append(name, item);
      }
    }
    if (req.file) form.append("image", new Blob([Uint8Array.from(req.file.buffer)], { type: req.file.mimetype }), req.file.originalname);
    input = { formData: async () => form };
  } else input = { json: async () => req.body };
  const result = await withAiUsage(req.user.id, `listing-tool/${req.params.action}`, () => handler(input));
  res.status(result.status).type("application/json").send(await result.text());
});
listingToolRoutes.use((error, _req, res, _next) => {
  let status = error.status || 500;
  let message = error.message;
  if (error instanceof multer.MulterError) { status = 400; message = error.code === "LIMIT_FILE_SIZE" ? "The uploaded file is too large." : "Invalid upload."; }
  else if (["ValidationError", "CastError", "StrictModeError"].includes(error.name)) { status = 400; message = error.name === "CastError" ? "Invalid listing identifier." : "Review the listing fields and try again."; }
  else if (error.code === 11000) { status = 409; message = "This SKU or design already exists in your listing workspace."; }
  else if (status >= 500 && !(error instanceof AppError)) { message = "The listing request could not be completed. Your unsaved data is still on this page."; }
  if (error.retryAfter) res.set("Retry-After", String(error.retryAfter));
  res.status(status).json({ success: false, message, error: message });
});
