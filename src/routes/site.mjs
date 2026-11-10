import { Router } from "express";
import { getAnnouncement } from "../services/announcement.mjs";
import { getPromoBanner } from "../services/promo-banner.mjs";
export const siteRoutes = Router();
siteRoutes.get("/announcement", async (_req, res) => {
  const announcement = await getAnnouncement();
  res.json({ announcement: announcement.enabled ? announcement : null });
});

siteRoutes.get("/promo-banner", async (_req, res) => {
  const banner = await getPromoBanner();
  res.json({ banner: banner.enabled ? banner : null });
});
