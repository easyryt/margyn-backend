import { Router } from "express";
import { listProducts, getProduct, getImage } from "../services/store.mjs";
import { AppError } from "../services/errors.mjs";
export const productRoutes = Router();
productRoutes.get("/", async (_req, res) =>
  res.json({ products: await listProducts() }),
);
productRoutes.get("/:id", async (req, res) => {
  const product = await getProduct(req.params.id);
  if (!product) throw new AppError("Product not found.", 404);
  res.json({ product });
});
export const mediaRoutes = Router();
mediaRoutes.get("/:id", async (req, res) => {
  const media = await getImage(req.params.id);
  if (!media) throw new AppError("Image not found.", 404);
  if (media.url) return res.redirect(307, media.url);
  res.set("Content-Type", media.mime);
  res.set("Cache-Control", "public, max-age=31536000, immutable");
  res.send(Buffer.from(media.data.buffer ?? media.data));
});
