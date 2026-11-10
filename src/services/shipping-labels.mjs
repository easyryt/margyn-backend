import { Worker } from "node:worker_threads";
import { AppError } from "./errors.mjs";
export const MAX_SHIPPING_PDF_SIZE = 1024 * 1024 * 1024;
const activeUsers = new Set();
export function reserveShippingSlot(userId) {
  if (activeUsers.has(userId))
    throw new AppError(
      "Your PDF is already being processed. Wait for it to finish.",
      429,
      5,
    );
  if (activeUsers.size >= 2)
    throw new AppError(
      "The PDF sorter is busy. Please try again in a moment.",
      429,
      10,
    );
  activeUsers.add(userId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeUsers.delete(userId);
  };
}
export function runShippingJob(action, filePath, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("../tools/shipping-labels/worker.mjs", import.meta.url),
      {
        workerData: { action, filePath },
        stdout: true,
        stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 1024 },
      },
    );
    // Parser diagnostics can contain uploaded document content. Do not forward them to logs.
    worker.stdout.resume();
    worker.stderr.resume();
    let finished = false;
    let timer;
    const finish = async (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      await worker.terminate();
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () =>
      void finish(new AppError("PDF processing was cancelled.", 499));
    worker.once(
      "message",
      (result) =>
        void finish(
          result.error
            ? new AppError(result.error, result.status || 400)
            : null,
          result,
        ),
    );
    worker.once(
      "error",
      () =>
        void finish(
          new AppError(
            "This PDF could not be processed. Try a smaller file.",
            422,
          ),
        ),
    );
    worker.once("exit", () => {
      if (!finished)
        void finish(
          new AppError("PDF processing stopped. Please try again.", 422),
        );
    });
    timer = setTimeout(
      () =>
        void finish(
          new AppError(
            "This PDF took too long to process. Try a smaller file.",
            504,
          ),
        ),
      300000,
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
