import "./config.mjs";
import { serverAddress } from "./services/server-address.mjs";
const { port, host } = serverAddress();
const { createApp } = await import("./app.mjs");
const { getDb, closeDb } = await import("./services/db.mjs");
try {
  await getDb();
  const server = createApp().listen(port, host);
  server.once("listening", () => {
    console.log(`Margyn Express API ready at http://${host}:${port}`);
  });
  server.on("error", async (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Cannot start Margyn API: port ${port} on ${host} is already in use (EADDRINUSE).`);
      console.error("Stop the other backend instance, then run npm run dev again. Keep only one backend running.");
    } else {
      console.error("Cannot start Margyn API:", error.code || "server error");
    }
    await closeDb();
    process.exit(1);
  });
  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    server.close(async () => {
      await closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} catch (error) {
  console.error(error.message);
  await closeDb();
  process.exit(1);
}
