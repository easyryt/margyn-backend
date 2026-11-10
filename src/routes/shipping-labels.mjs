import { Router } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireUser } from "../middleware/session.mjs";
import { AppError } from "../services/errors.mjs";
import { rateLimit } from "../services/auth.mjs";
import {
  MAX_SHIPPING_PDF_SIZE,
  reserveShippingSlot,
  runShippingJob,
} from "../services/shipping-labels.mjs";
const tempDir = join(tmpdir(), "margyn-shipping-labels");
const upload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, callback) {
      mkdir(tempDir, { recursive: true }).then(
        () => callback(null, tempDir),
        callback,
      );
    },
    filename(_req, _file, callback) {
      callback(null, randomUUID() + ".pdf");
    },
  }),
  limits: { fileSize: MAX_SHIPPING_PDF_SIZE, files: 1, fields: 0, parts: 1 },
  fileFilter(_req, file, callback) {
    const allowed =
      file.mimetype === "application/pdf" ||
      (file.mimetype === "application/octet-stream" &&
        /\.pdf$/i.test(file.originalname));
    callback(allowed ? null : new AppError("Choose a PDF file."), allowed);
  },
}).single("file");
export const shippingLabelRoutes = Router();
shippingLabelRoutes.use(requireUser);
shippingLabelRoutes.post("/:action", async (req, res, next) => {
  const action = req.params.action;
  if (!["stats", "process", "summary"].includes(action))
    throw new AppError("Shipping-label action not found.", 404);
  if (!req.is("multipart/form-data"))
    throw new AppError("Upload one PDF using the file field.", 415);
  await rateLimit("shipping-pdf:" + req.user.id, 120, 3600);
  const release = reserveShippingSlot(req.user.id);
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once("close", onClose);
  let result;
  let failure;
  try {
    await new Promise((resolve, reject) =>
      upload(req, res, (error) => (error ? reject(error) : resolve())),
    );
    if (!req.file || !req.file.size)
      throw new AppError("Choose a non-empty shipping-label PDF.");
    result = await runShippingJob(action, req.file.path, controller.signal);
  } catch (error) {
    failure =
      error instanceof multer.MulterError
        ? new AppError(
            error.code === "LIMIT_FILE_SIZE"
              ? "Choose a PDF smaller than 1 GB."
              : "Upload one PDF in the file field, without other fields.",
            error.code === "LIMIT_FILE_SIZE" ? 413 : 400,
          )
        : error;
  } finally {
    res.off("close", onClose);
    if (req.file?.path) await unlink(req.file.path).catch(() => {});
    release();
  }
  // Finish cleanup before responding: the next stats/process/summary request may arrive immediately.
  if (res.destroyed) return;
  if (failure) return next(failure);
  if (action === "stats") return res.json({ success: true, ...result.stats });
  const bytes = Buffer.from(result.bytes);
  res.set(
    "Content-Type",
    action === "summary" ? "application/pdf" : "application/zip",
  );
  res.set(
    "Content-Disposition",
    'attachment; filename="' +
      (action === "summary" ? "Order-Summary.pdf" : "Sorted-Orders.zip") +
      '"',
  );
  res.set("Content-Length", String(bytes.length));
  res.send(bytes);
});
