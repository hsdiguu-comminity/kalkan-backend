// Ortak hata işleyicisini Supertest ile sınar.
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AppError,
  createErrorHandler,
  notFoundHandler,
} from "../../src/middlewares/errorHandler.js";

function setup() {
  const log = vi.fn();
  const app = express();
  app.use(express.json({ limit: "1kb" }));
  app.get("/unauthenticated", () => {
    throw new AppError("UNAUTHENTICATED");
  });
  app.get("/forbidden", async () => {
    throw new AppError("FORBIDDEN");
  });
  app.get("/rate-limited", () => {
    throw new AppError("RATE_LIMITED", { retryAfterSeconds: 12.2 });
  });
  app.post("/validated", (req, res) => {
    const body = z.strictObject({ code: z.string().regex(/^[0-9]{6}$/) }).parse(req.body);
    res.json(body);
  });
  app.get("/crash", () => {
    throw new Error("veritabanı parolası: s3cr3t");
  });
  app.get("/unavailable", () => {
    throw new AppError("SERVICE_UNAVAILABLE", { cause: new Error("redis down") });
  });
  app.use(notFoundHandler);
  app.use(createErrorHandler({ log }));
  return { app, log };
}

describe("Ortak hata işleyicisi", () => {
  it("401'de WWW-Authenticate başlığı ve ortak zarf döner", async () => {
    const { app } = setup();
    const res = await request(app).get("/unauthenticated").expect(401);
    expect(res.headers["www-authenticate"]).toBe("Bearer");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({
      error: { code: "UNAUTHENTICATED", message: "Oturum doğrulanamadı. Lütfen yeniden giriş yapın." },
    });
  });

  it("async işleyicide fırlatılan hatayı yakalar", async () => {
    const { app } = setup();
    const res = await request(app).get("/forbidden").expect(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(res.headers["www-authenticate"]).toBeUndefined();
  });

  it("429'da Retry-After başlığı ve retryAfterSeconds aynı tam sayıdır", async () => {
    const { app } = setup();
    const res = await request(app).get("/rate-limited").expect(429);
    expect(res.headers["retry-after"]).toBe("13");
    expect(res.body.error).toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 13 });
  });

  it("bozuk JSON, büyük gövde ve Zod hatası 400 INVALID_PAYLOAD olur", async () => {
    const { app, log } = setup();
    const broken = await request(app).post("/validated")
      .set("Content-Type", "application/json").send("{bozuk").expect(400);
    expect(broken.body.error.code).toBe("INVALID_PAYLOAD");

    const large = await request(app).post("/validated").send({ code: "1".repeat(2000) }).expect(400);
    expect(large.body.error.code).toBe("INVALID_PAYLOAD");

    const invalid = await request(app).post("/validated").send({ code: "abc" }).expect(400);
    expect(invalid.body.error.code).toBe("INVALID_PAYLOAD");
    expect(JSON.stringify(invalid.body)).not.toContain("abc");
    expect(log).not.toHaveBeenCalled();
  });

  it("beklenmeyen hatada ayrıntı sızdırmaz ve sunucu tarafında loglar", async () => {
    const { app, log } = setup();
    const res = await request(app).get("/crash").expect(500);
    expect(res.body).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "Beklenmeyen bir hata oluştu. Lütfen daha sonra tekrar deneyin.",
      },
    });
    expect(res.text).not.toContain("s3cr3t");
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain("s3cr3t");
  });

  it("503'te asıl nedeni loglar, istemciye göstermez", async () => {
    const { app, log } = setup();
    const res = await request(app).get("/unavailable").expect(503);
    expect(res.body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(res.text).not.toContain("redis");
    expect(String(log.mock.calls[0]?.[0])).toContain("redis down");
  });

  it("eşleşmeyen yol 404 NOT_FOUND döner", async () => {
    const { app } = setup();
    const res = await request(app).get("/yok").expect(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});

describe("AppError", () => {
  it("RATE_LIMITED dışındaki kodlarda retryAfterSeconds taşımaz", () => {
    expect(new AppError("FORBIDDEN", { retryAfterSeconds: 5 }).toJSON()).toEqual({
      code: "FORBIDDEN",
      message: "Bu işlem için yetkiniz yok.",
    });
  });

  it("geçersiz retryAfterSeconds değerini en az 1 saniyeye çeker", () => {
    expect(new AppError("RATE_LIMITED").retryAfterSeconds).toBe(1);
    expect(new AppError("RATE_LIMITED", { retryAfterSeconds: Number.NaN }).retryAfterSeconds).toBe(1);
    expect(new AppError("RATE_LIMITED", { retryAfterSeconds: -4 }).retryAfterSeconds).toBe(1);
  });
});
