// TR: CI gerçek Redis sağlar; yerelde yoksa açıkça skip edilir. EN: CI supplies real Redis; explicitly skip locally if absent.
import { randomUUID } from "node:crypto";
import { Queue, QueueEvents, Worker } from "bullmq";
import { describe, expect, it } from "vitest";
import { createBullMqSupportPublisher } from "../../src/modules/support/support-outbox.js";

describe.skipIf(!process.env.SUPPORT_TEST_REDIS_URL)("Redis delivery integration", () => {
  it("delivers and deduplicates retries across completed jobs", async () => {
    const url = new URL(process.env.SUPPORT_TEST_REDIS_URL!);
    if (!(["127.0.0.1", "localhost", "redis"].includes(url.hostname))) throw new Error("Only a local test Redis is allowed");
    const connection = { host: url.hostname, port: Number(url.port || 6379),
      ...(url.password ? { password: decodeURIComponent(url.password) } : {}) };
    const name = `kalkan-support-test-${randomUUID()}`;
    const queue = new Queue(name, { connection });
    const events = new QueueEvents(name, { connection });
    const received: unknown[] = [];
    const worker = new Worker(name, async (job) => { received.push(job.data); }, { connection, autorun: false });
    const errors: Error[] = [];
    queue.on("error", (error) => errors.push(error));
    events.on("error", (error) => errors.push(error));
    worker.on("error", (error) => errors.push(error));
    try {
      await events.waitUntilReady();
      const publish = createBullMqSupportPublisher(queue);
      const payload = { sessionId: "session_test", eventId: "support:session_test:1" };
      await Promise.all([publish(payload), publish(payload)]);
      const jobs = await queue.getJobs(["waiting"]);
      expect(jobs).toHaveLength(1);
      void worker.run().catch((error: Error) => errors.push(error));
      await jobs[0]!.waitUntilFinished(events, 10_000);
      await publish(payload);
      expect(received).toEqual([payload]);
      expect(await queue.getCompletedCount()).toBe(1);
      expect(await queue.getWaitingCount()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await worker.close();
      await events.close();
      // TR: Yalnızca bu testin rastgele adlı kuyruğu. EN: Only this test's unique queue is removed.
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});
