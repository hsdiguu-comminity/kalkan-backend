// TR: Gerçek PostgreSQL + imzalı JWT + HTTP/Socket.IO. EN: Real PostgreSQL, signed JWTs and network transports.
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { PrismaPg } from "@prisma/adapter-pg";
import { SignJWT } from "jose";
import request from "supertest";
import { io, type Socket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client.js";
import { createPrismaAccessCheck, createSupportJwtVerifier } from "../../src/modules/support/support-auth.js";
import { createSupportServer } from "../../src/modules/support/support-runtime.js";
import { createPrismaSupportStore } from "../../src/modules/support/prisma-support.store.js";
import { createSupportOutboxDispatcher, createSupportQueueHandler } from "../../src/modules/support/support-outbox.js";
import type { SupportActor } from "../../src/modules/support/handoff.service.js";

const connectionString = process.env.SUPPORT_TEST_DATABASE_URL;
if (!connectionString || !new URL(connectionString).pathname.endsWith("_test")) throw new Error("Dedicated test database required");
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 10 }) });
const cleanup: Array<() => Promise<void>> = [];
const users: string[] = [];
beforeAll(async () => { await prisma.$connect(); });
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
});

async function setup() {
  const id = randomUUID().replaceAll("-", "");
  const expiresAt = (Math.floor(Date.now() / 1000) + 300) * 1000;
  const user: SupportActor = { userId: `u_${id}`, role: "user", expiresAt };
  const expert: SupportActor = { userId: `e_${id}`, role: "expert", expiresAt };
  const expert2: SupportActor = { userId: `e2_${id}`, role: "expert", expiresAt };
  for (const actor of [user, expert, expert2]) {
    await prisma.user.create({ data: { id: actor.userId, email: `${actor.userId}@example.test`,
      passwordHash: "test-only-not-a-login", role: actor.role } });
    users.push(actor.userId);
  }
  const conversation = await prisma.conversation.create({ data: { userId: user.userId } });
  const revoked = new Set<string>();
  const key = new Uint8Array(32).fill(19);
  const verify = createSupportJwtVerifier({ key, issuer: "test", audience: "support",
    isActive: createPrismaAccessCheck(prisma, async (jti) => revoked.has(jti)) });
  const publish = vi.fn(async () => {});
  const runtime = createSupportServer({ prisma, verifyAccessToken: verify, messageHmacKey: new Uint8Array(32).fill(20),
    // TR: Yalnızca test maskesi. EN: Test-only redaction policy.
    redactText: (text) => text.replace(/secret:\S+/g, "[MASKED]"), allowedOrigins: [],
    allowRequestsWithoutOrigin: true, publishQueueEvent: publish, onDeliveryError: vi.fn() });
  cleanup.push(runtime.close);
  const { session } = await runtime.handoff.requestHandoff(user, { conversationId: conversation.id });
  async function accept(actor = expert) {
    await prisma.supportAgentOffer.create({ data: { sessionId: session.id, agentId: actor.userId,
      expiresAt: new Date(Date.now() + 60_000) } });
    return runtime.handoff.acceptSession(actor, session.id);
  }
  async function token(actor = user) {
    return new SignJWT({ role: actor.role }).setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
      .setSubject(actor.userId).setJti(actor.userId).setIssuer("test").setAudience("support")
      .setIssuedAt().setExpirationTime(expiresAt / 1000).sign(key);
  }
  const input = { sessionId: session.id, clientMessageId: randomUUID(), text: "Merhaba secret:private" };
  return { runtime, session, conversation, user, expert, expert2, accept, token, revoked, publish, input };
}

