// rateLimit.ts'yi sahte saatle sınar; token'lar yalnızca test değeridir.
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createAuthentication } from "../../src/middlewares/authenticate.js";
import { createErrorHandler } from "../../src/middlewares/errorHandler.js";
import {
  byUserOrIp,
  createMemoryStore,
  createRateLimit,
  type RateLimitOptions,
} from "../../src/middlewares/rateLimit.js";

const START = 1_800_000_000_000;

function setup(overrides: Partial<RateLimitOptions> = {}) {
  const clock = { now: START };
  const app = express();
  const { authenticate } = createAuthentication({
    verifyAccessToken: async (token) => {
      const tokens: Record<string, unknown> = {
        "token-a": { userId: "user_a", role: "user", expiresAt: START + 3_600_000 },
        "token-b": { userId: "user_b", role: "user", expiresAt: START + 3_600_000 },
      };
      return tokens[token] ?? null;
    },
    now: () => clock.now,
  });
  app.get(
    "/",
    authenticate,
    createRateLimit({ name: "test", limit: 2, windowMs: 60_000, now: () => clock.now, ...overrides }),
    (_req, res) => {
      res.json({ ok: true });
    },
  );
  app.use(createErrorHandler({ log: () => {} }));
  return { app, clock };
}

const send = (app: express.Express, token = "token-a") =>
  request(app).get("/").set("Authorization", `Bearer ${token}`);

describe("createRateLimit", () => {
  it("sınıra kadar geçirir, sonra 429 ve Retry-After döner", async () => {
    const { app } = setup();
    const first = await send(app).expect(200);
    expect(first.headers["ratelimit-limit"]).toBe("2");
    expect(first.headers["ratelimit-remaining"]).toBe("1");
    expect(first.headers["ratelimit-reset"]).toBe("60");
    await send(app).expect(200);

    const blocked = await send(app).expect(429);
    expect(blocked.headers["retry-after"]).toBe("60");
    expect(blocked.headers["ratelimit-remaining"]).toBe("0");
    expect(blocked.body.error).toEqual({
      code: "RATE_LIMITED",
      message: "Çok fazla istek gönderildi. Lütfen biraz sonra tekrar deneyin.",
      retryAfterSeconds: 60,
    });
  });

  it("pencere bitince sayaç sıfırlanır", async () => {
    const { app, clock } = setup();
    await send(app).expect(200);
    await send(app).expect(200);
    clock.now += 45_000;
    const blocked = await send(app).expect(429);
    expect(blocked.headers["retry-after"]).toBe("15");
    clock.now += 15_000;
    await send(app).expect(200);
  });

  it("byUserOrIp ile her kullanıcı ayrı sayılır", async () => {
    const { app } = setup({ key: byUserOrIp });
    await send(app, "token-a").expect(200);
    await send(app, "token-a").expect(200);
    await send(app, "token-a").expect(429);
    await send(app, "token-b").expect(200);
  });

  it("aynı depoyu paylaşan farklı adlı sınırlayıcılar birbirini etkilemez", async () => {
    const store = createMemoryStore();
    const app = express();
    app.get("/a", createRateLimit({ name: "a", limit: 1, windowMs: 60_000, store }), (_q, r) => {
      r.json({});
    });
    app.get("/b", createRateLimit({ name: "b", limit: 1, windowMs: 60_000, store }), (_q, r) => {
      r.json({});
    });
    app.use(createErrorHandler({ log: () => {} }));
    await request(app).get("/a").expect(200);
    await request(app).get("/b").expect(200);
    await request(app).get("/a").expect(429);
  });

  it("depo hata verirse istek geçirilmez, 503 döner", async () => {
    const { app } = setup({
      store: {
        increment: async () => {
          throw new Error("redis kapalı");
        },
      },
    });
    const res = await send(app).expect(503);
    expect(res.body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(res.text).not.toContain("redis");
  });

  it("geçersiz ayarlar uygulama başlarken reddedilir", () => {
    expect(() => createRateLimit({ name: "x", limit: 0, windowMs: 60_000 })).toThrow(RangeError);
    expect(() => createRateLimit({ name: "x", limit: 5, windowMs: 10 })).toThrow(RangeError);
  });
});

describe("createMemoryStore", () => {
  it("süresi dolan kayıtları temizler ve yeni pencere başlatır", async () => {
    const store = createMemoryStore();
    expect(await store.increment("k", 1000, START)).toEqual({ count: 1, resetAt: START + 1000 });
    expect(await store.increment("k", 1000, START + 500)).toEqual({ count: 2, resetAt: START + 1000 });
    expect(await store.increment("k", 1000, START + 1000)).toEqual({ count: 1, resetAt: START + 2000 });
  });
});
