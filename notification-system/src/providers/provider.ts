import type { Payload } from "../notifications/repository.js";

export interface DeliveryRequest {
  notificationId: string;
  // Stable across retries of the same notification (we use the notification id). Providers that
  // support an idempotency / dedupe key use it to ignore a repeated send. This narrows the
  // "sent but we crashed before recording it" window; it cannot close it for providers that
  // have no such key.
  idempotencyKey: string;
  destination: string; // email address, phone number or device token
  payload: Payload;
}

// What a provider throws when it cannot deliver. `retryable` tells the worker what to do next:
//  - true:  the problem is probably temporary (timeout, 5xx, rate limit, network): try again later.
//  - false: retrying can never help (invalid device token, malformed address): give up now.
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

// One implementation per third-party service (APNS, FCM, Twilio, SendGrid, ...). Workers only
// know this interface, so a provider can be swapped or unplugged without touching them (book:
// FCM is unavailable in China, so another push service is used there). send() resolves when
// the provider accepted the message and throws a ProviderError when it did not.
export interface ChannelProvider {
  readonly name: string;
  send(req: DeliveryRequest): Promise<void>;
}
