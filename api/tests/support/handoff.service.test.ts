// TR: Devir yetkileri, tekrarlar, yarışlar ve rollback sınanır; gerçek PostgreSQL testi değildir.
// EN: Tests handoff permissions, retries, races and rollback; this is not a PostgreSQL integration test.
import { describe, expect, it, vi } from "vitest";
import { createHandoffService, supportSessionSchema } from "../../src/modules/support/handoff.service.js";
import { makeHandoffFixture } from "./helpers/handoff.fixture.js";

describe("Asistandan uzmana devir servisi", () => {
  it("oturum ve kuyruk teslim kaydını birlikte oluşturur", async () => {
    const f = makeHandoffFixture();
    const result = await f.service.requestHandoff(f.user, { conversationId: "chat_1" });
    expect(result.created).toBe(true);
    expect(result.session).toMatchObject({
      conversationId: "chat_1", userId: "user_1", agentId: null, status: "queued",
      source: "user_request", revision: 1, closedAt: null, closeReason: null,
    });
    expect(supportSessionSchema.safeParse(result.session).success).toBe(true);
    expect(Object.isFrozen(result.session)).toBe(true);
    expect(f.store.snapshot().events).toEqual([{
      id: `support:${result.session.id}:1`, type: "support.queued", session: result.session,
    }]);
  });

  it("20 eşzamanlı istekte yalnızca bir oturum ve tek teslim kaydı oluşturur", async () => {
    const f = makeHandoffFixture();
    const results = await Promise.all(Array.from({ length: 20 }, () =>
      f.service.requestHandoff(f.user, { conversationId: "chat_1" })));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.session.id)).size).toBe(1);
    expect(f.store.snapshot().sessions).toHaveLength(1);
    expect(f.store.snapshot().events).toHaveLength(1);
  });

  it.each([{}, { conversationId: "chat/1" }, { conversationId: "chat_1", userId: "user_2" },
    { conversationId: "chat_1", source: "assistant_escalation" }, null])(
    "geçersiz veya kimlik taklidi içeren gövdeyi reddeder: %#", async (body) => {
      const f = makeHandoffFixture();
      await expect(f.service.requestHandoff(f.user, body)).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
      expect(f.store.snapshot().sessions).toHaveLength(0);
    },
  );

  it.each(["chat_2", "missing_chat"])("erişilemeyen sohbet için aynı 404 döner: %s", async (id) => {
    const f = makeHandoffFixture();
    await expect(f.service.requestHandoff(f.user, { conversationId: id })).rejects.toMatchObject({
      code: "NOT_FOUND", status: 404,
    });
    expect(f.store.snapshot().events).toHaveLength(0);
  });

  it("uzman ve admin kullanıcı adına public devir başlatamaz", async () => {
    const f = makeHandoffFixture();
    for (const actor of [f.expert, f.admin]) {
      await expect(f.service.requestHandoff(actor, { conversationId: "chat_1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it.each([null, {}, { userId: "user_1", role: "user", expiresAt: 1 }])(
    "geçersiz veya süresi dolmuş aktörü reddeder: %#", async (actor) => {
      const f = makeHandoffFixture();
      await expect(f.service.requestHandoff(actor, { conversationId: "chat_1" })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    },
  );

  it("sohbet kontrolü beklerken token biterse yazmaz", async () => {
    const f = makeHandoffFixture();
    f.conversations.getOwnerId = async () => {
      f.advanceTime(60_001);
      return f.user.userId;
    };
    await expect(f.service.requestHandoff(f.user, { conversationId: "chat_1" })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(f.store.snapshot().sessions).toHaveLength(0);
  });

  it("güvenilir AI yolu sohbet sahibini kaynaktan alır, sonraki istek kaynağı değiştirmez", async () => {
    const f = makeHandoffFixture();
    const initial = await f.service.requestAssistantHandoff({ conversationId: "chat_1" });
    expect(initial.session.source).toBe("assistant_escalation");
    expect(initial.session.userId).toBe(f.user.userId);
    const repeated = await f.service.requestHandoff(f.user, { conversationId: "chat_1" });
    expect(repeated).toEqual({ created: false, session: initial.session });
    expect(f.store.snapshot().events).toHaveLength(1);
  });

  it("outbox yazımı başarısız olursa oturum oluşturmayı geri alır", async () => {
    const f = makeHandoffFixture();
    f.store.failNextOutbox = true;
    await expect(f.service.requestHandoff(f.user, { conversationId: "chat_1" })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(f.store.snapshot()).toEqual({ sessions: [], events: [] });
    expect((await f.service.requestHandoff(f.user, { conversationId: "chat_1" })).created).toBe(true);
  });

  it("sohbet veya depo arızasında özel exception içeriğini açığa çıkarmaz", async () => {
    const f = makeHandoffFixture();
    f.store.offline = true;
    await expect(f.service.requestHandoff(f.user, { conversationId: "chat_1" })).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE", message: "Destek hizmetine şu anda ulaşılamıyor.",
    });
    f.store.offline = false;
    f.conversations.getOwnerId = async () => { throw new Error("private-chat-api-key"); };
    await expect(f.service.requestHandoff(f.user, { conversationId: "chat_1" })).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE", message: "Destek hizmetine şu anda ulaşılamıyor.",
    });
  });

  it("teklif almamış uzman oturumu kabul edemez veya okuyamaz", async () => {
    const f = makeHandoffFixture();
    const { session } = await f.service.requestHandoff(f.user, { conversationId: "chat_1" });
    await expect(f.service.acceptSession(f.expert, session.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(f.service.getSession(f.expert, session.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(f.store.snapshot().events).toHaveLength(1);
  });

  it("kullanıcı ve admin uzman ataması yapamaz", async () => {
    const f = makeHandoffFixture();
    const { session } = await f.service.requestHandoff(f.user, { conversationId: "chat_1" });
    for (const actor of [f.user, f.admin]) {
      await expect(f.service.acceptSession(actor, session.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("iki uzman yarıştığında yalnızca birini atar", async () => {
    const f = makeHandoffFixture();
    const { session } = await f.service.requestHandoff(f.user, { conversationId: "chat_1" });
    f.store.offer(session.id, f.expert.userId);
    f.store.offer(session.id, f.expert2.userId);
    const results = await Promise.allSettled([
      f.service.acceptSession(f.expert, session.id),
      f.service.acceptSession(f.expert2, session.id),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "ALREADY_ASSIGNED", status: 409 },
    });
    const updated = await f.service.getSession(f.user, session.id);
    expect(updated.status).toBe("active");
    expect(updated.revision).toBe(2);
    expect(f.store.snapshot().events.map((event) => event.type)).toEqual(["support.queued", "support.accepted"]);
  });

  it("aynı uzmanın kabul tekrarı teklif kalksa bile yan etki üretmez", async () => {
    const f = makeHandoffFixture();
    const { session } = await f.service.requestHandoff(f.user, { conversationId: "chat_1" });
    f.store.offer(session.id, f.expert.userId);
    const accepted = await f.service.acceptSession(f.expert, session.id);
    f.store.removeOffer(session.id, f.expert.userId);
    expect(await f.service.acceptSession(f.expert, session.id)).toEqual(accepted);
    expect(await f.service.getSession(f.expert, session.id)).toEqual(accepted);
    expect((await f.service.requestHandoff(f.user, { conversationId: "chat_1" })).session).toEqual(accepted);
    expect(f.store.snapshot().events).toHaveLength(2);
  });

  it("atama outbox hatasında geri alınır ve tekrar denenebilir", async () => {
    const f = makeHandoffFixture();
    const { session } = await f.service.requestHandoff(f.user, { conversationId: "chat_1" });
    f.store.offer(session.id, f.expert.userId);
    f.store.failNextOutbox = true;
    await expect(f.service.acceptSession(f.expert, session.id)).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(await f.service.getSession(f.user, session.id)).toEqual(session);
    expect(f.store.snapshot().events).toHaveLength(1);
    expect((await f.service.acceptSession(f.expert, session.id)).status).toBe("active");
  });

  it("bekleyen isteği yalnızca sahibi iptal eder; tekrar revision artırmaz", async () => {
    const f = makeHandoffFixture();
    const { session } = await f.service.requestHandoff(f.user, { conversationId: "chat_1" });
    for (const actor of [f.otherUser, f.expert]) {
      await expect(f.service.closeSession(actor, session.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    const closed = await f.service.closeSession(f.user, session.id);
    expect(closed).toMatchObject({ status: "closed", agentId: null, revision: 2, closeReason: "user_closed" });
    expect(closed.closedAt).toBe(closed.updatedAt);
    expect(await f.service.closeSession(f.user, session.id)).toEqual(closed);
    await expect(f.service.requestHandoff(f.user, { conversationId: "chat_1" })).rejects.toMatchObject({ code: "SESSION_CLOSED" });
    expect(f.store.snapshot().events).toHaveLength(2);
  });

  it("atanmış uzman kapatabilir ve kapanış sonrası katılımcılar okuyabilir", async () => {
    const f = makeHandoffFixture();
    const { session } = await f.service.requestHandoff(f.user, { conversationId: "chat_1" });
    f.store.offer(session.id, f.expert.userId);
    await f.service.acceptSession(f.expert, session.id);
    const closed = await f.service.closeSession(f.expert, session.id);
    expect(closed).toMatchObject({ status: "closed", revision: 3, closeReason: "agent_closed", agentId: f.expert.userId });
    expect(await f.service.getSession(f.user, session.id)).toEqual(closed);
    expect(await f.service.getSession(f.expert, session.id)).toEqual(closed);
    expect(await f.service.closeSession(f.user, session.id)).toEqual(closed);
    await expect(f.service.acceptSession(f.expert, session.id)).rejects.toMatchObject({ code: "SESSION_CLOSED" });
    expect(f.store.snapshot().events).toHaveLength(3);
  });

  it("başka kullanıcı ve admin görüşme içeriğine erişemez", async () => {
    const f = makeHandoffFixture();
    const { session } = await f.service.requestHandoff(f.user, { conversationId: "chat_1" });
    await expect(f.service.getSession(f.otherUser, session.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(f.service.getSession(f.admin, session.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(f.service.closeSession(f.admin, session.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("kapanış outbox hatasında önceki durumu korur", async () => {
    const f = makeHandoffFixture();
    const { session } = await f.service.requestHandoff(f.user, { conversationId: "chat_1" });
    f.store.failNextOutbox = true;
    await expect(f.service.closeSession(f.user, session.id)).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(await f.service.getSession(f.user, session.id)).toEqual(session);
  });

  it.each(["close-first", "accept-first"])("kabul/kapatma yarışını sıralar: %s", async (order) => {
    const f = makeHandoffFixture();
    const { session } = await f.service.requestHandoff(f.user, { conversationId: "chat_1" });
    f.store.offer(session.id, f.expert.userId);
    const close = () => f.service.closeSession(f.user, session.id);
    const accept = () => f.service.acceptSession(f.expert, session.id);
    const results = await Promise.allSettled(order === "close-first" ? [close(), accept()] : [accept(), close()]);
    expect((await f.service.getSession(f.user, session.id)).status).toBe("closed");
    if (order === "close-first") {
      expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "SESSION_CLOSED" } });
      expect(f.store.snapshot().events).toHaveLength(2);
    } else {
      expect(results.every((result) => result.status === "fulfilled")).toBe(true);
      expect(f.store.snapshot().events).toHaveLength(3);
    }
  });

  it("bozuk veri veya kimlik üretimiyle yazmayı reddeder", async () => {
    const f = makeHandoffFixture();
    const service = createHandoffService({ store: f.store, conversations: f.conversations, newSessionId: () => "bad/id" });
    await expect(service.requestHandoff(f.user, { conversationId: "chat_1" })).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(f.store.snapshot().sessions).toHaveLength(0);
    const { session } = await f.service.requestHandoff(f.user, { conversationId: "chat_1" });
    vi.spyOn(f.store, "transaction").mockImplementation(async (work) => work({
      findById: async () => ({ ...session, status: "active", agentId: null }),
      findByConversationId: async () => session,
      hasAgentOffer: async () => false,
      saveSession: async () => {}, appendOutbox: async () => {},
    }));
    await expect(f.service.getSession(f.user, session.id)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });
});
