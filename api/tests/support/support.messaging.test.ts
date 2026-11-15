// TR: Gerçek yerel HTTP/Socket.IO bağlantıları; auth ve depo yalnızca test içindir.
// EN: Real local HTTP/Socket.IO connections; authentication and storage are test fixtures.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { io, type Socket } from "socket.io-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupportSocketServer } from "../../src/sockets/index.js";
import { createSupportRouter } from "../../src/modules/support/support.routes.js";
import type { SupportMessage } from "../../src/modules/support/message.service.js";
import type { SupportActor, SupportSession } from "../../src/modules/support/handoff.service.js";
import { makeHandoffFixture } from "./helpers/handoff.fixture.js";

type Ack<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(active = true) {
  const f = makeHandoffFixture();
  const tokens = new Map<string, SupportActor>([
    ["user", f.user], ["expert", f.expert], ["other", f.otherUser], ["expert2", f.expert2], ["admin", f.admin],
  ]);
  const app = express();
  app.use("/support", createSupportRouter({ service: f.service, messages: f.messages,
    resolvePrincipal: async (req) => tokens.get(req.get("authorization") ?? "") ?? null }));
  const http = createServer(app);
  const server = createSupportSocketServer(http, { allowedOrigins: [], allowRequestsWithoutOrigin: true,
    verifyAccessToken: async (token) => tokens.get(token) ?? null,
    support: { handoff: f.service, messages: f.messages } });
  const clients: Socket[] = [];
  cleanups.push(async () => { clients.forEach((client) => client.disconnect()); await server.close(); });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  async function connect(token: string) {
    const client = io(`${url}/support`, { auth: { token }, transports: ["websocket"],
      reconnection: false, forceNew: true, timeout: 2000 });
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("connect_error", reject);
    });
    return client;
  }
  const { session } = await f.service.requestHandoff(f.user, { conversationId: "chat_1" });
  if (active) {
    f.store.offer(session.id, f.expert.userId);
    await f.service.acceptSession(f.expert, session.id);
  }
  const input = { sessionId: session.id, clientMessageId: randomUUID(), text: "Merhaba" };
  const history = (token = "user") => request(app).get(`/support/sessions/${session.id}/messages`).set("Authorization", token);
  return { ...f, tokens, app, server, connect, session, input, history };
}
function command<T>(client: Socket, event: string, payload: unknown): Promise<Ack<T>> {
  return client.timeout(2000).emitWithAck(event, payload) as Promise<Ack<T>>;
}
function eventOnce<T>(client: Socket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { client.off(event, handler); reject(new Error(`Missing ${event}`)); }, 2000);
    function handler(value: T) { clearTimeout(timeout); resolve(value); }
    client.once(event, handler);
  });
}

