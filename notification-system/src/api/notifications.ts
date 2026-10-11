import { Router } from "express";
import { z } from "zod";
import {
  IdempotencyKeyReuseError,
  NoDestinationError,
  UnknownUserError,
  type NotificationService,
} from "../notifications/service.js";

const sendBody = z.object({
  userId: z.string().regex(/^\d+$/, "userId must be a number"),
  channel: z.enum(["push", "sms", "email"]),
  subject: z.string().min(1).max(200).optional(),
  body: z.string().min(1).max(10_000),
});

// Chosen by the caller, one per logical notification request (e.g. an event id). Retrying the
// request with the same key is safe.
const idempotencyKey = z.string().min(1).max(255).optional();

export function notificationRoutes(service: NotificationService): Router {
  const router = Router();

  router.post("/v1/notifications", async (req, res) => {
    const { userId, channel, subject, body } = sendBody.parse(req.body);
    const key = idempotencyKey.parse(req.get("Idempotency-Key"));
    try {
      const { requestId, notifications, replayed } = await service.send({ userId, channel, payload: { subject, body } }, key);
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
      if (err instanceof NoDestinationError) {
        res.status(422).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  return router;
}
