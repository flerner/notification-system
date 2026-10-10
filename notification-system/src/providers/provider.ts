import type { Payload } from "../notifications/repository.js";

export interface DeliveryRequest {
  notificationId: string;
  destination: string; // email address, phone number or device token
  payload: Payload;
}

// One implementation per third-party service (APNS, FCM, Twilio, SendGrid, ...). Workers only
// know this interface, so a provider can be swapped or unplugged without touching them (book:
// FCM is unavailable in China, so another push service is used there). send() resolves when
// the provider accepted the message and throws when it did not.
export interface ChannelProvider {
  readonly name: string;
  send(req: DeliveryRequest): Promise<void>;
}
