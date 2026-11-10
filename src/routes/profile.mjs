import { Router } from "express";
import { requireUser } from "../middleware/session.mjs";
import { jsonInput } from "../middleware/http.mjs";
import {
  getProfile,
  saveProfileName,
  changeProfileAddress,
} from "../services/profile.mjs";
export const profileRoutes = Router();
profileRoutes.use(requireUser);
profileRoutes.get("/", async (req, res) =>
  res.json({ profile: await getProfile(req.user.id) }),
);
profileRoutes.patch("/", async (req, res) =>
  res.json({ profile: await saveProfileName(req.user.id, jsonInput(req)) }),
);
profileRoutes.post("/addresses", async (req, res) =>
  res
    .status(201)
    .json({
      profile: await changeProfileAddress(req.user.id, "add", jsonInput(req)),
    }),
);
profileRoutes.put("/addresses/:id", async (req, res) =>
  res.json({
    profile: await changeProfileAddress(
      req.user.id,
      "edit",
      jsonInput(req),
      req.params.id,
    ),
  }),
);
profileRoutes.delete("/addresses/:id", async (req, res) =>
  res.json({
    profile: await changeProfileAddress(
      req.user.id,
      "delete",
      {},
      req.params.id,
    ),
  }),
);
profileRoutes.patch("/addresses/:id/default", async (req, res) => {
  jsonInput(req);
  res.json({
    profile: await changeProfileAddress(
      req.user.id,
      "default",
      {},
      req.params.id,
    ),
  });
});
