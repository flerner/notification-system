import amqp from "amqplib";
import type { Logger } from "pino";
import { z } from "zod";
import type { ProcessResult } from "../notifications/processor.js";

export interface MessageProcessor {
  process(notificationId: string, queue: string): Promise<ProcessResult>;
}

export interface WorkerOptions {
  url: string;
  queues: readonly string[];
  prefetch: number;
  requeueDelayMs: number;
  circuitOpenDelayMs: number;
}

export interface RunningWorker {
  stop(): Promise<void>;
  lost: Promise<void>;
}

const messageSchema = z.object({ notificationId: z.string().uuid() });

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
      if (!msg) return;
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