describe("Canlı mesajlaşma ve geçmiş / Live messaging and history", () => {
  it("joins authorized participants and broadcasts the committed masked message", async () => {
    const f = await setup();
    const user = await f.connect("user");
    const expert = await f.connect("expert");
    for (const client of [user, expert]) {
      expect(await command<SupportSession>(client, "support:join", { sessionId: f.session.id }))
        .toMatchObject({ ok: true, data: { status: "active", revision: 2 } });
    }
    const receivedUser = eventOnce<SupportMessage>(user, "support:message:created");
    const receivedExpert = eventOnce<SupportMessage>(expert, "support:message:created");
    const ack = await command<SupportMessage>(user, "support:message:send", { ...f.input, text: "secret:123" });
    expect(ack).toMatchObject({ ok: true, data: { text: "[MASKED]", sequence: 1 } });
    if (!ack.ok) throw new Error("message failed");
    expect(await receivedUser).toEqual(ack.data);
    expect(await receivedExpert).toEqual(ack.data);
    expect(f.store.messageSnapshot()).toHaveLength(1);
  });

  it.each(["other", "expert2", "admin"])("denies joining and sending for %s", async (token) => {
    const f = await setup();
    const client = await f.connect(token);
    const code = token === "admin" ? "FORBIDDEN" : "NOT_FOUND";
    expect(await command(client, "support:join", { sessionId: f.session.id }))
      .toMatchObject({ ok: false, error: { code } });
    expect(await command(client, "support:message:send", f.input)).toMatchObject({ ok: false, error: { code } });
    expect(f.server.namespace.sockets.get(client.id!)?.rooms.has(`support:session:${f.session.id}`)).toBe(false);
    expect(f.store.messageSnapshot()).toEqual([]);
  });

  it("requires an ack and rejects spoofed identity without writing", async () => {
    const f = await setup();
    const client = await f.connect("user");
    const error = eventOnce<{ code: string }>(client, "support:error");
    client.emit("support:message:send", f.input);
    expect(await error).toMatchObject({ code: "INVALID_PAYLOAD" });
    expect(await command(client, "support:message:send", { ...f.input, senderId: "expert_1" }))
      .toMatchObject({ ok: false, error: { code: "INVALID_PAYLOAD" } });
    expect(await command(client, "support:join", { sessionId: f.session.id, room: "admin" }))
      .toMatchObject({ ok: false, error: { code: "INVALID_PAYLOAD" } });
    expect(f.store.messageSnapshot()).toEqual([]);
  });

  it("publishes current session revisions after acceptance and closure", async () => {
    const f = await setup(false);
    const user = await f.connect("user");
    expect(await command(user, "support:join", { sessionId: f.session.id })).toMatchObject({ ok: true, data: { status: "queued" } });
    expect(await command(user, "support:message:send", f.input)).toMatchObject({ ok: false, error: { code: "SESSION_NOT_ACTIVE" } });
    f.store.offer(f.session.id, f.expert.userId);
    await f.service.acceptSession(f.expert, f.session.id);
    const accepted = eventOnce<SupportSession>(user, "support:session:updated");
    await f.server.publishSessionUpdate(f.session.id);
    expect(await accepted).toMatchObject({ status: "active", revision: 2 });
    await f.service.closeSession(f.user, f.session.id);
    const closed = eventOnce<SupportSession>(user, "support:session:updated");
    await f.server.publishSessionUpdate(f.session.id);
    expect(await closed).toMatchObject({ status: "closed", revision: 3 });
    expect(await command(user, "support:message:send", f.input)).toMatchObject({ ok: false, error: { code: "SESSION_CLOSED" } });
  });

  it("does not rebroadcast a retry and allows an authorized sender outside the room", async () => {
    const f = await setup();
    const user = await f.connect("user");
    const expert = await f.connect("expert");
    await command(expert, "support:join", { sessionId: f.session.id });
    const received: SupportMessage[] = [];
    expert.on("support:message:created", (m: SupportMessage) => received.push(m));
    const first = await command(user, "support:message:send", f.input);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(await command(user, "support:message:send", f.input)).toEqual(first);
    // TR: Sonraki yayın bir bariyerdir. EN: A subsequent delivered message is the observation barrier.
    await command(user, "support:message:send", { ...f.input, clientMessageId: randomUUID() });
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(new Set(received.map((m) => m.id)).size).toBe(2);
  });

  it("rechecks a revoked idle receiver before sending private content", async () => {
    const f = await setup();
    const user = await f.connect("user");
    const expert = await f.connect("expert");
    await command(expert, "support:join", { sessionId: f.session.id });
    const received = vi.fn();
    expert.on("support:message:created", received);
    f.tokens.delete("expert");
    const disconnected = eventOnce(expert, "disconnect");
    expect(await command(user, "support:message:send", f.input)).toMatchObject({ ok: true });
    await disconnected;
    expect(received).not.toHaveBeenCalled();
    expect(f.store.messageSnapshot()).toHaveLength(1);
  });

  it("returns a failure ack when persistence fails, without publishing", async () => {
    const f = await setup();
    const user = await f.connect("user");
    await command(user, "support:join", { sessionId: f.session.id });
    const received = vi.fn();
    user.on("support:message:created", received);
    f.store.failNextMessageWrite = true;
    expect(await command(user, "support:message:send", f.input))
      .toMatchObject({ ok: false, error: { code: "SERVICE_UNAVAILABLE" } });
    expect(received).not.toHaveBeenCalled();
    expect(f.store.messageSnapshot()).toEqual([]);
  });

  it("recovers offline messages through paginated HTTP history after rejoining", async () => {
    const f = await setup();
    const user = await f.connect("user");
    await command(user, "support:join", { sessionId: f.session.id });
    user.disconnect();
    for (let i = 0; i < 3; i++) await f.messages.sendMessage(f.expert, { ...f.input, clientMessageId: randomUUID() });
    const reconnected = await f.connect("user");
    expect(await command(reconnected, "support:join", { sessionId: f.session.id })).toMatchObject({ ok: true });
    const first = await f.history().query({ limit: 2 }).expect(200);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.body.items.map((m: SupportMessage) => m.sequence)).toEqual([1, 2]);
    expect(first.body.hasMore).toBe(true);
    const last = await f.history().query({ afterSequence: first.body.nextAfterSequence, limit: 2 }).expect(200);
    expect(last.body.items.map((m: SupportMessage) => m.sequence)).toEqual([3]);
    expect(last.body.hasMore).toBe(false);
    expect(JSON.stringify(last.body)).not.toContain("contentFingerprint");
  });

  it.each([["other", 404], ["expert2", 404], ["admin", 403], ["missing", 401]] as const)(
    "protects HTTP history from %s", async (token, status) => {
      const f = await setup();
      await f.history(token).expect(status);
    });

  it.each(["limit=0", "limit=101", "limit=1&limit=2", "afterSequence=-1", "afterSequence=1.1", "userId=user_1"])(
    "rejects invalid history query %s", async (query) => {
      const f = await setup();
      const response = await f.history().query(query).expect(400);
      expect(response.body.error.code).toBe("INVALID_PAYLOAD");
    });

  it("rejects GET bodies and reports an unwired history adapter", async () => {
    const f = await setup();
    await f.history().send({ limit: 1 }).expect(400);
    const app = express();
    app.use("/support", createSupportRouter({ service: f.service, resolvePrincipal: async () => f.user }));
    const response = await request(app).get(`/support/sessions/${f.session.id}/messages`).expect(503);
    expect(response.body.error.code).toBe("SERVICE_UNAVAILABLE");
  });
});
