import { Router } from "express";
import { createOrder, getOrder, listOrders } from "../services/commerce.mjs";
import { rateLimit } from "../services/auth.mjs";
import { AppError } from "../services/errors.mjs";
import { requireUser } from "../middleware/session.mjs";
import { jsonInput } from "../middleware/http.mjs";
export const orderRoutes = Router();
orderRoutes.use(requireUser);
orderRoutes.get("/mine", async (req, res) =>
  res.json({ orders: await listOrders({ ...req.user, role: "customer" }) }),
);
orderRoutes.get("/", async (req, res) =>
  res.json({ orders: await listOrders(req.user) }),
);
orderRoutes.get("/:id", async (req, res) => {
  const order = await getOrder(req.params.id, req.user);
  if (!order) throw new AppError("Order not found.", 404);
  res.json({ order });
});
orderRoutes.post("/", async (req, res) => {
  await rateLimit("orders:" + req.user.id, 20, 3600);
  res.status(201).json({ order: await createOrder(req.user, jsonInput(req)) });
});
