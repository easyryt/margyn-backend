import { randomUUID } from "node:crypto";
import { transaction } from "./db.mjs";
import { ensureTokenAccount, assertAiAccess, subscriptionSummary } from "./subscriptions.mjs";
import { AppError } from "./errors.mjs";

// Reserve the selected output views before any provider work. Failed views are
// refunded; a crashed worker retains its reservation rather than granting retries.
export async function runImageGeneration(userId, work) {
  let reservation;
  let failure;
  let completed = 0;
  const reserveImages = async count => { try {
    if (reservation || !Number.isInteger(count) || count < 1 || count > 10) throw new AppError("Invalid AI image selection.");
    await ensureTokenAccount(userId);
    reservation = await transaction(async (db, session) => {
      const account = await db.collection("token_accounts").findOne({ _id: userId }, { session });
      assertAiAccess(account);
      if (account.imageLeaseUntil > Date.now()) throw new AppError("Your images are still being generated. Please wait.", 429);
      if (subscriptionSummary(account).remainingImages < count) throw new AppError("Your AI image allowance is too low for these views. Select fewer views or choose another plan.", 402);
      const id = randomUUID();
      await db.collection("token_accounts").updateOne({ _id: userId }, { $inc: { usedImages: count, revision: 1 },
        $set: { imageLeaseId: id, imageLeaseUntil: Date.now() + 360_000 } }, { session });
      return { id, count, periodId: account.periodId };
    });
  } catch (error) { failure = error; throw error; } };
  try {
    const result = await work(reserveImages, async response => {
      const payload = await response.clone().json();
      completed = Array.isArray(payload.images) ? payload.images.filter(image => typeof image?.dataUrl === "string" && image.dataUrl.startsWith("data:image/")).length : 0;
      return response;
    });
    if (failure) throw failure;
    return result;
  } finally {
    if (reservation) await transaction(async (db, session) => {
      const result = await db.collection("token_accounts").updateOne({ _id: userId, imageLeaseId: reservation.id, periodId: reservation.periodId }, {
        $inc: { usedImages: -Math.max(0, reservation.count - completed), revision: 1 }, $unset: { imageLeaseId: "", imageLeaseUntil: "" },
      }, { session });
      if (!result.modifiedCount) throw new AppError("AI image usage needs an administrator review.", 503);
      await db.collection("token_events").insertOne({ _id: randomUUID(), userId, type: "image-generation", periodId: reservation.periodId,
        createdAt: Date.now(), reserved: reservation.count, images: completed }, { session });
    });
  }
}
