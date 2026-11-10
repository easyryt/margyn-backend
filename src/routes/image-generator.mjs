import { Router } from "express";
import multer from "multer";
import { requireUser } from "../middleware/session.mjs";
import { AppError } from "../services/errors.mjs";
import { rateLimit } from "../services/auth.mjs";
import { withAiUsage } from "../services/ai-usage.mjs";
import { runImageGeneration } from "../services/image-allowance.mjs";
import { GET as providers } from "../tools/image-generator/app/api/providers/route.mjs";
import { POST as covers } from "../tools/image-generator/app/api/generate/route.mjs";
import { POST as charms } from "../tools/image-generator/app/api/generate-charms/route.mjs";
import { POST as packs } from "../tools/image-generator/app/api/generate-charm-pack/route.mjs";
const handlers = {
  generate: covers,
  "generate-charms": charms,
  "generate-charm-pack": packs,
};
const activeUsers = new Set();
const uploads = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 2,
    fields: 16,
    parts: 18,
    fieldSize: 16384,
  },
  fileFilter(_req, file, callback) {
    const accepted = ["image/png", "image/jpeg", "image/webp"].includes(
      file.mimetype,
    );
    callback(
      accepted ? null : new AppError("Choose a JPG, PNG or WebP image.", 415),
      accepted,
    );
  },
});
const fields = {
  generate: [{ name: "image", maxCount: 1 }],
  "generate-charms": [
    { name: "cover", maxCount: 1 },
    { name: "charm", maxCount: 1 },
  ],
  "generate-charm-pack": [{ name: "image", maxCount: 1 }],
};
async function sendResult(response, res) {
  // The original handlers return Web Responses; Express owns authentication and transport.
  const body = await response.text();
  res.status(response.status).type("application/json").send(body);
}
export const imageGeneratorRoutes = Router();
imageGeneratorRoutes.use(requireUser);
imageGeneratorRoutes.get("/providers", async (_req, res) =>
  sendResult(await providers(), res),
);
imageGeneratorRoutes.post("/:action", async (req, res, next) => {
  const action = req.params.action;
  if (!Object.hasOwn(handlers, action))
    throw new AppError("Image tool action not found.", 404);
  if (!req.is("multipart/form-data"))
    throw new AppError("Upload images using multipart form data.", 415);
  await rateLimit("image-generator:" + req.user.id, 60, 3600);
  if (activeUsers.has(req.user.id))
    throw new AppError(
      "Your images are still being generated. Wait for that request to finish.",
      429,
      5,
    );
  if (activeUsers.size >= 3)
    throw new AppError(
      "The image studio is busy. Please try again shortly.",
      429,
      10,
    );
  activeUsers.add(req.user.id);
  let result;
  let failure;
  try {
    await new Promise((resolve, reject) =>
      uploads.fields(fields[action])(req, res, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    const form = new FormData();
    for (const [name, value] of Object.entries(req.body || {})) {
      for (const text of Array.isArray(value) ? value : [value]) {
        if (typeof text !== "string")
          throw new AppError("Use plain text for image-generation settings.");
        form.append(name, text);
      }
    }
    for (const [name, files] of Object.entries(req.files || {})) {
      for (const file of files)
        form.append(
          name,
          new Blob([Uint8Array.from(file.buffer)], { type: file.mimetype }),
          file.originalname,
        );
    }
    result = await runImageGeneration(req.user.id, (reserveImages, recordResult) => withAiUsage(req.user.id, `image-generator/${action}`,
      async () => recordResult(await handlers[action]({ formData: async () => form, reserveImages }))));
  } catch (error) {
    failure =
      error instanceof multer.MulterError
        ? new AppError(
            error.code === "LIMIT_FILE_SIZE"
              ? "Each image must be 10 MB or smaller."
              : "Upload only the images and settings required for this tool.",
            error.code === "LIMIT_FILE_SIZE" ? 413 : 400,
          )
        : error;
  } finally {
    activeUsers.delete(req.user.id);
  }
  if (res.destroyed) return;
  if (failure) return next(failure);
  return sendResult(result, res);
});