describe("PostgreSQL support integration", () => {
  it("deduplicates concurrent session creation against unique constraints", async () => {
    const f = await setup();
    const chat = await prisma.conversation.create({ data: { userId: f.user.userId } });
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      f.runtime.handoff.requestHandoff(f.user, { conversationId: chat.id })));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.session.id)).size).toBe(1);
    expect(await prisma.supportOutboxEvent.count({ where: { sessionId: results[0]!.session.id } })).toBe(1);
  });
  it("deduplicates concurrent messages and preserves state revision/timestamp", async () => {
    const f = await setup();
    const active = await f.accept();
    const results = await Promise.all(Array.from({ length: 20 }, () => f.runtime.messages.sendMessage(f.user, f.input)));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await prisma.supportMessage.count({ where: { sessionId: f.session.id } })).toBe(1);
    const stored = await prisma.supportMessage.findFirstOrThrow({ where: { sessionId: f.session.id } });
    expect(stored.content).toBe("Merhaba [MASKED]");
    expect(stored.contentFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(await f.runtime.handoff.getSession(f.user, f.session.id)).toEqual(active);
  });
  it("serializes different message sequences and rolls back a failed transaction", async () => {
    const f = await setup();
    await f.accept();
    await Promise.all(Array.from({ length: 10 }, () => f.runtime.messages.sendMessage(f.user,
      { ...f.input, clientMessageId: randomUUID() })));
    const page = await f.runtime.messages.listMessages(f.user, f.session.id);
    expect(page.items.map((m) => m.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await expect(createPrismaSupportStore(prisma).transaction(async (tx) => {
      await tx.nextMessageSequence(f.session.id);
      const session = (await tx.findById(f.session.id))!;
      const changed = { ...session, revision: session.revision + 1 };
      await tx.saveSession(changed);
      await tx.appendOutbox({ id: `rollback_${f.session.id}`, type: "support.accepted", session: changed });
      throw new Error("rollback-test");
    })).rejects.toThrow("rollback-test");
    expect((await prisma.supportSession.findUniqueOrThrow({ where: { id: f.session.id } })).lastMessageSequence).toBe(10);
    expect((await f.runtime.handoff.getSession(f.user, f.session.id)).revision).toBe(2);
    expect(await prisma.supportOutboxEvent.findUnique({ where: { id: `rollback_${f.session.id}` } })).toBeNull();
  });
  it("chooses one expert and rejects expired offers", async () => {
    const f = await setup();
    await prisma.supportAgentOffer.createMany({ data: [f.expert, f.expert2].map((actor) => ({
      sessionId: f.session.id, agentId: actor.userId, expiresAt: new Date(Date.now() + 60_000),
    })) });
    const result = await Promise.allSettled([f.expert, f.expert2].map((actor) => f.runtime.handoff.acceptSession(actor, f.session.id)));
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(result.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "ALREADY_ASSIGNED" } });
    const other = await setup();
    await prisma.supportAgentOffer.create({ data: { sessionId: other.session.id, agentId: other.expert.userId,
      expiresAt: new Date(Date.now() - 1) } });
    await expect(other.runtime.handoff.acceptSession(other.expert, other.session.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("serializes closure against writes and supports committed retries after closure", async () => {
    const f = await setup();
    await f.accept();
    const initial = await f.runtime.messages.sendMessage(f.user, f.input);
    const [close, send] = await Promise.allSettled([
      f.runtime.handoff.closeSession(f.user, f.session.id),
      f.runtime.messages.sendMessage(f.user, { ...f.input, clientMessageId: randomUUID() }),
    ]);
    expect(close.status).toBe("fulfilled");
    if (send.status === "rejected") expect(send.reason).toMatchObject({ code: "SESSION_CLOSED" });
    expect((await f.runtime.handoff.getSession(f.user, f.session.id)).status).toBe("closed");
    expect(await f.runtime.messages.sendMessage(f.user, f.input)).toEqual({ ...initial, created: false });
  });
  it("delivers HTTP -> socket -> persisted history with signed auth and account revocation", async () => {
    const f = await setup();
    const userToken = await f.token();
    const expertToken = await f.token(f.expert);
    await prisma.supportAgentOffer.create({ data: { sessionId: f.session.id, agentId: f.expert.userId,
      expiresAt: new Date(Date.now() + 60_000) } });
    await request(f.runtime.app).post(`/support/sessions/${f.session.id}/accept`)
      .set("Authorization", `Bearer ${expertToken}`).expect(200);
    await new Promise<void>((resolve) => f.runtime.httpServer.listen(0, "127.0.0.1", resolve));
    const port = (f.runtime.httpServer.address() as AddressInfo).port;
    const socket: Socket = io(`http://127.0.0.1:${port}/support`, { auth: { token: userToken },
      transports: ["websocket"], reconnection: false, timeout: 2000 });
    cleanup.push(async () => { socket.disconnect(); });
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
    expect(await socket.timeout(2000).emitWithAck("support:join", { sessionId: f.session.id })).toMatchObject({ ok: true });
    expect(await socket.timeout(2000).emitWithAck("support:message:send", f.input))
      .toMatchObject({ ok: true, data: { text: "Merhaba [MASKED]", sequence: 1 } });
    const history = await request(f.runtime.app).get(`/support/sessions/${f.session.id}/messages`)
      .set("Authorization", `Bearer ${expertToken}`).expect(200);
    expect(history.body.items).toHaveLength(1);
    await prisma.user.update({ where: { id: f.user.userId }, data: { status: "suspended" } });
    await request(f.runtime.app).get(`/support/sessions/${f.session.id}`).set("Authorization", `Bearer ${userToken}`).expect(401);
    expect(await socket.timeout(2000).emitWithAck("support:join", { sessionId: f.session.id }))
      .toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    f.revoked.add(f.expert.userId);
    await request(f.runtime.app).get(`/support/sessions/${f.session.id}`).set("Authorization", `Bearer ${expertToken}`).expect(401);
  });
  it("retries durable outbox failures and deduplicates notifications using the current state", async () => {
    const f = await setup();
    await f.accept();
    await f.runtime.handoff.closeSession(f.user, f.session.id);
    // TR: Diğer fixture olayları bu testin seçimini etkilemez. EN: Limit delivery to this fixture with leased other rows.
    await prisma.supportOutboxEvent.updateMany({ where: { sessionId: { not: f.session.id }, processedAt: null },
      data: { processedAt: new Date() } });
    let clock = new Date();
    const publish = vi.fn(async () => {});
    publish.mockRejectedValueOnce(new Error("private-redis-password"));
    const dispatcher = createSupportOutboxDispatcher({ prisma, publish, now: () => clock,
      publishSessionUpdate: f.runtime.realtime.publishSessionUpdate });
    const first = await dispatcher.runOnce();
    expect(first).toEqual({ delivered: 2, failed: 1 });
    const failed = await prisma.supportOutboxEvent.findFirstOrThrow({ where: { sessionId: f.session.id, processedAt: null } });
    expect(failed.lastErrorCode).toBe("DELIVERY_FAILED");
    expect(failed.attempts).toBe(1);
    expect(await dispatcher.runOnce()).toEqual({ delivered: 0, failed: 0 });
    clock = new Date(clock.getTime() + 2000);
    expect(await dispatcher.runOnce()).toEqual({ delivered: 1, failed: 0 });
    const notices = await prisma.notification.findMany({ where: { userId: { in: [f.user.userId, f.expert.userId] } } });
    expect(notices).toHaveLength(2);
    expect(notices.every((n) => n.body === "Destek görüşmeniz kapatıldı.")).toBe(true);
    expect(await dispatcher.runOnce()).toEqual({ delivered: 0, failed: 0 });
  });
  it("uses atomic claims across dispatchers and recovers expired leases", async () => {
    const f = await setup();
    await prisma.supportOutboxEvent.updateMany({ where: { sessionId: { not: f.session.id }, processedAt: null }, data: { processedAt: new Date() } });
    await prisma.supportOutboxEvent.updateMany({ where: { sessionId: f.session.id }, data: {
      leaseToken: "crashed-worker", leaseExpiresAt: new Date(Date.now() - 1000),
    } });
    const publish = vi.fn(async () => {});
    const make = () => createSupportOutboxDispatcher({ prisma, publish, publishSessionUpdate: async () => {} });
    const results = await Promise.all([make().runOnce(), make().runOnce()]);
    expect(results.reduce((sum, r) => sum + r.delivered, 0)).toBe(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });
  it("feeds late queue events the latest closed state and rejects forged events", async () => {
    const f = await setup();
    await f.runtime.handoff.closeSession(f.user, f.session.id);
    const reconcile = vi.fn(async () => {});
    const handler = createSupportQueueHandler(prisma, reconcile);
    const queuedId = `support:${f.session.id}:1`;
    await handler({ eventId: queuedId, sessionId: f.session.id });
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ status: "closed", revision: 2 }), queuedId);
    await expect(handler({ eventId: queuedId, sessionId: "wrong" })).rejects.toThrow();
  });
  it("bounds stalled delivery and refuses to finalize an expired lease", async () => {
    const f = await setup();
    await prisma.supportOutboxEvent.updateMany({ where: { sessionId: { not: f.session.id }, processedAt: null }, data: { processedAt: new Date() } });
    const stalled = createSupportOutboxDispatcher({ prisma, publish: async () => new Promise(() => {}),
      publishSessionUpdate: async () => {}, deliveryTimeoutMs: 50 });
    expect(await stalled.runOnce()).toEqual({ delivered: 0, failed: 1 });
    await prisma.supportOutboxEvent.updateMany({ where: { sessionId: f.session.id }, data: { nextAttemptAt: new Date(0) } });
    let now = Date.now();
    const expired = createSupportOutboxDispatcher({ prisma, now: () => new Date(now),
      publish: async () => { now += 40_000; }, publishSessionUpdate: async () => {} });
    expect(await expired.runOnce()).toEqual({ delivered: 0, failed: 1 });
    expect(await prisma.supportOutboxEvent.count({ where: { sessionId: f.session.id, processedAt: null } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: f.user.userId } })).toBe(0);
  });
});
