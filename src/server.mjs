import "./config.mjs";
const { createApp } = await import("./app.mjs");
const { getDb, closeDb } = await import("./services/db.mjs");
const port = Number(process.env.PORT || 4000),
  host = process.env.HOST || "127.0.0.1";
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be between 1 and 65535.");
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
