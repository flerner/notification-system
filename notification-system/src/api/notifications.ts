import { Router } from "express";
import { z } from "zod";
import { TemplateNotFoundError, TemplateParamError } from "../notifications/templates.js";
import { templateName } from "./templates.js";
import {
  IdempotencyKeyReuseError,
  NoDestinationError,
  UnknownUserError,
  type Content,
  type NotificationService,
} from "../notifications/service.js";

const params = z
  .record(
    z.string().regex(/^[A-Za-z0-9_]{1,64}$/),
    z.union([z.string().max(1000), z.number(), z.boolean()]),
  )
  .refine((p) => Object.keys(p).length <= 50, { message: "at most 50 params" });

// Either ready-made text (`body`, optional `subject`) or a `template` with its `params`.
const sendBody = z
  .object({
    userId: z.string().regex(/^\d+$/, "userId must be a number"),
    channel: z.enum(["push", "sms", "email"]),
    subject: z.string().min(1).max(200).optional(),
    body: z.string().min(1).max(10_000).optional(),
    template: templateName.optional(),
    params: params.optional(),
  })
  .superRefine((b, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if (b.template === undefined && b.body === undefined) issue("provide either body or template");
    if (b.template !== undefined && (b.body !== undefined || b.subject !== undefined)) {
      issue("with a template, subject and body come from the template");
    }
    if (b.template === undefined && b.params !== undefined) issue("params only make sense with a template");
  });

// Chosen by the caller, one per logical notification request (e.g. an event id). Retrying the
// request with the same key is safe.
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
    try {
      const { requestId, notifications, replayed } = await service.send({ userId, channel, content }, key);
      if (replayed) res.set("Idempotent-Replayed", "true");
      // 202, not 201: the notification is stored and queued, not delivered yet.
      res.status(202).json({
        requestId,
        notifications: notifications.map((n) => ({ id: n.id, channel: n.channel, platform: n.platform, status: n.status })),
      });
    } catch (err) {
      if (err instanceof UnknownUserError) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (err instanceof IdempotencyKeyReuseError) {
        res.status(422).json({ error: err.message });
        return;
      }
      if (err instanceof TemplateNotFoundError || err instanceof TemplateParamError) {
        res.status(422).json({ error: err.message });
        return;
      }
      if (err instanceof NoDestinationError) {
        res.status(422).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  return router;
}
