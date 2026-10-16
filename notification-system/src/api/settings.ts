import { Router } from "express";
import { z } from "zod";
import { CHANNELS } from "../notifications/queues.js";
import type { SettingsRepository } from "../notifications/settings.js";

const userId = z.string().regex(/^\d+$/, "id must be a number");
const channel = z.enum(CHANNELS);

export function settingsRoutes(settings: SettingsRepository): Router {
  const router = Router();

  router.put("/users/:id/settings/:channel", async (req, res) => {
    const params = z.object({ id: userId, channel }).parse(req.params);
    const { optIn } = z.object({ optIn: z.boolean() }).parse(req.body);
    await settings.setOptIn(params.id, params.channel, optIn);
    res.json({ userId: params.id, channel: params.channel, optIn });
  });

  router.get("/users/:id/settings", async (req, res) => {
    const { id } = z.object({ id: userId }).parse(req.params);
    res.json({ userId: id, ...(await settings.list(id)) });
  });

  return router;
}
