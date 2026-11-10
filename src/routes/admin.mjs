import { Router } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { getDb } from "../services/db.mjs";
import { AppError } from "../services/errors.mjs";
import {
  listProducts,
  listUsers,
  saveProduct,
  deleteProduct,
  storeImage,
} from "../services/store.mjs";
import { updateOrder } from "../services/commerce.mjs";
import { rateLimit } from "../services/auth.mjs";
import { jsonInput } from "../middleware/http.mjs";
import { requireAdmin } from "../middleware/session.mjs";
import {
  getAnnouncement,
  saveAnnouncement,
} from "../services/announcement.mjs";
import { getPromoBanner, savePromoBanner } from "../services/promo-banner.mjs";
import { getSubscriptionSettings, saveSubscriptionSettings, listSubscriptions, saveUserSubscription } from "../services/subscriptions.mjs";
import { listAdminPurchases, paymentConfiguration } from "../services/plan-payments.mjs";
export const adminRoutes = Router();
adminRoutes.use(requireAdmin);
adminRoutes.get("/subscriptions", async (_req, res) => res.json({
  settings: await getSubscriptionSettings(), accounts: await listSubscriptions(), purchases: await listAdminPurchases(), payment: paymentConfiguration(),
}));
adminRoutes.put("/subscription-settings", async (req, res) => res.json({
  settings: await saveSubscriptionSettings(jsonInput(req), req.user.id),
}));
adminRoutes.put("/users/:id/subscription", async (req, res) => res.json({
  subscription: await saveUserSubscription(req.params.id, jsonInput(req), req.user.id),
}));
adminRoutes.get("/promo-banner", async (_req, res) =>
  res.json({ banner: await getPromoBanner() }),
);
adminRoutes.put("/promo-banner", async (req, res) =>
  res.json({ banner: await savePromoBanner(jsonInput(req), req.user.id) }),
);
adminRoutes.get("/announcement", async (_req, res) =>
  res.json({ announcement: await getAnnouncement() }),
);
adminRoutes.put("/announcement", async (req, res) =>
  res.json({
    announcement: await saveAnnouncement(jsonInput(req), req.user.id),
  }),
);
adminRoutes.get("/products", async (_req, res) =>
  res.json({ products: await listProducts(true) }),
);
adminRoutes.post("/products", async (req, res) =>
  res.status(201).json({ product: await saveProduct(jsonInput(req)) }),
);
adminRoutes.put("/products/:id", async (req, res) =>
  res.json({ product: await saveProduct(jsonInput(req), req.params.id) }),
);
adminRoutes.delete("/products/:id", async (req, res) => {
  await deleteProduct(req.params.id);
  res.json({ success: true });
});
adminRoutes.get("/users", async (_req, res) =>
  res.json({ users: await listUsers() }),
);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
});
adminRoutes.post(
  "/upload",
  async (req, _res, next) => {
    await rateLimit("upload:" + req.user.id, 60, 3600);
    next();
  },
  upload.single("file"),
  async (req, res) => {
    if (!req.file) throw new AppError("Choose an image file.");
    res
      .status(201)
      .json({ url: await storeImage(req.file.buffer, req.file.mimetype) });
  },
);
adminRoutes.patch("/orders/:id", async (req, res) =>
  res.json({ order: await updateOrder(req.params.id, jsonInput(req).status) }),
);
adminRoutes.get("/coupons", async (_req, res) => {
  const coupons = await (
    await getDb()
  )
    .collection("coupons")
    .find({}, { projection: { _id: 0 } })
    .sort({ code: 1 })
    .toArray();
  res.json({ coupons });
});
adminRoutes.post("/coupons", async (req, res) => {
  const input = jsonInput(req);
  if (
    typeof input.code !== "string" ||
    !/^[A-Z0-9_-]{3,24}$/.test(input.code.toUpperCase()) ||
    !Number.isInteger(input.percent) ||
    input.percent < 1 ||
    input.percent > 90 ||
    !Number.isInteger(input.days) ||
    input.days < 1 ||
    input.days > 365
  )
    throw new AppError(
      "Use a 3–24 character code, a 1–90% discount and 1–365 active days.",
    );
  await (await getDb()).collection("coupons").updateOne(
    { code: input.code.toUpperCase() },
    {
      $set: {
        percent: input.percent,
        expiresAt: new Date(Date.now() + input.days * 86400000),
        active: input.active !== false,
      },
      $setOnInsert: { _id: randomUUID() },
    },
    { upsert: true },
  );
  res.json({ success: true });
});
