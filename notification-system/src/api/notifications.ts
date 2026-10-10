import { Router } from "express";
import { z } from "zod";
import { NoDestinationError, UnknownUserError, type NotificationService } from "../notifications/service.js";

const sendBody = z.object({
  userId: z.string().regex(/^\d+$/, "userId must be a number"),
  channel: z.enum(["push", "sms", "email"]),
  subject: z.string().min(1).max(200).optional(),
  body: z.string().min(1).max(10_000),
});

export function notificationRoutes(service: NotificationService): Router {
  const router = Router();

  router.post("/v1/notifications", async (req, res) => {
    const { userId, channel, subject, body } = sendBody.parse(req.body);
    try {
      const { requestId, notifications } = await service.send({ userId, channel, payload: { subject, body } });
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
      if (err instanceof NoDestinationError) {
        res.status(422).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  return router;
}
