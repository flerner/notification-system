import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ClientRepository } from "./repository.js";

export interface Client {
  id: string;
  name: string;
}

// Only this hash is stored, never the secret. A fast hash is right here: our secrets are 256 random
// bits, so there is nothing to guess and no need for the deliberately slow hashing (bcrypt, argon2)
// that protects weak, human-chosen passwords.
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function generateCredentials(): { appKey: string; secret: string } {
  return {
    appKey: `ak_${randomBytes(12).toString("hex")}`,
    secret: `sk_${randomBytes(32).toString("base64url")}`,
  };
}

// Compared when the key does not exist, so that an unknown key and a wrong secret take the same
// amount of work and cannot be told apart by timing.
const NO_CLIENT_HASH = hashSecret("no such client");

export async function authenticate(clients: ClientRepository, appKey: string, secret: string): Promise<Client | null> {
  const record = await clients.findByKey(appKey);
  const expected = Buffer.from(record?.secretHash ?? NO_CLIENT_HASH, "hex");
  const given = Buffer.from(hashSecret(secret), "hex");
  const matches = given.length === expected.length && timingSafeEqual(given, expected);
  if (!record || !matches || record.revokedAt !== null) return null;
  return { id: record.appKey, name: record.name };
}
