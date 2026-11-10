import { randomUUID } from "node:crypto";
import { getDb } from "./db.mjs";
import { AppError } from "./errors.mjs";
export { getDb } from "./db.mjs";
export function product(row) {
  if (!row) return null;
  const { _id, ...data } = row;
  return { ...data, id: _id };
}
/** @returns {Promise<import('../types').Product[]>} */
export async function listProducts(admin = false) {
  return (
    await (
      await getDb()
    )
      .collection("products")
      .find(admin ? {} : { status: "published" })
      .sort({ featured: -1, createdAt: -1, name: 1 })
      .toArray()
  ).map(product);
}
/** @returns {Promise<import('../types').Product | null>} */
export async function getProduct(id, admin = false) {
  if (typeof id !== "string" || id.length > 100) return null;
  return product(
    await (
      await getDb()
    )
      .collection("products")
      .findOne({ _id: id, ...(admin ? {} : { status: "published" }) }),
  );
}
/** @returns {Promise<import('../types').User[]>} */
export async function listUsers() {
  return (
    await (
      await getDb()
    )
      .collection("users")
      .find({}, { projection: { phone: 1, name: 1, role: 1, createdAt: 1 } })
      .sort({ createdAt: -1 })
      .toArray()
  ).map(({ _id, ...row }) => ({ id: _id, ...row, name: row.name || "" }));
}
export function text(value, label, max, min = 1) {
  if (
    typeof value !== "string" ||
    value.trim().length < min ||
    value.trim().length > max
  )
    throw new AppError(`${label} must be ${min}-${max} characters.`);
  return value.trim();
}
export function number(value, label, min, max, integer = false) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  )
    throw new AppError(`Enter a valid ${label.toLowerCase()}.`);
  return value;
}
export function imageAllowed(value) {
  if (typeof value !== "string") return false;
  if (
    /^\/products\/[a-z-]+\.svg$/.test(value) ||
    /^\/api\/media\/[a-f0-9-]{36}$/.test(value)
  )
    return true;
  try {
    const endpoint = new URL(
      process.env.IMAGEKIT_URL_ENDPOINT || "https://ik.imagekit.io/t9rd9hyjk",
    );
    const image = new URL(value);
    return (
      image.protocol === "https:" &&
      image.origin === endpoint.origin &&
      image.pathname.startsWith(endpoint.pathname.replace(/\/$/, "") + "/")
    );
  } catch {
    return false;
  }
}
export function validateProduct(input) {
  const p = {
    name: text(input.name, "Product name", 180),
    sku: text(input.sku, "SKU", 60).toUpperCase(),
    category: text(input.category, "Category", 60),
    description: text(input.description, "Description", 6000, 10),
    price: number(input.price, "Price per piece", 0.01, 1000000),
    compareAt: number(input.compareAt ?? 0, "Original price", 0, 1000000),
    unit: text(input.unit || "piece", "Selling unit", 60),
    minOrder: number(input.minOrder, "Minimum order", 1, 10000, true),
    stock: number(input.stock, "Stock", 0, 1000000, true),
    image: text(input.image, "Product image", 1000),
    status: input.status,
    featured: input.featured === true,
    vendor: text(input.vendor || "Margyn", "Vendor", 80),
    verified: input.verified === true,
    specification: text(
      input.specification || "Standard quality",
      "Specification",
      100,
    ),
    packSize: number(input.packSize ?? 1, "Pieces per carton", 1, 100000, true),
    gstRate: number(input.gstRate ?? 0, "GST rate", 0, 28),
    dispatchDays: number(input.dispatchDays ?? 2, "Dispatch days", 1, 60, true),
    shipsFrom: text(input.shipsFrom || "India", "Dispatch location", 100),
  };
  p.price = Math.round(p.price * 100) / 100;
  p.compareAt = Math.round(p.compareAt * 100) / 100;
  if (!["published", "draft"].includes(p.status))
    throw new AppError("Choose published or draft.");
  if (p.compareAt && p.compareAt < p.price)
    throw new AppError("Original price must be at least the selling price.");
  if (!imageAllowed(p.image))
    throw new AppError("Choose an uploaded ImageKit image or a library image.");
  if (
    input.sizes !== undefined &&
    (!Array.isArray(input.sizes) || input.sizes.length > 20)
  )
    throw new AppError("Use up to 20 sizes.");
  p.sizes = [
    ...new Set(
      (input.sizes?.length ? input.sizes : ["Standard"]).map((size) =>
        text(size, "Size", 40),
      ),
    ),
  ];
  if (
    input.images !== undefined &&
    (!Array.isArray(input.images) || input.images.length > 8)
  )
    throw new AppError("Use up to 8 images.");
  p.images = [...new Set([p.image, ...(input.images || [])])];
  if (p.images.length > 8 || p.images.some((image) => !imageAllowed(image)))
    throw new AppError("Use valid product images.");
  if (
    input.tiers !== undefined &&
    (!Array.isArray(input.tiers) || input.tiers.length > 8)
  )
    throw new AppError("Use up to 8 wholesale tiers.");
  p.tiers = (
    input.tiers?.length
      ? input.tiers
      : [{ minCartons: p.minOrder, price: p.price }]
  )
    .map((tier) => ({
      minCartons: number(
        tier.minCartons,
        "Tier minimum",
        p.minOrder,
        10000,
        true,
      ),
      price:
        Math.round(number(tier.price, "Tier price", 0.01, p.price) * 100) / 100,
    }))
    .sort((a, b) => a.minCartons - b.minCartons);
  if (p.tiers[0].minCartons !== p.minOrder || p.tiers[0].price !== p.price)
    throw new AppError(
      "The first tier must match the minimum order and base price.",
    );
  for (let i = 1; i < p.tiers.length; i++)
    if (
      p.tiers[i].minCartons === p.tiers[i - 1].minCartons ||
      p.tiers[i].price > p.tiers[i - 1].price
    )
      throw new AppError(
        "Tier quantities must increase and prices must not increase.",
      );
  return p;
}
/** @returns {Promise<import('../types').Product>} */
export async function saveProduct(input, id = "") {
  const p = validateProduct(input);
  const db = await getDb();
  const now = Date.now();
  if (id && !(await db.collection("products").findOne({ _id: id })))
    throw new AppError("Product not found.", 404);
  id ||= randomUUID();
  try {
    await db.collection("products").updateOne(
      { _id: id },
      {
        $set: {
          ...p,
          slug: p.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, ""),
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
  } catch (error) {
    if (error.code === 11000)
      throw new AppError("A product with this SKU already exists.", 409);
    throw error;
  }
  return getProduct(id, true);
}
export async function deleteProduct(id) {
  if (
    !(await (await getDb()).collection("products").deleteOne({ _id: id }))
      .deletedCount
  )
    throw new AppError("Product not found.", 404);
}
export function validateImage(buffer, mime) {
  if (!buffer.length || buffer.length > 5 * 1024 * 1024)
    throw new AppError("Choose an image smaller than 5 MB.");
  const allowed =
    (mime === "image/png" &&
      buffer
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
    (mime === "image/jpeg" &&
      buffer[0] === 255 &&
      buffer[1] === 216 &&
      buffer[2] === 255) ||
    (mime === "image/webp" &&
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP");
  if (!allowed) throw new AppError("Upload a valid JPG, PNG or WebP image.");
}
export async function storeImage(buffer, mime) {
  validateImage(buffer, mime);
  if (!process.env.IMAGEKIT_PRIVATE_KEY)
    throw new AppError(
      "ImageKit uploads are not configured on the server.",
      503,
    );
  const id = randomUUID();
  const extension = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
  }[mime];
  const form = new FormData();
  form.set(
    "file",
    new Blob([new Uint8Array(buffer)], { type: mime }),
    `product-${id}.${extension}`,
  );
  form.set("fileName", `product-${id}.${extension}`);
  form.set("folder", "/margyn/products");
  form.set("useUniqueFileName", "true");
  let result;
  try {
    const response = await fetch(
      "https://upload.imagekit.io/api/v1/files/upload",
      {
        method: "POST",
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(process.env.IMAGEKIT_PRIVATE_KEY + ":").toString(
              "base64",
            ),
        },
        body: form,
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok) throw new Error();
    result = await response.json();
  } catch {
    throw new AppError(
      "ImageKit could not upload the image. Check the server API key or try again.",
      502,
    );
  }
  if (!imageAllowed(result.url) || typeof result.fileId !== "string")
    throw new AppError("ImageKit returned an unexpected upload response.", 502);
  await (await getDb()).collection("media").insertOne({
    _id: id,
    provider: "imagekit",
    url: result.url,
    fileId: result.fileId,
    mime,
    createdAt: Date.now(),
  });
  return result.url;
}
export async function getImage(id) {
  return (await getDb()).collection("media").findOne({ _id: id });
}
