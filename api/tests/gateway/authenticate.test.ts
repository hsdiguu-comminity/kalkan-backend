// authenticate.ts'yi sahte bir doğrulama adaptörüyle sınar; token'lar yalnızca test değeridir.
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  createAuthentication,
  getPrincipal,
  type AccessTokenVerifier,
} from "../../src/middlewares/authenticate.js";
import { createErrorHandler } from "../../src/middlewares/errorHandler.js";
import { validateSupportActor } from "../../src/modules/support/handoff.service.js";

const NOW = 1_800_000_000_000;
const user = { userId: "user_1", role: "user", expiresAt: NOW + 60_000 } as const;

function setup(verifier?: AccessTokenVerifier, timeoutMs = 1000) {
  const verifyAccessToken = vi.fn<AccessTokenVerifier>(verifier ?? (async (token) => {
    const tokens: Record<string, unknown> = {
      "gecerli-token": user,
      "suresi-dolmus": { ...user, expiresAt: NOW - 1 },
      "bozuk-cikti": { ...user, role: "superadmin" },
    };
    return tokens[token] ?? null;
  }));
  const auth = createAuthentication({ verifyAccessToken, timeoutMs, now: () => NOW });
  const log = vi.fn();
  const app = express();
  app.get("/profil", auth.authenticate, (req, res) => {
    res.json(getPrincipal(req));
  });
  app.get("/korumasiz", (req, res) => {
    res.json(getPrincipal(req));
  });
  app.use(createErrorHandler({ log }));
  return { app, auth, verifyAccessToken, log };
}

describe("authenticate", () => {
  it("geçerli Bearer token ile kullanıcıyı isteğe bağlar", async () => {
    const { app, verifyAccessToken } = setup();
    const res = await request(app).get("/profil")
      .set("Authorization", "Bearer gecerli-token").expect(200);
    expect(res.body).toEqual(user);
    expect(verifyAccessToken).toHaveBeenCalledWith("gecerli-token", { signal: expect.any(AbortSignal) });
  });

  it("şema büyük/küçük harf duyarsızdır", async () => {
    const { app } = setup();
    await request(app).get("/profil").set("Authorization", "bearer gecerli-token").expect(200);
  });

  it.each([
    ["başlık yok", undefined],
    ["Basic şeması", "Basic dXNlcjpwYXNz"],
    ["boş token", "Bearer "],
    ["boşluk içeren token", "Bearer a b"],
    ["geçersiz token", "Bearer bilinmeyen"],
    ["süresi dolmuş token", "Bearer suresi-dolmus"],
  ])("%s → 401 UNAUTHENTICATED", async (_name, header) => {
    const { app } = setup();
    const req = request(app).get("/profil");
    if (header !== undefined) req.set("Authorization", header);
    const res = await req.expect(401);
    expect(res.headers["www-authenticate"]).toBe("Bearer");
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("token'ı sorgu parametresinden kabul etmez", async () => {
    const { app, verifyAccessToken } = setup();
    await request(app).get("/profil?token=gecerli-token").expect(401);
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  it("adaptör hata fırlatırsa 503 döner ve nedeni loglar", async () => {
    const { app, log } = setup(async () => {
      throw new Error("jwt servisi kapalı");
    });
    const res = await request(app).get("/profil").set("Authorization", "Bearer x").expect(503);
    expect(res.body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(String(log.mock.calls[0]?.[0])).toContain("jwt servisi kapalı");
  });

  it("adaptör zaman aşımına uğrarsa 503 döner ve signal iptal edilir", async () => {
    let signal: AbortSignal | undefined;
    const { app } = setup((_token, context) => {
      signal = context.signal;
      return new Promise(() => {});
    }, 30);
    const res = await request(app).get("/profil").set("Authorization", "Bearer x").expect(503);
    expect(res.body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(signal?.aborted).toBe(true);
  });

  it("adaptör beklenmeyen şekil döndürürse 500 döner", async () => {
    const { app } = setup();
    const res = await request(app).get("/profil")
      .set("Authorization", "Bearer bozuk-cikti").expect(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
    expect(res.text).not.toContain("superadmin");
  });

  it("authenticate olmadan getPrincipal çağrılırsa 401 fırlatır", async () => {
    const { app } = setup();
    await request(app).get("/korumasiz").set("Authorization", "Bearer gecerli-token").expect(401);
  });
});

describe("resolvePrincipal", () => {
  it("token yoksa null, geçerliyse kullanıcıyı döner; adaptörü istek başına bir kez çağırır", async () => {
    const { auth, verifyAccessToken } = setup();
    const app = express();
    app.get("/", auth.authenticate, async (req, res) => {
      res.json(await auth.resolvePrincipal(req));
    });
    app.get("/anonim", async (req, res) => {
      res.json({ principal: await auth.resolvePrincipal(req) });
    });
    const res = await request(app).get("/").set("Authorization", "Bearer gecerli-token").expect(200);
    expect(res.body).toEqual(user);
    expect(verifyAccessToken).toHaveBeenCalledTimes(1);
    const anon = await request(app).get("/anonim").expect(200);
    expect(anon.body).toEqual({ principal: null });
  });

  it("çıktısı Hasti'nin destek router'ının beklediği aktör şemasına uyar", async () => {
    const { auth } = setup();
    const app = express();
    app.get("/", async (req, res) => {
      res.json(validateSupportActor(await auth.resolvePrincipal(req), NOW));
    });
    const res = await request(app).get("/").set("Authorization", "Bearer gecerli-token").expect(200);
    expect(res.body).toEqual(user);
  });
});
