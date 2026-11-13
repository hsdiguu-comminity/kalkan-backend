// TR: Dört HTTP yolunu Supertest ile sınar; token'lar ve veri deposu yalnızca test içindir.
// EN: Tests the four HTTP routes with Supertest; tokens and storage here are test fixtures only.
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createSupportRouter } from "../../src/modules/support/support.routes.js";
import { makeHandoffFixture } from "./helpers/handoff.fixture.js";

function setup() {
  const fixture = makeHandoffFixture();
  const resolvePrincipal = vi.fn(async (req: express.Request): Promise<unknown> => {
    const actors: Record<string, unknown> = {
      "Bearer user-token": fixture.user,
      "Bearer other-token": fixture.otherUser,
      "Bearer expert-token": fixture.expert,
      "Bearer admin-token": fixture.admin,
    };
    return actors[req.get("authorization") ?? ""] ?? null;
  });
  const app = express();
  app.use("/support", createSupportRouter({ service: fixture.service, resolvePrincipal }));
  return { ...fixture, app, resolvePrincipal };
}

describe("Destek HTTP yolları", () => {
  it("devir -> durum -> uzman kabulü -> kapanış akışını çalıştırır", async () => {
    const f = setup();
    const created = await request(f.app).post("/support/handoffs")
      .set("Authorization", "Bearer user-token").send({ conversationId: "chat_1" }).expect(201);
    const id: string = created.body.id;
    expect(created.headers["cache-control"]).toBe("no-store");
    expect(created.body.status).toBe("queued");
    const repeated = await request(f.app).post("/support/handoffs")
      .set("Authorization", "Bearer user-token").send({ conversationId: "chat_1" }).expect(200);
    expect(repeated.body).toEqual(created.body);
    const read = await request(f.app).get(`/support/sessions/${id}`)
      .set("Authorization", "Bearer user-token").expect(200);
    expect(read.body).toEqual(created.body);
    f.store.offer(id, f.expert.userId);
    const accepted = await request(f.app).post(`/support/sessions/${id}/accept`)
      .set("Authorization", "Bearer expert-token").expect(200);
    expect(accepted.body).toMatchObject({ status: "active", agentId: f.expert.userId, revision: 2 });
    const closed = await request(f.app).post(`/support/sessions/${id}/close`)
      .set("Authorization", "Bearer expert-token").expect(200);
    expect(closed.body).toMatchObject({ status: "closed", closeReason: "agent_closed", revision: 3 });
    const closeAgain = await request(f.app).post(`/support/sessions/${id}/close`)
      .set("Authorization", "Bearer user-token").expect(200);
    expect(closeAgain.body).toEqual(closed.body);
    const reopen = await request(f.app).post("/support/handoffs")
      .set("Authorization", "Bearer user-token").send({ conversationId: "chat_1" }).expect(409);
    expect(reopen.body.error.code).toBe("SESSION_CLOSED");
  });

  it("eksik kimlik için JSON 401 ve Bearer başlığı döner", async () => {
    const f = setup();
    const response = await request(f.app).post("/support/handoffs")
      .send({ conversationId: "chat_1" }).expect(401);
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
    expect(f.store.snapshot().sessions).toHaveLength(0);
  });

  it("auth servisinin exception içeriğini gizler", async () => {
    const f = setup();
    f.resolvePrincipal.mockRejectedValueOnce(new Error("private-jwt-secret"));
    const response = await request(f.app).get("/support/sessions/missing").expect(503);
    expect(response.body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(response.text).not.toContain("private-jwt-secret");
    expect(response.body.error).not.toHaveProperty("stack");
  });

  it("yetkisiz sohbet ve eksik sohbet için aynı hata zarfını döner", async () => {
    const f = setup();
    const hidden = await request(f.app).post("/support/handoffs")
      .set("Authorization", "Bearer other-token").send({ conversationId: "chat_1" }).expect(404);
    const missing = await request(f.app).post("/support/handoffs")
      .set("Authorization", "Bearer other-token").send({ conversationId: "missing" }).expect(404);
    expect(hidden.body).toEqual(missing.body);
  });

  it("admin rolüyle devir oluşturulamaz", async () => {
    const f = setup();
    const response = await request(f.app).post("/support/handoffs")
      .set("Authorization", "Bearer admin-token").send({ conversationId: "chat_1" }).expect(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it.each([
    {}, { conversationId: "chat_1", userId: "other" },
    { conversationId: "chat_1", source: "assistant_escalation" },
    { conversationId: "chat/1" },
  ])("geçersiz gövdeyi 400 ile reddeder: %#", async (body) => {
    const f = setup();
    const response = await request(f.app).post("/support/handoffs")
      .set("Authorization", "Bearer user-token").send(body).expect(400);
    expect(response.body.error.code).toBe("INVALID_PAYLOAD");
  });

  it("bozuk JSON girdisini HTML/stack yerine hata zarfıyla döner", async () => {
    const f = setup();
    const response = await request(f.app).post("/support/handoffs")
      .set("Authorization", "Bearer user-token").set("Content-Type", "application/json")
      .send('{"conversationId":').expect(400);
    expect(response.type).toBe("application/json");
    expect(response.body.error.code).toBe("INVALID_PAYLOAD");
  });

  it("8 KiB'den büyük gövdeyi reddeder", async () => {
    const f = setup();
    const response = await request(f.app).post("/support/handoffs")
      .set("Authorization", "Bearer user-token").send({ conversationId: "x".repeat(9000) }).expect(400);
    expect(response.body.error.code).toBe("INVALID_PAYLOAD");
    expect(f.store.snapshot().sessions).toHaveLength(0);
  });

  it("accept/close gövdesinden uzman veya kapanış nedeni seçilemez", async () => {
    const f = setup();
    const { session } = await f.service.requestHandoff(f.user, { conversationId: "chat_1" });
    for (const action of ["accept", "close"]) {
      await request(f.app).post(`/support/sessions/${session.id}/${action}`)
        .set("Authorization", "Bearer expert-token").send({ agentId: "expert_2" }).expect(400);
    }
    expect(f.store.snapshot().events).toHaveLength(1);
  });

  it("JSON olmayan gövde ve bilinmeyen sorgu alanı reddedilir", async () => {
    const f = setup();
    await request(f.app).post("/support/handoffs")
      .set("Authorization", "Bearer user-token").type("text").send("chat_1").expect(400);
    await request(f.app).post("/support/sessions/any/close")
      .set("Authorization", "Bearer user-token").type("text").send("ignored?").expect(400);
    await request(f.app).get("/support/sessions/any?userId=other")
      .set("Authorization", "Bearer user-token").expect(400);
  });

  it("depo/outbox hatasında 503 döner ve başarı kaydı bırakmaz", async () => {
    const f = setup();
    f.store.failNextOutbox = true;
    const response = await request(f.app).post("/support/handoffs")
      .set("Authorization", "Bearer user-token").send({ conversationId: "chat_1" }).expect(503);
    expect(response.body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(response.text).not.toContain("private-outbox-failure");
    expect(f.store.snapshot()).toEqual({ sessions: [], events: [] });
  });

  it("güvenilir AI metodunu HTTP üzerinden yayınlamaz", async () => {
    const f = setup();
    await request(f.app).post("/support/assistant-handoffs")
      .set("Authorization", "Bearer user-token").send({ conversationId: "chat_1" }).expect(404);
    expect(f.store.snapshot().sessions).toHaveLength(0);
  });
});
