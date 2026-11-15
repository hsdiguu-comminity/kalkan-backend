// TR: Test deposuyla mesaj sözleşmesi ve transaction sınırları.
// EN: Message contract and transaction boundaries against the test store.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createSupportMessageService } from "../../src/modules/support/message.service.js";
import { makeHandoffFixture } from "./helpers/handoff.fixture.js";

async function setup(active = true) {
  const f = makeHandoffFixture();
  const { session } = await f.service.requestHandoff(f.user, { conversationId: "chat_1" });
  if (active) {
    f.store.offer(session.id, f.expert.userId);
    await f.service.acceptSession(f.expert, session.id);
  }
  const input = { sessionId: session.id, clientMessageId: randomUUID(), text: "Merhaba" };
  return { ...f, session, input };
}

describe("Kalıcı destek mesajları / Persistent support messages", () => {
  it("stores masked text, server identity and a private keyed fingerprint", async () => {
    const f = await setup();
    const result = await f.messages.sendMessage(f.user, { ...f.input, text: "hello secret:123" });
    expect(result).toMatchObject({ created: true, message: {
      senderId: f.user.userId, senderRole: "user", sequence: 1, text: "hello [MASKED]",
    } });
    expect(JSON.stringify(f.store.messageSnapshot())).not.toContain("secret:123");
    expect(f.store.messageSnapshot()[0]?.contentFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.message).not.toHaveProperty("contentFingerprint");
    expect(await f.messages.listMessages(f.expert, f.session.id)).toEqual({
      items: [result.message], nextAfterSequence: 1, hasMore: false,
    });
  });

  it("deduplicates concurrent retries and normalizes UUID case", async () => {
    const f = await setup();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      f.messages.sendMessage(f.user, { ...f.input,
        clientMessageId: i % 2 ? f.input.clientMessageId.toUpperCase() : f.input.clientMessageId })));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.message.id)).size).toBe(1);
    expect(f.store.messageSnapshot()).toHaveLength(1);
    const expert = await f.messages.sendMessage(f.expert, f.input);
    expect(expert.message.sequence).toBe(2);
  });

  it("detects changed raw text even when both versions redact to the same text", async () => {
    const f = await setup();
    await f.messages.sendMessage(f.user, { ...f.input, text: "secret:one" });
    await expect(f.messages.sendMessage(f.user, { ...f.input, text: "secret:two" }))
      .rejects.toMatchObject({ code: "MESSAGE_ID_CONFLICT" });
    expect(f.store.messageSnapshot()).toHaveLength(1);
  });

  it("allows committed retries after closure but rejects new messages", async () => {
    const f = await setup();
    const sent = await f.messages.sendMessage(f.user, f.input);
    await f.service.closeSession(f.user, f.session.id);
    expect(await f.messages.sendMessage(f.user, f.input)).toEqual({ ...sent, created: false });
    await expect(f.messages.sendMessage(f.user, { ...f.input, clientMessageId: randomUUID() }))
      .rejects.toMatchObject({ code: "SESSION_CLOSED" });
    expect((await f.messages.listMessages(f.expert, f.session.id)).items).toHaveLength(1);
  });

  it("allows queued history but requires acceptance before sending", async () => {
    const f = await setup(false);
    expect((await f.messages.listMessages(f.user, f.session.id)).items).toEqual([]);
    await expect(f.messages.sendMessage(f.user, f.input)).rejects.toMatchObject({ code: "SESSION_NOT_ACTIVE" });
  });

  it.each(["otherUser", "expert2", "admin"] as const)("denies %s both reads and writes", async (name) => {
    const f = await setup();
    const code = name === "admin" ? "FORBIDDEN" : "NOT_FOUND";
    await expect(f.messages.sendMessage(f[name], f.input)).rejects.toMatchObject({ code });
    await expect(f.messages.listMessages(f[name], f.session.id)).rejects.toMatchObject({ code });
  });

  it.each([
    { text: " " }, { text: "\n\t" }, { text: "a".repeat(4001) },
    { clientMessageId: "not-uuid" }, { senderId: "expert_1" }, { sequence: 42 },
    { sessionId: "../other" }, { createdAt: "2026-01-01T00:00:00Z" },
  ])("rejects invalid or spoofed input %j", async (override) => {
    const f = await setup();
    await expect(f.messages.sendMessage(f.user, { ...f.input, ...override }))
      .rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    expect(f.store.messageSnapshot()).toEqual([]);
  });

  it("counts Unicode code points and preserves whitespace", async () => {
    const f = await setup();
    const text = "😀".repeat(4000);
    expect((await f.messages.sendMessage(f.user, { ...f.input, text })).message.text).toBe(text);
    await expect(f.messages.sendMessage(f.user, { ...f.input, text: text + "😀" }))
      .rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    const padded = await f.messages.sendMessage(f.user, { ...f.input, clientMessageId: randomUUID(), text: " hi " });
    expect(padded.message.text).toBe(" hi ");
  });

  it("rolls back sequence and record together when persistence fails", async () => {
    const f = await setup();
    f.store.failNextMessageWrite = true;
    await expect(f.messages.sendMessage(f.user, f.input)).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(f.store.messageSnapshot()).toEqual([]);
    expect((await f.messages.sendMessage(f.user, f.input)).message.sequence).toBe(1);
  });

  it.each(["close-first", "message-first"])("serializes closure with message writes: %s", async (order) => {
    const f = await setup();
    const send = () => f.messages.sendMessage(f.user, f.input);
    const close = () => f.service.closeSession(f.user, f.session.id);
    const results = await Promise.allSettled(order === "close-first" ? [close(), send()] : [send(), close()]);
    expect((await f.service.getSession(f.user, f.session.id)).status).toBe("closed");
    if (order === "close-first") {
      expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "SESSION_CLOSED" } });
      expect(f.store.messageSnapshot()).toHaveLength(0);
    } else {
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
      expect(f.store.messageSnapshot()).toHaveLength(1);
    }
  });

  it("paginates with an exclusive cursor and retains the cursor on an empty page", async () => {
    const f = await setup();
    for (let i = 0; i < 5; i++) await f.messages.sendMessage(f.user, { ...f.input, clientMessageId: randomUUID() });
    const first = await f.messages.listMessages(f.user, f.session.id, { limit: "2" });
    expect(first.items.map((m) => m.sequence)).toEqual([1, 2]);
    expect(first).toMatchObject({ nextAfterSequence: 2, hasMore: true });
    const second = await f.messages.listMessages(f.user, f.session.id, { afterSequence: "2", limit: "3" });
    expect(second.items.map((m) => m.sequence)).toEqual([3, 4, 5]);
    expect(second.hasMore).toBe(false);
    expect(await f.messages.listMessages(f.user, f.session.id, { afterSequence: 8 }))
      .toEqual({ items: [], nextAfterSequence: 8, hasMore: false });
  });

  it.each([{ limit: 0 }, { limit: 101 }, { limit: ["2"] }, { afterSequence: "1.5" },
    { afterSequence: "-1" }, { afterSequence: "9007199254740992" }, { unknown: true }])(
    "rejects invalid history cursor %j", async (query) => {
      const f = await setup();
      await expect(f.messages.listMessages(f.user, f.session.id, query))
        .rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    });

  it("fails closed on redaction failure and invalid redacted output", async () => {
    const f = await setup();
    for (const [redactText, code] of [
      [() => { throw new Error("private secret"); }, "SERVICE_UNAVAILABLE"],
      [() => "", "INTERNAL_ERROR"],
    ] as const) {
      const service = createSupportMessageService({ store: f.store, messageHmacKey: Buffer.alloc(32), redactText });
      await expect(service.sendMessage(f.user, f.input)).rejects.toMatchObject({ code });
    }
    expect(f.store.messageSnapshot()).toEqual([]);
    expect(() => createSupportMessageService({ store: f.store, messageHmacKey: Buffer.alloc(8), redactText: (t) => t }))
      .toThrow(TypeError);
  });

  it("rejects expired identities and masks database failures", async () => {
    const f = await setup();
    f.store.offline = true;
    await expect(f.messages.sendMessage(f.user, f.input)).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    f.store.offline = false;
    f.advanceTime(60_001);
    await expect(f.messages.sendMessage(f.user, f.input)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(f.messages.listMessages(f.user, f.session.id)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("rejects corrupt or unordered storage results", async () => {
    const f = await setup();
    const { message } = await f.messages.sendMessage(f.user, f.input);
    const transaction = f.store.transaction.bind(f.store);
    vi.spyOn(f.store, "transaction").mockImplementation((work) => transaction((tx) => work({ ...tx,
      listMessages: async () => [message, message],
    })));
    await expect(f.messages.listMessages(f.user, f.session.id)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });
});
