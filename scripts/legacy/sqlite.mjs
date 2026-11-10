import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "../../src/services/errors.mjs";

export function getDb() {
  const directory = path.resolve(
    /* turbopackIgnore: true */ process.env.DATA_DIR || ".data",
  );
  const key = Symbol.for("packi.database");
  if (globalThis[key]?.directory === directory) return globalThis[key].db;
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(path.join(directory, "packi.sqlite"));
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, phone TEXT UNIQUE NOT NULL, role TEXT NOT NULL DEFAULT 'customer', created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS otp_challenges (id TEXT PRIMARY KEY, phone TEXT NOT NULL, hash TEXT NOT NULL, provider TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, resets_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, name TEXT NOT NULL, sku TEXT UNIQUE NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL, price INTEGER NOT NULL, compare_at INTEGER NOT NULL DEFAULT 0, unit TEXT NOT NULL, min_order INTEGER NOT NULL, stock INTEGER NOT NULL, image TEXT NOT NULL, status TEXT NOT NULL, featured INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS challenges_phone ON otp_challenges(phone);
    CREATE INDEX IF NOT EXISTS products_status ON products(status);`);
  globalThis[key] = { directory, db };
  const now = Date.now();
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
  db.prepare("DELETE FROM otp_challenges WHERE expires_at < ?").run(now);
  db.prepare("DELETE FROM rate_limits WHERE resets_at < ?").run(now);
  if (
    !db
      .prepare("SELECT value FROM metadata WHERE key = 'catalog_seed_v1'")
      .get()
  )
    seed(db);
  return db;
}

function seed(db) {
  const items = [
    [
      "Tamper-proof courier bags",
      "PK-CB-001",
      "Courier bags",
      "Strong, lightweight mailers with a permanent adhesive seal. A dependable everyday choice for apparel, accessories and your next dispatch.",
      295,
      350,
      "pack of 100",
      1,
      240,
      "/products/mailer.svg",
      1,
    ],
    [
      "3-ply kraft shipping boxes",
      "PK-BX-002",
      "Shipping boxes",
      "Sturdy corrugated kraft boxes for neatly packed orders. Supplied flat for easy storage. Size: 8 × 6 × 4 inches.",
      480,
      560,
      "pack of 25",
      1,
      85,
      "/products/box.svg",
      1,
    ],
    [
      "4 × 6 thermal label rolls",
      "PK-LB-003",
      "Labels & stickers",
      "Sharp, smudge-resistant direct thermal shipping labels. 400 labels per roll. Compatible with standard 4-inch direct thermal printers.",
      240,
      290,
      "roll",
      2,
      180,
      "/products/labels.svg",
      1,
    ],
    [
      "Clear BOPP packing tape",
      "PK-TP-004",
      "Packing tapes",
      "A clean, secure finish for every carton. High-tack transparent packing tape, 48 mm wide. Six rolls in each pack.",
      330,
      390,
      "pack of 6",
      1,
      120,
      "/products/tape.svg",
      1,
    ],
    [
      "Honeycomb paper wrap",
      "PK-HC-005",
      "Protective packaging",
      "Expandable kraft paper cushioning for a considered unboxing. A paper alternative for wrapping non-fragile products and filling small gaps.",
      599,
      0,
      "roll",
      1,
      40,
      "/products/honeycomb.svg",
      0,
    ],
    [
      "Matte black gift mailers",
      "PK-GF-006",
      "Courier bags",
      "A minimal, premium look for your brand. Matte black self-seal courier bags for small business dispatches. Size: 10 × 12 inches.",
      425,
      499,
      "pack of 100",
      1,
      12,
      "/products/black-mailer.svg",
      0,
    ],
  ];
  db.exec("BEGIN IMMEDIATE");
  try {
    const insert = db.prepare(
      "INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const item of items) {
      const [
        name,
        sku,
        category,
        description,
        price,
        compare,
        unit,
        minimum,
        stock,
        image,
        featured,
      ] = item;
      const now = Date.now();
      insert.run(
        randomUUID(),
        name,
        sku,
        category,
        description,
        price * 100,
        compare * 100,
        unit,
        minimum,
        stock,
        image,
        "published",
        featured,
        now,
        now,
      );
    }
    db.prepare("INSERT INTO metadata VALUES (?, ?)").run(
      "catalog_seed_v1",
      "1",
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** @returns {import('../../src/types').Product} */
function product(row) {
  return {
    id: row.id,
    name: row.name,
    sku: row.sku,
    category: row.category,
    description: row.description,
    price: row.price / 100,
    compareAt: row.compare_at / 100,
    unit: row.unit,
    minOrder: row.min_order,
    stock: row.stock,
    image: row.image,
    status: row.status,
    featured: Boolean(row.featured),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
/** @returns {import('../../src/types').Product[]} */
export function listProducts(admin = false) {
  return getDb()
    .prepare(
      `SELECT * FROM products ${admin ? "" : "WHERE status = 'published'"} ORDER BY featured DESC, created_at DESC, name ASC`,
    )
    .all()
    .map(product);
}
/** @returns {import('../../src/types').User[]} */
export function listUsers() {
  return getDb()
    .prepare(
      "SELECT id, phone, role, created_at AS createdAt FROM users ORDER BY created_at DESC",
    )
    .all()
    .map((row) => ({ ...row }));
}
function text(value, label, max, min = 1) {
  if (
    typeof value !== "string" ||
    value.trim().length < min ||
    value.trim().length > max
  )
    throw new AppError(`${label} must be ${min}-${max} characters.`);
  return value.trim();
}
function number(value, label, min, max, integer = false) {
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
export function validateProduct(input) {
  const p = {
    name: text(input.name, "Product name", 140),
    sku: text(input.sku, "SKU", 60).toUpperCase(),
    category: text(input.category, "Category", 60),
    description: text(input.description, "Description", 4000, 10),
    price: number(input.price, "Price", 0.01, 10000000),
    compareAt: number(input.compareAt ?? 0, "Original price", 0, 10000000),
    unit: text(input.unit, "Selling unit", 60),
    minOrder: number(input.minOrder, "Minimum order", 1, 1000000, true),
    stock: number(input.stock, "Stock", 0, 10000000, true),
    image: text(input.image, "Product image", 160),
    status: input.status,
    featured: input.featured === true,
  };
  if (!["published", "draft"].includes(p.status))
    throw new AppError("Choose published or draft.");
  if (p.compareAt && p.compareAt < p.price)
    throw new AppError("Original price must be at least the selling price.");
  if (
    !/^\/products\/[a-z-]+\.svg$/.test(p.image) &&
    !/^\/api\/media\/[a-f0-9-]{36}$/.test(p.image)
  )
    throw new AppError("Upload a product image.");
  if (
    p.image.startsWith("/api/media/") &&
    !getDb()
      .prepare("SELECT id FROM media WHERE id = ?")
      .get(p.image.split("/").pop())
  )
    throw new AppError("The uploaded image could not be found.");
  return p;
}
/** @returns {import('../../src/types').Product} */
export function saveProduct(input, id = "") {
  const p = validateProduct(input);
  const db = getDb();
  const now = Date.now();
  if (id && !db.prepare("SELECT id FROM products WHERE id = ?").get(id))
    throw new AppError("Product not found.", 404);
  const duplicate = db
    .prepare("SELECT id FROM products WHERE sku = ? AND id != ?")
    .get(p.sku, id);
  if (duplicate)
    throw new AppError("A product with this SKU already exists.", 409);
  const values = [
    p.name,
    p.sku,
    p.category,
    p.description,
    Math.round(p.price * 100),
    Math.round(p.compareAt * 100),
    p.unit,
    p.minOrder,
    p.stock,
    p.image,
    p.status,
    Number(p.featured),
  ];
  if (id)
    db.prepare(
      "UPDATE products SET name=?, sku=?, category=?, description=?, price=?, compare_at=?, unit=?, min_order=?, stock=?, image=?, status=?, featured=?, updated_at=? WHERE id=?",
    ).run(...values, now, id);
  else {
    id = randomUUID();
    db.prepare(
      "INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, ...values, now, now);
  }
  return product(db.prepare("SELECT * FROM products WHERE id = ?").get(id));
}
export function deleteProduct(id) {
  if (!getDb().prepare("DELETE FROM products WHERE id = ?").run(id).changes)
    throw new AppError("Product not found.", 404);
}
export function storeImage(buffer, mime) {
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
  const id = randomUUID();
  getDb()
    .prepare("INSERT INTO media VALUES (?, ?, ?, ?)")
    .run(id, mime, buffer, Date.now());
  return "/api/media/" + id;
}
export function getImage(id) {
  return getDb().prepare("SELECT mime, data FROM media WHERE id = ?").get(id);
}
