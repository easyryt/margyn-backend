import { Router } from "express";
import {
  listIndianStates,
  listIndianCities,
  LOCATION_ATTRIBUTION,
} from "../services/locations.mjs";
export const locationRoutes = Router();
locationRoutes.get("/states", async (_req, res) => {
  const states = await listIndianStates();
  res.set("Cache-Control", "public, max-age=86400");
  res.json({ states, attribution: LOCATION_ATTRIBUTION });
});
locationRoutes.get("/cities", async (req, res) => {
  const cities = await listIndianCities(req.query.state);
  res.set("Cache-Control", "public, max-age=86400");
  res.json({ cities, attribution: LOCATION_ATTRIBUTION });
});
