import { describe, expect, it, vi } from "vitest";
import type { Queue } from "bullmq";
import { createBullMqSupportPublisher } from "../../src/modules/support/support-outbox.js";

describe("BullMQ support bridge", () => {
  it("uses stable colon-free IDs and retains completed jobs for retry deduplication", async () => {
    const add = vi.fn(async () => ({}));
    const publish = createBullMqSupportPublisher({ add } as unknown as Pick<Queue, "add">);
    const delivery = { eventId: "support:session_1:1", sessionId: "session_1" };
    await publish(delivery);
    await publish(delivery);
    expect(add.mock.calls[0]).toEqual(add.mock.calls[1]);
    expect(add).toHaveBeenCalledWith("support.reconcile", delivery, expect.objectContaining({
      jobId: expect.stringMatching(/^support-[a-f0-9]{64}$/), attempts: 8,
      removeOnComplete: false, removeOnFail: false,
    }));
  });
  it("propagates enqueue failures so the durable outbox remains retryable", async () => {
    const add = vi.fn(async () => { throw new Error("redis unavailable"); });
    const publish = createBullMqSupportPublisher({ add } as unknown as Pick<Queue, "add">);
    await expect(publish({ eventId: "support:s:1", sessionId: "s" })).rejects.toThrow("redis unavailable");
  });
});
