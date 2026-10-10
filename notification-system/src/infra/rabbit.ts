import amqp, { type ChannelModel, type ConfirmChannel } from "amqplib";
import type { Logger } from "pino";
import { withTimeout } from "./timeout.js";

// What the rest of the code depends on, so tests can swap in a fake broker.
export interface MessagePublisher {
  // Resolves only once the broker has confirmed it stored the message.
  publish(queue: string, message: object): Promise<void>;
}

const PUBLISH_TIMEOUT_MS = 5000;

// One long-lived connection and channel, opened lazily and reopened after a failure. The
// channel is a "confirm channel": the broker acknowledges each message, so a resolved publish
// means the message is on disk, not just handed to the network.
export class RabbitPublisher implements MessagePublisher {
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;
  private opening?: Promise<ConfirmChannel>;

  constructor(
    private readonly url: string,
    private readonly queues: readonly string[],
    private readonly log: Logger,
  ) {}

  async publish(queue: string, message: object): Promise<void> {
    const channel = await this.getChannel();
    const sent = new Promise<void>((resolve, reject) => {
      channel.sendToQueue(queue, Buffer.from(JSON.stringify(message)), { persistent: true, contentType: "application/json" }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
    // Without a timeout a stalled broker would hang the API request forever.
    await withTimeout(sent, PUBLISH_TIMEOUT_MS);
  }

  // Used by /health: succeeds if we can reach the broker (opening the channel if needed).
  async check(): Promise<void> {
    await this.getChannel();
  }

  async close(): Promise<void> {
    await this.opening?.catch(() => {}); // let an attempt in progress finish first
    await this.connection?.close().catch(() => {});
  }

  private getChannel(): Promise<ConfirmChannel> {
    if (this.channel) return Promise.resolve(this.channel);
    // Concurrent callers share one connection attempt instead of opening several.
    this.opening ??= this.open().finally(() => (this.opening = undefined));
    return this.opening;
  }

  private async open(): Promise<ConfirmChannel> {
    const connection = await amqp.connect(this.url, { timeout: 3000 });
    const channel = await connection.createConfirmChannel();
    // Queues are durable so they survive a broker restart. Declaring is idempotent.
    for (const q of this.queues) await channel.assertQueue(q, { durable: true });

    // After any failure drop the cached channel: the next publish reconnects. An 'error'
    // event with no listener would crash the process, so we always listen.
    const reset = (err?: unknown) => {
      if (this.channel === channel) this.channel = undefined;
      if (err) this.log.warn({ err }, "rabbitmq connection problem, will reconnect on next use");
    };
    connection.on("error", reset);
    connection.on("close", () => reset());
    channel.on("error", reset);

    this.connection = connection;
    this.channel = channel;
    return channel;
  }
}
