import "./config.mjs";
import { inventoryAdminRoutes } from "./routes/inventory-admin.mjs";
import { listingToolRoutes } from "./routes/listing-tool.mjs";
import { listingStagingRoutes } from "./routes/listing-staging.mjs";
import express from "express";
import cookieParser from "cookie-parser";
import { authenticate } from "./middleware/session.mjs";
import { originGuard, errorHandler } from "./middleware/http.mjs";
import { authRoutes } from "./routes/auth.mjs";
import { productRoutes, mediaRoutes } from "./routes/products.mjs";
import { adminRoutes } from "./routes/admin.mjs";
import { adminAuthRoutes } from "./routes/admin-auth.mjs";
import { siteRoutes } from "./routes/site.mjs";
import { locationRoutes } from "./routes/locations.mjs";
import { profileRoutes } from "./routes/profile.mjs";
import { subscriptionRoutes } from "./routes/subscription.mjs";
import { planPaymentWebhook } from "./services/plan-payments.mjs";
import { cartRoutes } from "./routes/cart.mjs";
import { imageGeneratorRoutes } from "./routes/image-generator.mjs";
import { shippingLabelRoutes } from "./routes/shipping-labels.mjs";
import { orderRoutes } from "./routes/orders.mjs";
import { getDb } from "./services/db.mjs";
export function createApp() {
  const app = express();
  const listingJson = express.json({ limit: "2mb", strict: true });
  const defaultJson = express.json({ limit: "16kb", strict: true });
  const settingsJson = express.json({ limit: "64kb", strict: true });
  app.disable("x-powered-by");
  app.set("trust proxy", process.env.TRUST_PROXY === "true");
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    next();
  });
  app.post("/api/subscription/payments/razorpay/webhook", express.raw({ type: "application/json", limit: "256kb" }), planPaymentWebhook);
  app.use("/api/meesho-upload", listingStagingRoutes);
  app.use("/api", originGuard);
  // Public, cookie-free reference data does not need a database session.
  app.use("/api/locations", locationRoutes);
  app.get("/api/health", async (_req, res) => {
    await (await getDb()).command({ ping: 1 });
    res.json({ service: "margyn-api", status: "ok" });
  });
  app.use(
    "/api",
    (req, res, next) => (req.path === "/admin/subscription-settings" ? settingsJson : (req.path.startsWith("/tools/listing-tool/") || req.path.startsWith("/tools/inventory-admin/"))
      ? listingJson
      : defaultJson)(req, res, next),
    cookieParser(),
    authenticate,
  );
  app.use("/api/auth", authRoutes);
  app.use("/api/profile", profileRoutes);
  app.use("/api/subscription", subscriptionRoutes);
  app.use("/api/products", productRoutes);
  app.use("/api/media", mediaRoutes);
  app.use("/api/admin/auth", adminAuthRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/site", siteRoutes);
  app.use("/api/cart", cartRoutes);
  app.use("/api/orders", orderRoutes);
  app.use("/api/tools/shipping-labels", shippingLabelRoutes);
  app.use("/api/tools/image-generator", imageGeneratorRoutes);
  app.use("/api/tools/listing-tool", listingToolRoutes);
  app.use("/api/tools/inventory-admin", inventoryAdminRoutes);
  app.use((_req, res) =>
    res.status(404).json({ error: "API route not found." }),
  );
  app.use(errorHandler);
  return app;
}
