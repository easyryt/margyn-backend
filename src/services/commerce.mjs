import { createHash, randomUUID } from "node:crypto";
import { getDb, transaction } from "./db.mjs";
import { AppError, normalizePhone } from "./errors.mjs";
import { getProduct, text } from "./store.mjs";
import { linePrice, paise } from "../pricing.mjs";
export const cartLineId = (productId, size) =>
  createHash("sha256")
    .update(productId + ":" + size)
    .digest("hex")
    .slice(0, 24);
export async function rawCart(owner, session) {
  return owner
    ? (await (
        await getDb()
      )
        .collection("carts")
        .findOne({ _id: owner }, { session })) || {
        _id: owner,
        entries: [],
        version: 0,
        coupon: "",
      }
    : { _id: "", entries: [], version: 0, coupon: "" };
}
async function couponFor(db, code, session) {
  if (!code) return null;
  return db
    .collection("coupons")
    .findOne(
      { code, active: true, expiresAt: { $gt: new Date() } },
      { session },
    );
}
/** @returns {Promise<import('../types').Cart>} */
export async function quoteCart(owner, session) {
  const db = await getDb();
  return quote(db, await rawCart(owner, session), session);
}
async function quote(db, cart, session) {
  const ids = cart.entries.map((entry) => entry.productId);
  const products = await db
    .collection("products")
    .find({ _id: { $in: ids }, status: "published" }, { session })
    .toArray();
  const map = new Map(products.map((p) => [p._id, p]));
  const quantities = new Map();
  for (const entry of cart.entries.filter((e) => !e.saved))
    quantities.set(
      entry.productId,
      (quantities.get(entry.productId) || 0) + entry.quantity,
    );
  const coupon = await couponFor(db, cart.coupon, session);
  let subtotal = 0,
    tax = 0,
    discount = 0,
    cartons = 0;
  const items = cart.entries.map((entry) => {
    const p = map.get(entry.productId);
    const available = Boolean(
      p &&
      p.sizes.includes(entry.size) &&
      entry.quantity >= p.minOrder &&
      quantities.get(entry.productId) <= p.stock,
    );
    const price = p
      ? linePrice(p, entry.quantity)
      : { unitPrice: 0, subtotal: 0, tax: 0 };
    let itemTax = paise(price.tax);
    if (!entry.saved) {
      const itemSubtotal = paise(price.subtotal);
      const itemDiscount = Math.round(
        (itemSubtotal * (coupon?.percent || 0)) / 100,
      );
      itemTax = Math.round(
        ((itemSubtotal - itemDiscount) * (p?.gstRate || 0)) / 100,
      );
      subtotal += itemSubtotal;
      discount += itemDiscount;
      tax += itemTax;
      cartons += entry.quantity;
    }
    return {
      id: entry.id,
      productId: entry.productId,
      name: p?.name || entry.name,
      image: p?.image || entry.image,
      vendor: p?.vendor || entry.vendor,
      verified: Boolean(p?.verified),
      size: entry.size,
      quantity: entry.quantity,
      packSize: p?.packSize || entry.packSize,
      stock: p?.stock || 0,
      minOrder: p?.minOrder || 1,
      unitPrice: price.unitPrice,
      subtotal: price.subtotal,
      tax: itemTax / 100,
      gstRate: p?.gstRate || 0,
      saved: entry.saved,
      available,
    };
  });
  const flat = Number(process.env.SHIPPING_FLAT_RATE || 0),
    threshold = Number(process.env.FREE_SHIPPING_ABOVE || 0);
  if (
    !Number.isFinite(flat) ||
    !Number.isFinite(threshold) ||
    flat < 0 ||
    threshold < 0 ||
    flat > 1000000
  )
    throw new AppError("Shipping rates are not configured correctly.", 503);
  const shipping =
    cartons && !(threshold > 0 && subtotal - discount >= paise(threshold))
      ? paise(flat)
      : 0;
  const active = items.filter((item) => !item.saved);
  return {
    items,
    subtotal: subtotal / 100,
    tax: tax / 100,
    discount: discount / 100,
    shipping: shipping / 100,
    total: (subtotal - discount + tax + shipping) / 100,
    cartons,
    coupon: coupon?.code || "",
    shippingLabel: shipping
      ? "Standard delivery · flat rate"
      : "Standard delivery",
    checkoutReady: active.length > 0 && active.every((item) => item.available),
  };
}
export async function changeCart(owner, action) {
  if (!owner) throw new AppError("A cart session is required.", 401);
  const db = await getDb();
  for (let attempt = 0; attempt < 4; attempt++) {
    const cart = await rawCart(owner);
    const entries = cart.entries.map((entry) => ({ ...entry }));
    let coupon = cart.coupon || "";
    if (action.type === "add") {
      const p = await getProduct(action.productId);
      if (!p) throw new AppError("This product is no longer available.", 404);
      const size = typeof action.size === "string" ? action.size : p.sizes[0];
      if (!p.sizes.includes(size))
        throw new AppError("Choose an available size.");
      if (
        !Number.isInteger(action.quantity) ||
        action.quantity < p.minOrder ||
        action.quantity > 10000
      )
        throw new AppError("Enter a valid carton quantity.");
      const id = cartLineId(p.id, size);
      const existing = entries.find((entry) => entry.id === id);
      if (existing) {
        if (action.saved !== true) {
          existing.quantity = existing.saved
            ? action.quantity
            : existing.quantity + action.quantity;
          existing.saved = false;
        }
      } else
        entries.push({
          id,
          productId: p.id,
          size,
          quantity: action.quantity,
          saved: action.saved === true,
          name: p.name,
          image: p.image,
          vendor: p.vendor,
          packSize: p.packSize,
        });
    } else if (action.type === "remove") {
      const index = entries.findIndex((entry) => entry.id === action.id);
      if (index < 0) throw new AppError("Cart item not found.", 404);
      entries.splice(index, 1);
    } else if (action.type === "update") {
      const entry = entries.find((entry) => entry.id === action.id);
      if (!entry) throw new AppError("Cart item not found.", 404);
      if (action.quantity !== undefined) {
        if (
          !Number.isInteger(action.quantity) ||
          action.quantity < 1 ||
          action.quantity > 10000
        )
          throw new AppError("Enter a valid carton quantity.");
        entry.quantity = action.quantity;
      }
      if (action.saved !== undefined) {
        if (typeof action.saved !== "boolean")
          throw new AppError("Invalid saved state.");
        entry.saved = action.saved;
      }
    } else if (action.type === "coupon") {
      coupon = text(action.code, "Coupon code", 24).toUpperCase();
      if (!/^[A-Z0-9_-]{3,24}$/.test(coupon) || !(await couponFor(db, coupon)))
        throw new AppError("This coupon is not active.");
    } else if (action.type === "remove-coupon") coupon = "";
    else throw new AppError("Unknown cart action.");
    if (entries.some((entry) => entry.quantity > 10000))
      throw new AppError("Use up to 10,000 cartons per line.");
    if (entries.length > 50)
      throw new AppError("Use up to 50 different items per cart.");
    const candidate = { ...cart, entries, coupon };
    if (["add", "update"].includes(action.type) && action.saved !== true) {
      const preview = await quote(db, candidate);
      if (preview.items.some((item) => !item.saved && !item.available))
        throw new AppError(
          "The requested quantity or size is unavailable. Check the available stock.",
          409,
        );
    }
    const update = {
      $set: {
        entries,
        coupon,
        updatedAt: Date.now(),
        ...(owner.startsWith("guest:")
          ? { expiresAt: new Date(Date.now() + 30 * 86400000) }
          : {}),
      },
      $inc: { version: 1 },
    };
    if (!cart.version) {
      try {
        const result = await db.collection("carts").updateOne(
          { _id: owner, version: { $exists: false } },
          {
            $setOnInsert: {
              ...candidate,
              version: 1,
              updatedAt: Date.now(),
              ...(owner.startsWith("guest:")
                ? { expiresAt: new Date(Date.now() + 30 * 86400000) }
                : {}),
            },
          },
          { upsert: true },
        );
        if (result.upsertedCount) return quoteCart(owner);
      } catch (error) {
        if (error.code !== 11000) throw error;
      }
    } else if (
      (
        await db
          .collection("carts")
          .updateOne({ _id: owner, version: cart.version }, update)
      ).modifiedCount
    )
      return quoteCart(owner);
  }
  throw new AppError(
    "Your cart changed in another tab. Please try again.",
    409,
  );
}
export async function mergeGuestCart(userId, guestOwner) {
  if (!guestOwner) return;
  await transaction(async (db, session) => {
    const guest = await db
      .collection("carts")
      .findOne({ _id: guestOwner }, { session });
    if (!guest) return;
    const userOwner = "user:" + userId;
    const current = await rawCart(userOwner, session);
    const entries = [...current.entries];
    for (const entry of guest.entries) {
      const existing = entries.find((item) => item.id === entry.id);
      if (existing) {
        existing.quantity = Math.min(10000, existing.quantity + entry.quantity);
        existing.saved = existing.saved && entry.saved;
      } else entries.push(entry);
    }
    if (entries.length > 50)
      throw new AppError(
        "Your combined cart has too many items. Remove a few items before logging in.",
      );
    await db.collection("carts").updateOne(
      { _id: userOwner },
      {
        $set: {
          entries,
          coupon: current.coupon || guest.coupon || "",
          updatedAt: Date.now(),
        },
        $inc: { version: 1 },
      },
      { upsert: true, session },
    );
    await db.collection("carts").deleteOne({ _id: guestOwner }, { session });
  });
}
export function validateAddress(input) {
  if (!input || typeof input !== "object")
    throw new AppError("Enter a shipping address.");
  const address = {
    name: text(input.name, "Full name", 100, 2),
    phone: normalizePhone(input.phone),
    line1: text(input.line1, "Street address", 200, 5),
    line2:
      typeof input.line2 === "string"
        ? text(input.line2, "Address line 2", 150, 0)
        : "",
    city: text(input.city, "City", 80, 2),
    state: text(input.state, "State", 80, 2),
    pincode: text(input.pincode, "PIN code", 6, 6),
    gstin:
      typeof input.gstin === "string" ? input.gstin.trim().toUpperCase() : "",
  };
  if (!/^[1-9]\d{5}$/.test(address.pincode))
    throw new AppError("Enter a valid 6-digit Indian PIN code.");
  if (
    address.gstin &&
    !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(address.gstin)
  )
    throw new AppError("Enter a valid GSTIN or leave it blank.");
  return address;
}
export const publicOrder = (row) => {
  if (!row) return null;
  const { _id, idempotencyKey, ...data } = row;
  return { id: _id, ...data };
};
export async function createOrder(user, input) {
  if (!user) throw new AppError("Sign in to submit your order.", 401);
  const address = validateAddress(input.address);
  if (
    typeof input.idempotencyKey !== "string" ||
    !/^[a-f0-9-]{36}$/.test(input.idempotencyKey)
  )
    throw new AppError("Refresh the checkout and try again.");
  const db = await getDb();
  const previous = await db
    .collection("orders")
    .findOne({ userId: user.id, idempotencyKey: input.idempotencyKey });
  if (previous) return publicOrder(previous);
  try {
    return await transaction(async (db, session) => {
      const existing = await db
        .collection("orders")
        .findOne(
          { userId: user.id, idempotencyKey: input.idempotencyKey },
          { session },
        );
      if (existing) return publicOrder(existing);
      const owner = "user:" + user.id,
        cart = await rawCart(owner, session),
        pricing = await quote(db, cart, session);
      if (!pricing.checkoutReady)
        throw new AppError(
          "Your cart is empty or contains an unavailable item. Please review it.",
          409,
        );
      if (
        typeof input.expectedTotal !== "number" ||
        paise(input.expectedTotal) !== paise(pricing.total)
      )
        throw new AppError(
          "Your cart pricing changed. Refresh checkout to review the updated total.",
          409,
        );
      const items = pricing.items.filter((item) => !item.saved);
      const quantities = new Map();
      for (const item of items)
        quantities.set(
          item.productId,
          (quantities.get(item.productId) || 0) + item.quantity,
        );
      for (const [id, quantity] of quantities) {
        const updated = await db
          .collection("products")
          .updateOne(
            { _id: id, status: "published", stock: { $gte: quantity } },
            { $inc: { stock: -quantity } },
            { session },
          );
        if (!updated.modifiedCount)
          throw new AppError(
            "An item no longer has enough stock. Please review your cart.",
            409,
          );
      }
      const order = {
        _id: randomUUID(),
        orderNumber:
          "MG-" +
          new Date().toISOString().slice(0, 10).replaceAll("-", "") +
          "-" +
          randomUUID().slice(0, 8).toUpperCase(),
        userId: user.id,
        phone: user.phone,
        address,
        items,
        subtotal: pricing.subtotal,
        tax: pricing.tax,
        discount: pricing.discount,
        coupon: pricing.coupon,
        shipping: pricing.shipping,
        total: pricing.total,
        status: "requested",
        paymentStatus: "not_connected",
        idempotencyKey: input.idempotencyKey,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await db.collection("orders").insertOne(order, { session });
      const cleared = await db.collection("carts").updateOne(
        { _id: owner, version: cart.version },
        {
          $set: {
            entries: cart.entries.filter((entry) => entry.saved),
            coupon: "",
          },
          $inc: { version: 1 },
        },
        { session },
      );
      if (!cleared.modifiedCount)
        throw new AppError("Your cart changed. Please try again.", 409);
      return publicOrder(order);
    });
  } catch (error) {
    if (error.code === 11000) {
      const order = await db
        .collection("orders")
        .findOne({ userId: user.id, idempotencyKey: input.idempotencyKey });
      if (order) return publicOrder(order);
    }
    throw error;
  }
}
/** @returns {Promise<import("../types").Order[]>} */
export async function listOrders(user) {
  return (
    await (
      await getDb()
    )
      .collection("orders")
      .find(user.role === "admin" ? {} : { userId: user.id })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray()
  ).map(publicOrder);
}
/** @returns {Promise<import("../types").Order | null>} */
export async function getOrder(id, user) {
  return publicOrder(
    await (await getDb()).collection("orders").findOne({
      _id: id,
      ...(user.role === "admin" ? {} : { userId: user.id }),
    }),
  );
}
export async function updateOrder(id, status) {
  const transitions = {
    requested: ["confirmed", "cancelled"],
    confirmed: ["processing", "cancelled"],
    processing: ["shipped", "cancelled"],
    shipped: [],
    cancelled: [],
  };
  return transaction(async (db, session) => {
    const order = await db
      .collection("orders")
      .findOne({ _id: id }, { session });
    if (!order) throw new AppError("Order not found.", 404);
    if (order.status === status) return publicOrder(order);
    if (!transitions[order.status]?.includes(status))
      throw new AppError("This order status change is not allowed.");
    if (status === "cancelled")
      for (const item of order.items)
        await db
          .collection("products")
          .updateOne(
            { _id: item.productId },
            { $inc: { stock: item.quantity } },
            { session },
          );
    await db
      .collection("orders")
      .updateOne(
        { _id: id },
        { $set: { status, updatedAt: Date.now() } },
        { session },
      );
    return publicOrder({ ...order, status });
  });
}
