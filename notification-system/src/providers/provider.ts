import type { Payload } from "../notifications/repository.js";

export interface DeliveryRequest {
  notificationId: string;
  // Stable across retries of the same notification (we use the notification id). Providers that
  // support an idempotency / dedupe key use it to ignore a repeated send. This narrows the
  // "sent but we crashed before recording it" window; it cannot close it for providers that
  // have no such key.
  idempotencyKey: string;
  destination: string;
  payload: Payload;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface ChannelProvider {
  readonly name: string;
  send(req: DeliveryRequest): Promise<void>;
}
