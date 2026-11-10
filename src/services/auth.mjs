import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { getDb, publicUser } from "./db.mjs";
import { AppError, normalizePhone } from "./errors.mjs";
export const SESSION_COOKIE = "margyn_session";
export const SESSION_SECONDS = 60 * 60 * 24 * 7;
const hash = (value) => createHash("sha256").update(value).digest("hex");
export async function rateLimit(key, maximum, seconds) {
  const db = await getDb();
  const now = new Date();
  const update = [
    {
      $set: {
        count: {
          $cond: [{ $gt: ["$resetsAt", now] }, { $add: ["$count", 1] }, 1],
        },
        resetsAt: {
          $cond: [
            { $gt: ["$resetsAt", now] },
            "$resetsAt",
            new Date(Date.now() + seconds * 1000),
          ],
        },
      },
    },
  ];
  let result;
  try {
    result = await db
      .collection("rate_limits")
      .findOneAndUpdate({ _id: key }, update, {
        upsert: true,
        returnDocument: "after",
      });
  } catch (error) {
    if (error.code !== 11000) throw error;
    result = await db
      .collection("rate_limits")
      .findOneAndUpdate({ _id: key }, update, { returnDocument: "after" });
  }
  if (!result || result.count > maximum)
    throw new AppError(
      "Too many attempts. Please try again later.",
      429,
      Math.max(
        1,
        Math.ceil((result?.resetsAt.getTime() - Date.now()) / 1000) || seconds,
      ),
    );
}
function provider() {
  const choice =
    process.env.OTP_PROVIDER ||
    (process.env.NODE_ENV === "production" ? "twilio" : "development");
  // Explicit temporary deployment mode before SMS delivery is configured.
  if (choice === "test") return choice;
  if (choice === "development" && process.env.NODE_ENV !== "production")
    return choice;
  if (
    choice !== "twilio" ||
    !process.env.TWILIO_ACCOUNT_SID ||
    !process.env.TWILIO_AUTH_TOKEN ||
    !process.env.TWILIO_VERIFY_SERVICE_SID
  )
    throw new AppError(
      "SMS login is not configured yet. Please contact the store administrator.",
      503,
    );
  return "twilio";
}
async function twilio(resource, values) {
  try {
    const response = await fetch(
      `https://verify.twilio.com/v2/Services/${encodeURIComponent(process.env.TWILIO_VERIFY_SERVICE_SID)}/${resource}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization:
            "Basic " +
            Buffer.from(
              process.env.TWILIO_ACCOUNT_SID +
                ":" +
                process.env.TWILIO_AUTH_TOKEN,
            ).toString("base64"),
        },
        body: new URLSearchParams(values),
        signal: AbortSignal.timeout(12000),
      },
    );
    if (
      resource === "VerificationCheck" &&
      [400, 404, 429].includes(response.status)
    )
      throw new AppError(
        "The code is incorrect or expired. Request a new code.",
      );
    if (!response.ok)
      throw new AppError(
        "The SMS service is unavailable. Please try again shortly.",
        503,
      );
    return await response.json();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "The SMS service is unavailable. Please try again shortly.",
      503,
    );
  }
}

export async function requestOtp(value, ip = "local") {
  const phone = normalizePhone(value);
  const mode = provider();
  const db = await getDb();
  await rateLimit("send:ip:" + ip, 30, 900);
  await rateLimit("send:phone:" + phone, 5, 3600);
  await rateLimit("cooldown:" + phone, 1, 60);
  const id = randomUUID(),
    code = String(randomInt(100000, 1000000)),
    expiresAt = new Date(Date.now() + 5 * 60000);
  await db.collection("otp_challenges").deleteMany({ phone });
  await db.collection("otp_challenges").insertOne({
    _id: id,
    phone,
    hash: hash(id + code),
    provider: mode,
    attempts: 0,
    expiresAt,
  });
  if (mode === "twilio") {
    try {
      await twilio("Verifications", { To: phone, Channel: "sms" });
    } catch (error) {
      await db.collection("otp_challenges").deleteOne({ _id: id });
      throw error;
    }
  }
  return {
    challengeId: id,
    phone,
    expiresAt: expiresAt.getTime(),
    resendAfter: 60,
    ...(mode === "development" ? { developmentCode: code } : {}),
    ...(mode === "test" ? { otp: code, developmentCode: code } : {}),
  };
}
/** @returns {Promise<{token: string, user: import('../types').User}>} */
export async function verifyOtp(id, code, ip = "local") {
  if (
    typeof id !== "string" ||
    id.length > 50 ||
    typeof code !== "string" ||
    !/^\d{6}$/.test(code)
  )
    throw new AppError("Enter the 6-digit verification code.");
  await rateLimit("verify:ip:" + ip, 60, 900);
  const db = await getDb();
  const challenge = await db
    .collection("otp_challenges")
    .findOneAndUpdate(
      { _id: id, expiresAt: { $gt: new Date() }, attempts: { $lt: 5 } },
      { $inc: { attempts: 1 } },
      { returnDocument: "before" },
    );
  if (!challenge)
    throw new AppError(
      "This code has expired or has too many attempts. Request a new code.",
    );
  if (
    (challenge.provider === "development" && process.env.NODE_ENV === "production") ||
    (challenge.provider === "test" && process.env.OTP_PROVIDER !== "test")
  )
    throw new AppError("Request a new verification code.");
  const approved =
    challenge.provider === "twilio"
      ? (await twilio("VerificationCheck", { To: challenge.phone, Code: code }))
          .status === "approved"
      : timingSafeEqual(
          Buffer.from(challenge.hash, "hex"),
          Buffer.from(hash(id + code), "hex"),
        );
  if (!approved)
    throw new AppError("That code is incorrect. Please try again.");
  if (
    !(
      await db.collection("otp_challenges").deleteOne({
        _id: id,
        expiresAt: { $gt: new Date() },
        attempts: { $lte: 5 },
      })
    ).deletedCount
  )
    throw new AppError("This code is no longer valid. Request a new code.");
  const now = Date.now();
  await db.collection("users").updateOne(
    { phone: challenge.phone },
    {
      $setOnInsert: {
        _id: randomUUID(),
        phone: challenge.phone,
        role: "customer",
        createdAt: now,
      },
    },
    { upsert: true },
  );
  const user = publicUser(
    await db.collection("users").findOne({ phone: challenge.phone }),
  );
  const token = randomBytes(32).toString("hex");
  await db.collection("sessions").insertOne({
    _id: hash(token),
    userId: user.id,
    expiresAt: new Date(now + SESSION_SECONDS * 1000),
  });
  return { token, user };
}
/** @returns {Promise<import('../types').User | null>} */
export async function sessionUser(token) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return null;
  const db = await getDb();
  const session = await db
    .collection("sessions")
    .findOne({ _id: hash(token), expiresAt: { $gt: new Date() } });
  return session
    ? publicUser(await db.collection("users").findOne({ _id: session.userId }))
    : null;
}
export async function revokeSession(token) {
  if (typeof token === "string")
    await (
      await getDb()
    )
      .collection("sessions")
      .deleteOne({ _id: hash(token) });
}
export async function grantAdmin(value) {
  const phone = normalizePhone(value);
  await (await getDb()).collection("users").updateOne(
    { phone },
    {
      $set: { role: "admin" },
      $setOnInsert: { _id: randomUUID(), createdAt: Date.now() },
    },
    { upsert: true },
  );
  return phone;
}
