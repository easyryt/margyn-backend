import { getDb } from "./db.mjs";
import { AppError } from "./errors.mjs";

export const DEFAULT_ANNOUNCEMENT = Object.freeze({
  enabled: true,
  message: "WORK WITH US – BECOME OUR WAREHOUSE PARTNER",
  link: "",
  backgroundColor: "#1d3b53",
  textColor: "#f5f8ff",
  speed: "normal",
  updatedAt: 0,
});

export function validAnnouncementLink(value) {
  if (!value) return true;
  if (/[\s\\\u0000-\u001f\u007f]/.test(value)) return false;
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function validateAnnouncement(input) {
  if (typeof input.enabled !== "boolean")
    throw new AppError("Choose whether the announcement is visible.");
  if (
    typeof input.message !== "string" ||
    !input.message.trim() ||
    input.message.trim().length > 180
  )
    throw new AppError("Use a banner message between 1 and 180 characters.");
  const link =
    typeof input.link === "string"
      ? input.link.trim()
      : input.link === undefined
        ? ""
        : null;
  if (link === null || link.length > 500 || !validAnnouncementLink(link))
    throw new AppError(
      "Use a local path starting with / or a full HTTPS link.",
    );
  if (
    ![input.backgroundColor, input.textColor].every(
      (color) => typeof color === "string" && /^#[a-f0-9]{6}$/i.test(color),
    )
  )
    throw new AppError("Choose valid background and text colors.");
  if (!["slow", "normal", "fast"].includes(input.speed))
    throw new AppError("Choose a valid scroll speed.");
  return {
    enabled: input.enabled,
    message: input.message.trim().replace(/\s+/g, " "),
    link,
    backgroundColor: input.backgroundColor.toLowerCase(),
    textColor: input.textColor.toLowerCase(),
    speed: input.speed,
  };
}

export async function getAnnouncement() {
  const row = await (
    await getDb()
  )
    .collection("site_settings")
    .findOne({ _id: "announcement" });
  const {
    enabled,
    message,
    link,
    backgroundColor,
    textColor,
    speed,
    updatedAt,
  } = { ...DEFAULT_ANNOUNCEMENT, ...row };
  return {
    enabled,
    message,
    link,
    backgroundColor,
    textColor,
    speed,
    updatedAt,
  };
}

export async function saveAnnouncement(input, userId) {
  const settings = validateAnnouncement(input);
  await (
    await getDb()
  )
    .collection("site_settings")
    .updateOne(
      { _id: "announcement" },
      { $set: { ...settings, updatedAt: Date.now(), updatedBy: userId } },
      { upsert: true },
    );
  return getAnnouncement();
}
