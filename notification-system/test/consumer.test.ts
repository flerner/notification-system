import amqp from "amqplib";
import { afterEach, describe, expect, it } from "vitest";
import { RabbitPublisher } from "../src/infra/rabbit.js";
import { startWorker, type MessageProcessor, type RunningWorker } from "../src/worker/consumer.js";
import { silentLogger } from "./fakes.js";

// Integration test against a real RabbitMQ. Skipped unless TEST_RABBITMQ_URL is set, e.g.:
//   TEST_RABBITMQ_URL=amqp://notif:notif@localhost:5672 npm test
const url = process.env.TEST_RABBITMQ_URL;

const ID = "7b1f0f0e-8b8e-4b52-9a57-0f3f5a9d2c11";
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe.skipIf(!url)("worker consumer (real RabbitMQ)", () => {
  let queue: string;
  let publisher: RabbitPublisher;
  let worker: RunningWorker | undefined;
  const cleanup: (() => Promise<void>)[] = [];

  async function setup(processor: MessageProcessor, deadLetter: (m: object) => Promise<void> = async () => {}) {
    queue = `test.worker.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    publisher = new RabbitPublisher(url!, [{ name: queue }], silentLogger);
    await publisher.check(); // declares the queue
    worker = await startWorker(
      { url: url!, queues: [queue], prefetch: 2, requeueDelayMs: 20, circuitOpenDelayMs: 20 },
      processor,
      silentLogger,
      deadLetter,
    );
    cleanup.push(async () => {
      const conn = await amqp.connect(url!);
      const ch = await conn.createChannel();
      await ch.deleteQueue(queue);
      await conn.close();
      await publisher.close();
    });
  }
  afterEach(async () => {
    await worker?.stop();
    worker = undefined;
    for (const c of cleanup.splice(0)) await c();
  });

  it("passes the notification id to the processor and acks the message", async () => {
    const seen: string[] = [];
    await setup({
      process: async (id) => {
        seen.push(id);
        return "done";
      },
    });
    await publisher.publish(queue, { notificationId: ID });
    await until(() => seen.length === 1);
    expect(seen).toEqual([ID]);
  });

  it("redelivers a message when processing throws, until it succeeds (at-least-once)", async () => {
    let attempts = 0;
    await setup({
      process: async () => {
        if (++attempts < 3) throw new Error("database down");
        return "done";
      },
    });
    await publisher.publish(queue, { notificationId: ID });
    await until(() => attempts === 3);
  });

  it("sends a malformed message to the dead-letter queue, without calling the processor or looping", async () => {
    let calls = 0;
    const dead: object[] = [];
    await setup(
      {
        process: async () => {
          calls++;
          return "done";
        },
      },
      async (m) => void dead.push(m),
    );
    await publisher.publish(queue, { nonsense: true });
    await publisher.publish(queue, { notificationId: ID }); // proves the worker kept going
    await until(() => calls === 1);
    await new Promise((r) => setTimeout(r, 150));
    expect(calls).toBe(1);
    expect(dead).toEqual([{ reason: "malformed", queue, payload: JSON.stringify({ nonsense: true }) }]);
  });

  it("keeps a malformed message on the queue until it could be dead-lettered", async () => {
    let attempts = 0;
    const dead: object[] = [];
    await setup({ process: async () => "done" }, async (m) => {
      if (++attempts < 3) throw new Error("dead-letter queue unreachable");
      dead.push(m);
    });
    await publisher.publish(queue, { nonsense: true });
    await until(() => dead.length === 1);
    expect(attempts).toBe(3); // it was put back twice, never lost
  });

  it("tells the processor which queue the message came from, and puts it back while the circuit is open", async () => {
    const seen: string[] = [];
    await setup({
      process: async (_id, q) => {
        seen.push(q);
        return seen.length < 3 ? "circuit_open" : "done";
      },
    });
    await publisher.publish(queue, { notificationId: ID });
    await until(() => seen.length === 3);
    expect(seen).toEqual([queue, queue, queue]);
  });

  it("puts a message back while the notification is busy, and acks it once it is done", async () => {
    let calls = 0;
    await setup({ process: async () => (++calls < 3 ? "busy" : "done") });
    await publisher.publish(queue, { notificationId: ID });
    await until(() => calls === 3);
    await new Promise((r) => setTimeout(r, 150));
    expect(calls).toBe(3); // acked on the third call: no further redelivery
  });

  it("stop() waits for the message in progress to finish", async () => {
    let finished = false;
    await setup({
      process: async () => {
        await new Promise((r) => setTimeout(r, 200));
        finished = true;
        return "done";
      },
    });
    await publisher.publish(queue, { notificationId: ID });
    await new Promise((r) => setTimeout(r, 50)); // message is now being processed
    await worker!.stop();
    worker = undefined;
    expect(finished).toBe(true);
  });
});
