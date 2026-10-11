import amqp from "amqplib";
import type { Logger } from "pino";
import { z } from "zod";

// What the consumer needs from the business logic.
export interface MessageProcessor {
  // "busy" means another worker holds the notification: the message is put back and retried.
  process(notificationId: string): Promise<"done" | "busy">;
}

export interface WorkerOptions {
  url: string;
  queues: readonly string[];
  // Max unacknowledged messages per queue. This is the backpressure knob: the broker will not
  // hand this worker more than N messages at once, so a slow provider cannot flood it.
  prefetch: number;
  // Pause before putting a message back after an infrastructure error, so a down database
  // does not turn into a tight redelivery loop.
  requeueDelayMs: number;
}

export interface RunningWorker {
  // Stop taking messages, wait for the ones in progress, close the connection.
  stop(): Promise<void>;
  // Resolves if the broker connection is lost without us calling stop().
  lost: Promise<void>;
}

const messageSchema = z.object({ notificationId: z.string().uuid() });

export async function startWorker(opts: WorkerOptions, processor: MessageProcessor, log: Logger): Promise<RunningWorker> {
  const connection = await amqp.connect(opts.url, { timeout: 3000 });
  const channel = await connection.createChannel();
  await channel.prefetch(opts.prefetch);

  let stopping = false;
  const inFlight = new Set<Promise<void>>();
  const lost = new Promise<void>((resolve) => {
    connection.on("close", () => !stopping && resolve());
  });
  connection.on("error", (err) => log.error({ err }, "rabbitmq connection error"));

  const consumerTags: string[] = [];
  for (const queue of opts.queues) {
    await channel.assertQueue(queue, { durable: true });
    const { consumerTag } = await channel.consume(queue, (msg) => {
      if (!msg) return; // the broker cancelled this consumer
      const work = handle(msg).finally(() => inFlight.delete(work));
      inFlight.add(work);
    });
    consumerTags.push(consumerTag);
  }

  // Ack only AFTER the work is done. If we crash before that, the broker redelivers the message:
  // at-least-once delivery, which is why processing must become idempotent (M5).
  async function handle(msg: amqp.ConsumeMessage): Promise<void> {
    let notificationId: string;
    try {
      notificationId = messageSchema.parse(JSON.parse(msg.content.toString())).notificationId;
    } catch (err) {
      // A message we cannot understand will never become valid, so retrying is pointless.
      // (M6 sends these to a dead-letter queue instead of discarding them.)
      log.error({ err, queue: msg.fields.routingKey }, "malformed message, discarding");
      channel.nack(msg, false, false);
      return;
    }
    try {
      const result = await processor.process(notificationId);
      if (result === "busy") {
        // Do NOT ack: if the worker holding it crashed, this message is the only thing that will
        // make us notice once its lease expires. Until then we keep putting it back.
        log.debug({ notificationId }, "notification busy, will check again");
        await requeueAfterDelay(msg);
        return;
      }
      channel.ack(msg);
    } catch (err) {
      log.error({ err, notificationId }, "processing failed, will retry");
      await requeueAfterDelay(msg);
    }
  }

  async function requeueAfterDelay(msg: amqp.ConsumeMessage): Promise<void> {
    await new Promise((r) => setTimeout(r, opts.requeueDelayMs));
    if (!stopping) channel.nack(msg, false, true);
  }

  return {
    lost,
    async stop() {
      stopping = true;
      await Promise.all(consumerTags.map((t) => channel.cancel(t)));
      await Promise.allSettled([...inFlight]);
      await connection.close();
    },
  };
}
