import { MongoMemoryReplSet } from "mongodb-memory-server";
export async function startTestBackend(origin = "http://127.0.0.1:3100") {
  const mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ launchTimeout: 30000 }],
  });
  process.env.NODE_ENV = "test";
  // Test helpers never inherit live image-generation credentials.
  process.env.GEMINI_API_KEY = "isolated-test-gemini";
  process.env.OPENAI_API_KEY = "isolated-test-openai";
  process.env.RAZORPAY_KEY_ID = "rzp_test_isolated";
  process.env.RAZORPAY_KEY_SECRET = "isolated-test-razorpay-secret";
  process.env.RAZORPAY_WEBHOOK_SECRET = "isolated-test-webhook-secret";
  process.env.MONGODB_URI = mongo.getUri();
  process.env.MONGODB_DB = "margyn_browser_test";
  process.env.OTP_PROVIDER = "development";
  process.env.FRONTEND_ORIGIN = origin;
  process.env.TRUST_PROXY = "false";
  process.env.SHIPPING_FLAT_RATE = "79";
  process.env.FREE_SHIPPING_ABOVE = "999";
  process.env.IMAGEKIT_URL_ENDPOINT = "https://ik.imagekit.io/t9rd9hyjk";
  process.env.IMAGEKIT_PRIVATE_KEY = "isolated-test-key";
  process.env.IMAGEKIT_PUBLIC_KEY = "isolated-test-public";
  const { createApp } = await import("../../src/app.mjs");
  const { grantAdmin } = await import("../../src/services/auth.mjs");
  const { seedDemo } = await import("../../scripts/seed-demo.mjs");
  const { closeDb } = await import("../../src/services/db.mjs");
  const { getDb } = await import("../../src/services/db.mjs");
  // Isolated fixtures have an allowance; production defaults to zero until an admin assigns tokens.
  await (await getDb()).collection("site_settings").insertOne({ _id: "token-subscriptions", defaultTokenLimit: 1_000_000, defaultImageLimit: 1000, plans: [] });
  await seedDemo();
  await grantAdmin("9876543201");
  await grantAdmin("9876543204");
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await closeDb();
      await mongo.stop();
    },
  };
}
