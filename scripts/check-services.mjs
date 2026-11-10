import { getDb, closeDb } from "../src/services/db.mjs";
try {
  const db = await getDb();
  await db.command({ ping: 1 });
  console.log("MongoDB connection and indexes: OK");
  const response = await fetch("https://api.imagekit.io/v1/files?limit=1", {
    headers: {
      Authorization:
        "Basic " +
        Buffer.from(process.env.IMAGEKIT_PRIVATE_KEY + ":").toString("base64"),
    },
    signal: AbortSignal.timeout(15000),
  });
  console.log(
    "ImageKit authentication:",
    response.ok ? "OK" : "FAILED (HTTP " + response.status + ")",
  );
  if (!response.ok) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await closeDb();
}
