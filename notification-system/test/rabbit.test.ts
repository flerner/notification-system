import amqp from "amqplib";
import { describe, expect, it } from "vitest";
import { RabbitPublisher } from "../src/infra/rabbit.js";
import { silentLogger } from "./fakes.js";

// Integration test against a real RabbitMQ. Skipped unless TEST_RABBITMQ_URL is set, e.g.:
//   npm run test:integration
const url = process.env.TEST_RABBITMQ_URL;

describe.skipIf(!url)("RabbitPublisher (real RabbitMQ)", () => {
  it("delivers a confirmed message to its queue", async () => {
    const queue = `test.${Date.now()}`; // unique, so reruns never see old messages
    const publisher = new RabbitPublisher(url!, [{ name: queue }], silentLogger);
    const conn = await amqp.connect(url!);
    const ch = await conn.createChannel();
    try {
      await publisher.publish(queue, { notificationId: "abc" });
      const msg = await ch.get(queue, { noAck: true });
      expect(msg && JSON.parse(msg.content.toString())).toEqual({ notificationId: "abc" });
    } finally {
      await ch.deleteQueue(queue);
      await conn.close();
      await publisher.close();
    }
  });

  it("fails fast instead of hanging when the broker is unreachable", async () => {
    const publisher = new RabbitPublisher("amqp://notif:notif@localhost:1", [{ name: "q" }], silentLogger);
    await expect(publisher.publish("q", {})).rejects.toThrow();
  });

  it("hands a message from a retry queue back to its main queue once the delay has passed", async () => {
    const main = `test.retry.${Date.now()}`;
    const retry = `${main}.retry.300`;
    const publisher = new RabbitPublisher(
      url!,
      [
        { name: main },
        { name: retry, args: { "x-message-ttl": 300, "x-dead-letter-exchange": "", "x-dead-letter-routing-key": main } },
      ],
      silentLogger,
    );
    const conn = await amqp.connect(url!);
    const ch = await conn.createChannel();
    try {
      await publisher.publish(retry, { notificationId: "abc" });
      expect(await ch.get(main, { noAck: true })).toBe(false); // not yet: it is waiting out the delay

      let msg: Awaited<ReturnType<typeof ch.get>> = false;
      const end = Date.now() + 3000;
      while (!msg && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 50));
        msg = await ch.get(main, { noAck: true });
      }
      expect(msg && JSON.parse(msg.content.toString())).toEqual({ notificationId: "abc" });
    } finally {
      await ch.deleteQueue(retry);
      await ch.deleteQueue(main);
      await conn.close();
      await publisher.close();
    }
  });
});
