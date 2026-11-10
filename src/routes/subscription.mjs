import { Router } from "express";
import { requireUser } from "../middleware/session.mjs";
import { getPublicSubscription, listPublicPlans } from "../services/subscriptions.mjs";
import { createPlanPurchase, verifyPlanPayment, refreshPlanPurchase, resumePlanCheckout, listPurchases, paymentConfiguration } from "../services/plan-payments.mjs";
import { jsonInput } from "../middleware/http.mjs";
import { rateLimit } from "../services/auth.mjs";
import { refreshStorage } from "../services/storage-allowance.mjs";
export const subscriptionRoutes = Router();
subscriptionRoutes.use(requireUser);
subscriptionRoutes.get("/", async (req, res) => res.json({ subscription: await getPublicSubscription(req.user.id) }));
subscriptionRoutes.post("/storage/refresh", async (req, res) => {
  jsonInput(req);
  await rateLimit("storage-refresh:" + req.user.id, 60, 3600);
  await refreshStorage(req.user.id);
  res.json({ subscription: await getPublicSubscription(req.user.id) });
});
subscriptionRoutes.get("/plans", async (_req, res) => res.json({ plans: await listPublicPlans(), payment: paymentConfiguration() }));
subscriptionRoutes.get("/purchases", async (req, res) => res.json({ purchases: await listPurchases(req.user.id) }));
subscriptionRoutes.get("/purchases/:id/checkout", async (req, res) => res.json(await resumePlanCheckout(req.user.id, req.params.id)));
subscriptionRoutes.post("/purchases", async (req, res) => {
  await rateLimit("plan-checkout:" + req.user.id, 20, 3600);
  res.status(201).json(await createPlanPurchase(req.user, jsonInput(req)));
});
subscriptionRoutes.post("/verify-payment", async (req, res) => {
  await rateLimit("plan-verify:" + req.user.id, 60, 3600);
  res.json({ purchase: await verifyPlanPayment(req.user.id, jsonInput(req)), subscription: await getPublicSubscription(req.user.id) });
});
subscriptionRoutes.post("/purchases/:id/refresh", async (req, res) => {
  jsonInput(req);
  await rateLimit("plan-refresh:" + req.user.id, 60, 3600);
  res.json({ purchase: await refreshPlanPurchase(req.user.id, req.params.id), subscription: await getPublicSubscription(req.user.id) });
});
