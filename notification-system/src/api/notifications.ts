import { Router } from "express";
import { z } from "zod";
import { CHANNELS } from "../notifications/queues.js";
import type { Client } from "../clients/credentials.js";
import { templateName } from "./templates.js";
import {
  type Content,
  type NotificationService,
} from "../notifications/service.js";

const MAX_SCHEDULE_AHEAD_DAYS = 30;
const MAX_SCHEDULE_AHEAD_MS = MAX_SCHEDULE_AHEAD_DAYS * 24 * 60 * 60 * 1000;

const params = z
  .record(
    z.string().regex(/^[A-Za-z0-9_]{1,64}$/),
    z.union([z.string().max(1000), z.number(), z.boolean()]),
  )
  .refine((p) => Object.keys(p).length <= 50, { message: "at most 50 params" });

const sendBody = z
  .object({
    userId: z.string().regex(/^\d+$/, "userId must be a number"),
    channel: z.enum(CHANNELS),
    subject: z.string().min(1).max(200).optional(),
    body: z.string().min(1).max(10_000).optional(),
    template: templateName.optional(),
    params: params.optional(),
    sendAt: z.iso.datetime({ offset: true }).optional(),
  })
  .superRefine((b, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if (b.template === undefined && b.body === undefined) issue("provide either body or template");
    if (b.template !== undefined && (b.body !== undefined || b.subject !== undefined)) {
      issue("with a template, subject and body come from the template");
    }
    if (b.template === undefined && b.params !== undefined) issue("params only make sense with a template");
    if (b.sendAt !== undefined && Date.parse(b.sendAt) > Date.now() + MAX_SCHEDULE_AHEAD_MS) {
      issue(`sendAt must be within ${MAX_SCHEDULE_AHEAD_DAYS} days from now`);
    }
  });

const idempotencyKey = z.string().min(1).max(255).optional();

export function notificationRoutes(service: NotificationService): Router {
  const router = Router();

  router.post("/v1/notifications", async (req, res) => {
    const input = sendBody.parse(req.body);
    const { userId, channel } = input;
    const content: Content =
      input.template === undefined
        ? { kind: "text", subject: input.subject, body: input.body! }
        : { kind: "template", name: input.template, params: input.params ?? {} };
    const key = idempotencyKey.parse(req.get("Idempotency-Key"));
    const { requestId, notifications, replayed } = await service.send(
      {
        clientId: (res.locals.client as Client).id,
        userId,
        channel,
        content,
        sendAt: input.sendAt === undefined ? undefined : new Date(input.sendAt),
      },
      key,
    );
    if (replayed) res.set("Idempotent-Replayed", "true");
    res.status(202).json({
      requestId,
      notifications: notifications.map((n) => ({
        id: n.id,
        channel: n.channel,
        platform: n.platform,
        status: n.status,
        sendAt: n.sendAt,
      })),
    });
  });

  return router;
}
