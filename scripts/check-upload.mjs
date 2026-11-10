// This check sends only a generated, content-free 1x1 transparent PNG.
// It never reads or uploads local files, screenshots, project content or user data.
import { storeImage } from "../src/services/store.mjs";
import { getDb, closeDb } from "../src/services/db.mjs";
import { deflateSync } from "node:zlib";
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type),
    size = Buffer.alloc(4),
    checksum = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, checksum]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(1, 0);
header.writeUInt32BE(1, 4);
header[8] = 8;
header[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 0]))),
  chunk("IEND", Buffer.alloc(0)),
]);
let created;
try {
  const url = await storeImage(png, "image/png");
  const db = await getDb();
  created = await db.collection("media").findOne({ url });
  if (!created?.fileId)
    throw new Error("Upload succeeded but metadata could not be verified.");
  console.log("Live upload of a generated blank pixel and media metadata: OK");
  const response = await fetch(
    "https://api.imagekit.io/v1/files/" + encodeURIComponent(created.fileId),
    {
      method: "DELETE",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(process.env.IMAGEKIT_PRIVATE_KEY + ":").toString(
            "base64",
          ),
      },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok)
    throw new Error("The newly created check image could not be removed.");
  await db.collection("media").deleteOne({ _id: created._id });
  created = null;
  console.log("Removed the newly created check image and metadata.");
} catch (error) {
  console.error(error.message);
  if (created)
    console.error("The generated blank-pixel check file needs cleanup.");
  process.exitCode = 1;
} finally {
  await closeDb();
}
