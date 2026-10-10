import amqp from "amqplib";
import { describe, expect, it } from "vitest";
import { RabbitPublisher } from "../src/infra/rabbit.js";
import { silentLogger } from "./fakes.js";

// Integration test against a real RabbitMQ. Skipped unless TEST_RABBITMQ_URL is set, e.g.:
//   TEST_RABBITMQ_URL=amqp://notif:notif@localhost:5672 npm test
const url = process.env.TEST_RABBITMQ_URL;

describe.skipIf(!url)("RabbitPublisher (real RabbitMQ)", () => {
  it("delivers a confirmed message to its queue", async () => {
    const queue = `test.${Date.now()}`; // unique, so reruns never see old messages
    const publisher = new RabbitPublisher(url!, [queue], silentLogger);
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
    const publisher = new RabbitPublisher("amqp://notif:notif@localhost:1", ["q"], silentLogger);
    await expect(publisher.publish("q", {})).rejects.toThrow();
  });
});
