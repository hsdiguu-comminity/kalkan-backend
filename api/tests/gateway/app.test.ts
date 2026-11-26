// app.ts bağlantılarını sınar: CORS, genel istek sınırı, eşleşmeyen yol ve ortak hata işleyicisi.
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, GLOBAL_RATE_LIMIT } from "../../src/app.js";
import { loadEnv } from "../../src/config/env.js";

function appWithOrigins(origins: string) {
  return createApp(loadEnv({ NODE_ENV: "test", CORS_ORIGIN: origins }));
}

describe("Uygulama girişi", () => {
  it("eşleşmeyen yolda ortak 404 zarfını döner", async () => {
    const res = await request(createApp(loadEnv({}))).get("/yok").expect(404);
    expect(res.body).toEqual({
      error: { code: "NOT_FOUND", message: "İstenen kaynak bulunamadı." },
    });
  });

  it("bozuk JSON gövdesinde 400 INVALID_PAYLOAD döner", async () => {
    const res = await request(createApp(loadEnv({}))).post("/health")
      .set("Content-Type", "application/json").send("{bozuk").expect(400);
    expect(res.body.error.code).toBe("INVALID_PAYLOAD");
  });

  it("CORS_ORIGIN listesindeki origin'e izin verir", async () => {
    const res = await request(appWithOrigins("https://kalkan.example")).get("/health")
      .set("Origin", "https://kalkan.example").expect(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://kalkan.example");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("listede olmayan origin'e CORS izni vermez", async () => {
    const res = await request(appWithOrigins("https://kalkan.example")).get("/health")
      .set("Origin", "https://saldirgan.example").expect(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("genel sınır aşılınca 429 döner; sağlık kontrolü sınırdan etkilenmez", async () => {
    const app = createApp(loadEnv({}));
    for (let i = 0; i < GLOBAL_RATE_LIMIT.limit; i += 1) {
      await request(app).get("/yok").expect(404);
    }
    const blocked = await request(app).get("/yok").expect(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    await request(app).get("/health").expect(200);
  });

  it("sıradan yanıtlarda RateLimit başlıklarını gönderir", async () => {
    const res = await request(createApp(loadEnv({}))).get("/yok").expect(404);
    expect(res.headers["ratelimit-limit"]).toBe(String(GLOBAL_RATE_LIMIT.limit));
    expect(res.headers["ratelimit-remaining"]).toBe(String(GLOBAL_RATE_LIMIT.limit - 1));
  });
});
