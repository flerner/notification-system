import { Router } from "express";
import { z } from "zod";
import type { SettingsRepository } from "../notifications/settings.js";
import { UserNotFoundError } from "../users/repository.js";

const userId = z.string().regex(/^\d+$/, "id must be a number");
const channel = z.enum(["push", "sms", "email"]);

export function settingsRoutes(settings: SettingsRepository): Router {
  const router = Router();

  router.put("/users/:id/settings/:channel", async (req, res) => {
    const params = z.object({ id: userId, channel }).parse(req.params);
    const { optIn } = z.object({ optIn: z.boolean() }).parse(req.body);
    try {
      await settings.setOptIn(params.id, params.channel, optIn);
    } catch (err) {
      if (err instanceof UserNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      throw err;
    }
    res.json({ userId: params.id, channel: params.channel, optIn });
  });

  router.get("/users/:id/settings", async (req, res) => {
    const { id } = z.object({ id: userId }).parse(req.params);
    const all = await settings.list(id);
    if (!all) {
      res.status(404).json({ error: `user ${id} not found` });
      return;
    }
    res.json({ userId: id, ...all });
  });

  return router;
}
