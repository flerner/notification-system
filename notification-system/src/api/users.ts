import { Router } from "express";
import { z } from "zod";
import { DuplicateContactError, UserNotFoundError, type UserRepository } from "../users/repository.js";

const phone = z.string().regex(/^\+[1-9]\d{1,14}$/, "phone must be in E.164 format, e.g. +14155550123");

const createUserBody = z
  .object({
    email: z.string().email().toLowerCase().optional(),
    phone: phone.optional(),
  })
  .refine((b) => b.email !== undefined || b.phone !== undefined, {
    message: "provide at least one of email or phone",
  });

const registerDeviceBody = z.object({
  platform: z.enum(["ios", "android", "web"]),
  token: z.string().min(1).max(4096),
});

const userIdParam = z.object({ id: z.string().regex(/^\d+$/, "id must be a number") });

export function userRoutes(users: UserRepository): Router {
  const router = Router();

  router.post("/users", async (req, res) => {
    const body = createUserBody.parse(req.body);
    try {
      res.status(201).json(await users.createUser(body));
    } catch (err) {
      if (err instanceof DuplicateContactError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  router.post("/users/:id/devices", async (req, res) => {
    const { id } = userIdParam.parse(req.params);
    const body = registerDeviceBody.parse(req.body);
    try {
      res.status(200).json(await users.registerDevice({ userId: id, ...body }));
    } catch (err) {
      if (err instanceof UserNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  return router;
}
