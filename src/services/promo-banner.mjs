import { getDb } from "./db.mjs";
import { AppError } from "./errors.mjs";
import { text, imageAllowed } from "./store.mjs";
import { validAnnouncementLink } from "./announcement.mjs";

export const DEFAULT_PROMO_BANNER = Object.freeze({
  enabled: true,
  eyebrow: "THE MARGYN STUDIO",
  title: "Make room for",
  highlight: "a better first impression.",
  description:
    "Thoughtful packaging for the things you make. Find your everyday essentials, and make every dispatch feel like your business.",
  features: Object.freeze([
    "Boxes, mailers & labels, all together",
    "Find the right fit for your products",
    "Wholesale pack quantities for growing businesses",
  ]),
  primaryLabel: "Find your essentials",
  primaryHref: "/categories",
  secondaryLabel: "Shop packaging",
  secondaryHref: "/#catalog",
  image: "/images/margyn-custom-packaging.png",
  imageAlt: "Margyn branded kraft boxes, mailers, white pouch and packing tape",
  backgroundColor: "#073f37",
  textColor: "#f8fcfa",
  accentColor: "#6dd3b4",
  badgeTitle: "The finishing touch",
  badgeText: "For what you make. And what comes next.",
  updatedAt: 0,
});

export function validatePromoBanner(input) {
  if (typeof input.enabled !== "boolean")
    throw new AppError("Choose whether the promotional banner is visible.");
  if (!Array.isArray(input.features) || input.features.length > 3)
    throw new AppError("Use up to three banner highlights.");
  const banner = {
    enabled: input.enabled,
    eyebrow: text(input.eyebrow, "Banner label", 60, 0),
    title: text(input.title, "Banner title", 100),
    highlight: text(input.highlight, "Highlighted title", 100, 0),
    description: text(input.description, "Banner description", 600, 0),
    features: input.features.map((value) =>
      text(value, "Banner highlight", 100),
    ),
    primaryLabel: text(input.primaryLabel, "Primary button label", 40),
    primaryHref: text(input.primaryHref, "Primary button link", 500),
    secondaryLabel: text(input.secondaryLabel, "Secondary button label", 40, 0),
    secondaryHref: text(input.secondaryHref, "Secondary button link", 500, 0),
    image: text(input.image, "Banner image", 1000),
    imageAlt: text(input.imageAlt, "Image description", 180),
    backgroundColor: input.backgroundColor,
    textColor: input.textColor,
    accentColor: input.accentColor,
    badgeTitle: text(input.badgeTitle, "Image badge title", 40, 0),
    badgeText: text(input.badgeText, "Image badge description", 120, 0),
  };
  if (![banner.primaryHref, banner.secondaryHref].every(validAnnouncementLink))
    throw new AppError(
      "Use local paths starting with / or full HTTPS links for banner buttons.",
    );
  if (Boolean(banner.secondaryLabel) !== Boolean(banner.secondaryHref))
    throw new AppError(
      "Add both a label and a link for the secondary button, or leave both empty.",
    );
  if (
    banner.image !== DEFAULT_PROMO_BANNER.image &&
    !imageAllowed(banner.image)
  )
    throw new AppError(
      "Use the default artwork or an image uploaded through ImageKit.",
    );
  for (const key of ["backgroundColor", "textColor", "accentColor"]) {
    if (typeof banner[key] !== "string" || !/^#[a-f0-9]{6}$/i.test(banner[key]))
      throw new AppError("Choose valid banner colors.");
    banner[key] = banner[key].toLowerCase();
  }
  return banner;
}

export async function getPromoBanner() {
  const row = await (
    await getDb()
  )
    .collection("site_settings")
    .findOne({ _id: "promo-banner" });
  const record = { ...DEFAULT_PROMO_BANNER, ...row };
  return Object.fromEntries(
    Object.keys(DEFAULT_PROMO_BANNER).map((key) => [key, record[key]]),
  );
}

export async function savePromoBanner(input, userId) {
  const settings = validatePromoBanner(input);
  await (
    await getDb()
  )
    .collection("site_settings")
    .updateOne(
      { _id: "promo-banner" },
      { $set: { ...settings, updatedAt: Date.now(), updatedBy: userId } },
      { upsert: true },
    );
  return getPromoBanner();
}
