import amqp from "amqplib";
import type { Logger } from "pino";
import { z } from "zod";

// What the consumer needs from the business logic.
export interface MessageProcessor {
  // "busy" (another worker holds the notification) and "circuit_open" (the provider is down) put
  // the message back and retry it after a pause.
  process(notificationId: string, queue: string): Promise<"done" | "busy" | "circuit_open">;
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
  // Longer pause while a provider's circuit is open: nothing can succeed before it closes.
  circuitOpenDelayMs: number;
}

export interface RunningWorker {
  // Stop taking messages, wait for the ones in progress, close the connection.
  stop(): Promise<void>;
  // Resolves if the broker connection is lost without us calling stop().
  lost: Promise<void>;
}

const messageSchema = z.object({ notificationId: z.string().uuid() });

// `deadLetter` receives messages we cannot process at all (they are acknowledged afterwards, so
// they are kept somewhere instead of being lost or retried forever).
export async function startWorker(
  opts: WorkerOptions,
  processor: MessageProcessor,
  log: Logger,
  deadLetter: (message: object) => Promise<void>,
): Promise<RunningWorker> {
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
      const work = handle(msg, queue).finally(() => inFlight.delete(work));
      inFlight.add(work);
    });
    consumerTags.push(consumerTag);
  }

  // Ack only AFTER the work is done. If we crash before that, the broker redelivers the message:
  // at-least-once delivery, which is why processing has to be idempotent (see the claim in processor.ts).
  async function handle(msg: amqp.ConsumeMessage, queue: string): Promise<void> {
    let notificationId: string;
    try {
      notificationId = messageSchema.parse(JSON.parse(msg.content.toString())).notificationId;
    } catch (err) {
      // A message we cannot understand will never become valid, so retrying is pointless. Keep it
      // on the dead-letter queue for a human to look at, and only then acknowledge it.
      log.error({ err, queue }, "malformed message, sending to the dead-letter queue");
      try {
        await deadLetter({ reason: "malformed", queue, payload: msg.content.toString().slice(0, 2000) });
        channel.ack(msg);
      } catch (dlqErr) {
        log.error({ err: dlqErr, queue }, "could not dead-letter a malformed message, will retry");
        await requeueAfterDelay(msg, opts.requeueDelayMs);
      }
      return;
    }
    try {
      const result = await processor.process(notificationId, queue);
      if (result === "busy") {
        // Do NOT ack: if the worker holding it crashed, this message is the only thing that will
        // make us notice once its lease expires. Until then we keep putting it back.
        log.debug({ notificationId }, "notification busy, will check again");
        await requeueAfterDelay(msg, opts.requeueDelayMs);
        return;
      }
      if (result === "circuit_open") {
        log.debug({ notificationId, queue }, "provider circuit open, will check again");
        await requeueAfterDelay(msg, opts.circuitOpenDelayMs);
        return;
      }
      channel.ack(msg);
    } catch (err) {
      log.error({ err, notificationId }, "processing failed, will retry");
      await requeueAfterDelay(msg, opts.requeueDelayMs);
    }
  }

  async function requeueAfterDelay(msg: amqp.ConsumeMessage, delayMs: number): Promise<void> {
    await new Promise((r) => setTimeout(r, delayMs));
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
