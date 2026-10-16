import type { RequestHandler } from "express";
import { authenticate } from "../clients/credentials.js";
import type { ClientRepository } from "../clients/repository.js";

function parseBasic(header: string | undefined): { appKey: string; secret: string } | null {
  if (!header || header.length > 1024) return null;
  const [scheme, encoded] = header.split(" ");
  if (scheme?.toLowerCase() !== "basic" || !encoded) return null;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon <= 0) return null;
  return { appKey: decoded.slice(0, colon), secret: decoded.slice(colon + 1) };
}

// Every failure gets the same answer, whether the header was missing, malformed, the key unknown, the secret wrong or the client
// revoked, so a caller cannot use it to find out which keys exist. On success the client is put on
// `res.locals.client` for the routes. Basic auth sends the secret with every request, so in
// production the API must only be reachable over HTTPS.
export function requireClient(clients: ClientRepository): RequestHandler {
  return async (req, res, next) => {
    const credentials = parseBasic(req.get("Authorization"));
    const client = credentials && (await authenticate(clients, credentials.appKey, credentials.secret));
    if (!client) {
      res.set("WWW-Authenticate", 'Basic realm="notification-system"').status(401).json({ error: "invalid credentials" });
      return;
    }
    res.locals.client = client;
    next();
  };
}
