import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { MongoMemoryReplSet } from "mongodb-memory-server";
process.env.NODE_ENV = "test";
process.env.OTP_PROVIDER = "development";
process.env.MONGODB_DB = "margyn_test";
process.env.SHIPPING_FLAT_RATE = "79";
process.env.FREE_SHIPPING_ABOVE = "999";
process.env.IMAGEKIT_URL_ENDPOINT = "https://ik.imagekit.io/t9rd9hyjk";
const { getDb, closeDb } = await import("../src/services/db.mjs");
const {
  requestOtp,
  verifyOtp,
  sessionUser,
  revokeSession,
  grantAdmin,
  rateLimit,
} = await import("../src/services/auth.mjs");
const {
  validateProduct,
  saveProduct,
  getProduct,
  listProducts,
  deleteProduct,
  storeImage,
} = await import("../src/services/store.mjs");
const { normalizePhone } = await import("../src/services/errors.mjs");
const {
  quoteCart,
  changeCart,
  mergeGuestCart,
  createOrder,
  updateOrder,
  getOrder,
} = await import("../src/services/commerce.mjs");
const fixture = (change = {}) => ({
  name: "Test courier bag",
  sku: "TEST-" + randomUUID(),
  category: "Courier bags",
  description: "A test courier bag for backend verification.",
  price: 2.53,
  compareAt: 3,
  unit: "piece",
  packSize: 50,
  minOrder: 1,
  stock: 100,
  image: "/products/mailer.svg",
  images: ["/products/mailer.svg"],
  status: "published",
  featured: false,
  vendor: "Sample vendor",
  verified: false,
  specification: "51–60 Micron",
  sizes: ["6X8", "8X10"],
  gstRate: 18,
  dispatchDays: 2,
  shipsFrom: "India",
  tiers: [
    { minCartons: 1, price: 2.53 },
    { minCartons: 2, price: 2.45 },
    { minCartons: 10, price: 2.19 },
  ],
  ...change,
});
const address = {
  name: "Test buyer",
  phone: "9876543210",
  line1: "12 Test Street",
  line2: "",
  city: "Indore",
  state: "Madhya Pradesh",
  pincode: "452010",
  gstin: "",
};
await test(
  "MongoDB authentication, catalog and transactional commerce",
  { timeout: 180000 },
  async (t) => {
    const mongo = await MongoMemoryReplSet.create({
      replSet: { count: 1 },
      instanceOpts: [{ launchTimeout: 30000 }],
    });
    process.env.MONGODB_URI = mongo.getUri();
    try {
      const db = await getDb();
      await t.test("normalizes Indian phone input", () => {
        assert.equal(normalizePhone("98765 43210"), "+919876543210");
        assert.throws(() => normalizePhone("+12345"));
      });
      await t.test("single-use OTP, hashed sessions and logout", async () => {
        const code = await requestOtp("9876543211");
        const result = await verifyOtp(code.challengeId, code.developmentCode);
        assert.equal(result.user.role, "customer");
        assert.equal((await sessionUser(result.token)).id, result.user.id);
        assert.equal(
          await db.collection("sessions").findOne({ _id: result.token }),
          null,
        );
        await assert.rejects(() =>
          verifyOtp(code.challengeId, code.developmentCode),
        );
        await revokeSession(result.token);
        assert.equal(await sessionUser(result.token), null);
      });
      await t.test("explicit admin grant is preserved", async () => {
        await grantAdmin("9876543212");
        const code = await requestOtp("9876543212");
        assert.equal(
          (await verifyOtp(code.challengeId, code.developmentCode)).user.role,
          "admin",
        );
      });
      await t.test(
        "expired codes and five failed attempts are rejected",
        async () => {
          const code = await requestOtp("9876543213");
          const wrong = code.developmentCode === "111111" ? "222222" : "111111";
          for (let i = 0; i < 5; i++)
            await assert.rejects(() => verifyOtp(code.challengeId, wrong));
          await assert.rejects(() =>
            verifyOtp(code.challengeId, code.developmentCode),
          );
          const expired = await requestOtp("9876543214");
          await db
            .collection("otp_challenges")
            .updateOne(
              { _id: expired.challengeId },
              { $set: { expiresAt: new Date(0) } },
            );
          await assert.rejects(() =>
            verifyOtp(expired.challengeId, expired.developmentCode),
          );
        },
      );
      await t.test("concurrent OTP verification succeeds once", async () => {
        const code = await requestOtp("9876543215");
        const results = await Promise.allSettled([
          verifyOtp(code.challengeId, code.developmentCode),
          verifyOtp(code.challengeId, code.developmentCode),
        ]);
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      });
      await t.test("resend cooldown and persistent rate limits", async () => {
        await requestOtp("9876543216");
        await assert.rejects(
          () => requestOtp("9876543216"),
          (e) => e.status === 429,
        );
        await rateLimit("unit:limit", 1, 60);
        await assert.rejects(
          () => rateLimit("unit:limit", 1, 60),
          (e) => e.status === 429,
        );
      });
      await t.test(
        "expired sessions and production development codes fail closed",
        async () => {
          const code = await requestOtp("9876543217");
          const login = await verifyOtp(code.challengeId, code.developmentCode);
          await db
            .collection("sessions")
            .updateOne(
              { _id: createHash("sha256").update(login.token).digest("hex") },
              { $set: { expiresAt: new Date(0) } },
            );
          assert.equal(await sessionUser(login.token), null);
          const dev = await requestOtp("9876543218");
          process.env.NODE_ENV = "production";
          try {
            await assert.rejects(
              () => requestOtp("9876543219"),
              (e) => e.status === 503,
            );
            await assert.rejects(() =>
              verifyOtp(dev.challengeId, dev.developmentCode),
            );
          } finally {
            process.env.NODE_ENV = "test";
          }
        },
      );
      await t.test(
        "draft visibility, product edits and unique SKU",
        async () => {
          const product = await saveProduct(fixture({ status: "draft" }));
          assert.equal(await getProduct(product.id), null);
          const published = await saveProduct(
            { ...product, status: "published" },
            product.id,
          );
          assert.equal(published.price, 2.53);
          assert.equal((await getProduct(product.id)).tiers.length, 3);
          await assert.rejects(
            () => saveProduct({ ...fixture(), sku: product.sku }),
            (e) => e.status === 409,
          );
          await deleteProduct(product.id);
          assert.equal(await getProduct(product.id), null);
        },
      );
      await t.test(
        "rejects malformed wholesale tiers, remote images and unsafe numbers",
        () => {
          for (const update of [
            { price: -1 },
            { stock: 1.5 },
            { image: "https://evil.invalid/a.png" },
            { tiers: [{ minCartons: 2, price: 2.53 }] },
            {
              tiers: [
                { minCartons: 1, price: 2.53 },
                { minCartons: 3, price: 2.4 },
                { minCartons: 3, price: 2.3 },
              ],
            },
          ])
            assert.throws(() => validateProduct(fixture(update)));
        },
      );
      await t.test(
        "ImageKit upload uses server credentials; invalid images rejected",
        async () => {
          const original = globalThis.fetch;
          process.env.IMAGEKIT_PRIVATE_KEY = "unit-test-private-key";
          const png = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1sAAAAASUVORK5CYII=",
            "base64",
          );
          globalThis.fetch = async (url, init) => {
            assert.equal(url, "https://upload.imagekit.io/api/v1/files/upload");
            assert.ok(init.headers.Authorization.startsWith("Basic "));
            assert.equal(init.body.get("folder"), "/margyn/products");
            return Response.json({
              url: "https://ik.imagekit.io/t9rd9hyjk/test.png",
              fileId: "test-file",
            });
          };
          try {
            assert.equal(
              await storeImage(png, "image/png"),
              "https://ik.imagekit.io/t9rd9hyjk/test.png",
            );
            await assert.rejects(() =>
              storeImage(Buffer.from("<svg/>"), "image/png"),
            );
            await assert.rejects(() =>
              storeImage(Buffer.alloc(5 * 1024 * 1024 + 1), "image/png"),
            );
          } finally {
            globalThis.fetch = original;
          }
        },
      );
      await t.test(
        "cart pricing ignores client prices and applies tiers, coupon, GST and shipping",
        async () => {
          const product = await saveProduct(fixture());
          const owner = "guest:" + randomUUID();
          await changeCart(owner, {
            type: "add",
            productId: product.id,
            size: "6X8",
            quantity: 2,
            price: 0.01,
          });
          await db.collection("coupons").insertOne({
            code: "TEST10",
            percent: 10,
            active: true,
            expiresAt: new Date(Date.now() + 60000),
          });
          const cart = await changeCart(owner, {
            type: "coupon",
            code: "test10",
          });
          assert.equal(cart.subtotal, 245);
          assert.equal(cart.discount, 24.5);
          assert.equal(cart.tax, 39.69);
          assert.equal(cart.shipping, 79);
          assert.equal(cart.total, 339.19);
          await changeCart(owner, {
            type: "update",
            id: cart.items[0].id,
            saved: true,
          });
          assert.equal((await quoteCart(owner)).total, 0);
        },
      );
      await t.test(
        "aggregates stock across selected sizes and rejects invalid variants",
        async () => {
          const product = await saveProduct(fixture({ stock: 3 }));
          const owner = "guest:" + randomUUID();
          await changeCart(owner, {
            type: "add",
            productId: product.id,
            size: "6X8",
            quantity: 2,
          });
          await assert.rejects(
            () =>
              changeCart(owner, {
                type: "add",
                productId: product.id,
                size: "8X10",
                quantity: 2,
              }),
            (e) => e.status === 409,
          );
          await assert.rejects(() =>
            changeCart(owner, {
              type: "add",
              productId: product.id,
              size: "MISSING",
              quantity: 1,
            }),
          );
        },
      );
      await t.test("guest cart merges into authenticated cart", async () => {
        const product = await saveProduct(fixture());
        const guest = "guest:" + randomUUID(),
          userId = randomUUID();
        await changeCart(guest, {
          type: "add",
          productId: product.id,
          size: "6X8",
          quantity: 1,
        });
        await mergeGuestCart(userId, guest);
        assert.equal((await quoteCart("user:" + userId)).cartons, 1);
        assert.equal((await quoteCart(guest)).cartons, 0);
      });
      await t.test(
        "orders reprice on the server, are idempotent, and restore inventory once on cancellation",
        async () => {
          const product = await saveProduct(fixture({ stock: 10 }));
          const user = {
            id: randomUUID(),
            phone: "+919876543210",
            role: "customer",
          };
          const owner = "user:" + user.id;
          await changeCart(owner, {
            type: "add",
            productId: product.id,
            size: "6X8",
            quantity: 2,
          });
          const cart = await quoteCart(owner),
            key = randomUUID();
          await assert.rejects(
            () =>
              createOrder(user, {
                address,
                idempotencyKey: key,
                expectedTotal: 0.01,
              }),
            (e) => e.status === 409,
          );
          const order = await createOrder(user, {
            address,
            idempotencyKey: key,
            expectedTotal: cart.total,
          });
          assert.equal(order.paymentStatus, "not_connected");
          assert.equal((await getProduct(product.id)).stock, 8);
          assert.equal((await quoteCart(owner)).cartons, 0);
          const replay = await createOrder(user, {
            address,
            idempotencyKey: key,
            expectedTotal: cart.total,
          });
          assert.equal(replay.id, order.id);
          assert.equal((await getProduct(product.id)).stock, 8);
          assert.equal(
            await getOrder(order.id, { id: "different", role: "customer" }),
            null,
          );
          await updateOrder(order.id, "cancelled");
          await updateOrder(order.id, "cancelled");
          assert.equal((await getProduct(product.id)).stock, 10);
        },
      );
      await t.test("concurrent orders cannot oversell", async () => {
        const product = await saveProduct(fixture({ stock: 3 }));
        const users = [
          { id: randomUUID(), phone: "+919876543210" },
          { id: randomUUID(), phone: "+919876543211" },
        ];
        const inputs = [];
        for (const user of users) {
          const owner = "user:" + user.id;
          await changeCart(owner, {
            type: "add",
            productId: product.id,
            size: "6X8",
            quantity: 3,
          });
          inputs.push({
            address,
            idempotencyKey: randomUUID(),
            expectedTotal: (await quoteCart(owner)).total,
          });
        }
        const results = await Promise.allSettled(
          users.map((user, index) => createOrder(user, inputs[index])),
        );
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        assert.equal((await getProduct(product.id)).stock, 0);
      });
    } finally {
      await closeDb();
      await mongo.stop();
    }
  },
);
