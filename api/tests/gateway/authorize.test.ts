// authorize.ts rol kontrolünü sınar; token'lar yalnızca test değeridir.
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createAuthentication } from "../../src/middlewares/authenticate.js";
import { authorize } from "../../src/middlewares/authorize.js";
import { createErrorHandler } from "../../src/middlewares/errorHandler.js";

const NOW = 1_800_000_000_000;

function setup() {
  const tokens: Record<string, unknown> = {
    "user-token": { userId: "user_1", role: "user", expiresAt: NOW + 60_000 },
    "expert-token": { userId: "expert_1", role: "expert", expiresAt: NOW + 60_000 },
    "admin-token": { userId: "admin_1", role: "admin", expiresAt: NOW + 60_000 },
  };
  const { authenticate } = createAuthentication({
    verifyAccessToken: async (token) => tokens[token] ?? null,
    now: () => NOW,
  });
  const app = express();
  app.get("/uzman", authenticate, authorize("expert"), (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/uzman-veya-admin", authenticate, authorize("expert", "admin"), (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/authenticate-unutulmus", authorize("admin"), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(createErrorHandler({ log: () => {} }));
  return app;
}

describe("authorize", () => {
  it("izin verilen rol geçer", async () => {
    await request(setup()).get("/uzman").set("Authorization", "Bearer expert-token").expect(200);
  });

  it("izin verilmeyen rol 403 FORBIDDEN alır", async () => {
    const res = await request(setup()).get("/uzman")
      .set("Authorization", "Bearer user-token").expect(403);
    expect(res.body).toEqual({
      error: { code: "FORBIDDEN", message: "Bu işlem için yetkiniz yok." },
    });
    expect(res.headers["www-authenticate"]).toBeUndefined();
  });

  it("admin rolü kendiliğinden uzman yetkisi vermez", async () => {
    await request(setup()).get("/uzman").set("Authorization", "Bearer admin-token").expect(403);
  });

  it("birden fazla rol listelenebilir", async () => {
    const app = setup();
    await request(app).get("/uzman-veya-admin").set("Authorization", "Bearer admin-token").expect(200);
    await request(app).get("/uzman-veya-admin").set("Authorization", "Bearer expert-token").expect(200);
    await request(app).get("/uzman-veya-admin").set("Authorization", "Bearer user-token").expect(403);
  });

  it("token yoksa rol kontrolünden önce 401 döner", async () => {
    const res = await request(setup()).get("/uzman").expect(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("authenticate unutulursa geçirmez, 401 döner", async () => {
    await request(setup()).get("/authenticate-unutulmus")
      .set("Authorization", "Bearer admin-token").expect(401);
  });
});
