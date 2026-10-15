import type { Payload } from "../notifications/repository.js";

export interface DeliveryRequest {
  notificationId: string;
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
