import { Router } from "express";
import { z } from "zod";
import { ResourceNotFoundError } from "./errors.js";
import { CHANNELS } from "../notifications/queues.js";
import type { TemplateRepository } from "../notifications/templates.js";

export const templateName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "name must be lowercase letters, digits, - or _");
const channel = z.enum(CHANNELS);

const key = z.object({ name: templateName, channel });
const body = z.object({
  subject: z.string().min(1).max(200).optional(),
  body: z.string().min(1).max(10_000),
});

export function templateRoutes(templates: TemplateRepository): Router {
  const router = Router();

  router.put("/v1/templates/:name/:channel", async (req, res) => {
    const { name, channel } = key.parse(req.params);
    const saved = await templates.upsert({ name, channel, ...body.parse(req.body) });
    res.status(200).json(saved);
  });

  router.get("/v1/templates/:name/:channel", async (req, res) => {
    const { name, channel } = key.parse(req.params);
    const found = await templates.find(name, channel);
    if (!found) throw new ResourceNotFoundError(`template "${name}" has no ${channel} version`);
    res.json(found);
  });

  return router;
}
