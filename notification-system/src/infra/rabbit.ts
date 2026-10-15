import amqp, { type ChannelModel, type ConfirmChannel } from "amqplib";
import type { Logger } from "pino";
import type { QueueSpec } from "../notifications/queues.js";
import { withTimeout } from "./timeout.js";

export interface MessagePublisher {
  publish(queue: string, message: object): Promise<void>;
}

const PUBLISH_TIMEOUT_MS = 5000;

export class RabbitPublisher implements MessagePublisher {
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;
  private opening?: Promise<ConfirmChannel>;

  constructor(
    private readonly url: string,
    private readonly queues: readonly QueueSpec[],
    private readonly log: Logger,
  ) {}

  async publish(queue: string, message: object): Promise<void> {
    const channel = await this.getChannel();
    const sent = new Promise<void>((resolve, reject) => {
      channel.sendToQueue(queue, Buffer.from(JSON.stringify(message)), { persistent: true, contentType: "application/json" }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
    await withTimeout(sent, PUBLISH_TIMEOUT_MS);
  }

  async check(): Promise<void> {
    await this.getChannel();
  }

  async close(): Promise<void> {
    await this.opening?.catch(() => {});
    await this.connection?.close().catch(() => {});
  }

  private getChannel(): Promise<ConfirmChannel> {
    if (this.channel) return Promise.resolve(this.channel);
    this.opening ??= this.open().finally(() => (this.opening = undefined));
    return this.opening;
  }

  private async open(): Promise<ConfirmChannel> {
    const connection = await amqp.connect(this.url, { timeout: 3000 });
    const channel = await connection.createConfirmChannel();
    for (const q of this.queues) await channel.assertQueue(q.name, { durable: true, arguments: q.args });

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
