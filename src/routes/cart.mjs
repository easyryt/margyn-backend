import { Router } from "express";
import { quoteCart, changeCart } from "../services/commerce.mjs";
import { cartOwner } from "../middleware/session.mjs";
import { jsonInput } from "../middleware/http.mjs";
export const cartRoutes = Router();
cartRoutes.get("/", async (req, res) =>
  res.json({ cart: await quoteCart(cartOwner(req, res)) }),
);
async function mutate(req, res) {
  res.json({
    cart: await changeCart(cartOwner(req, res, true), jsonInput(req)),
  });
}
cartRoutes.post("/", mutate);
cartRoutes.patch("/", mutate);
