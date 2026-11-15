// TR: Gerçek imzalı JWT; test anahtarları üretime taşınmaz. EN: Real JWT signatures with test-only keys.
import express from "express";
import request from "supertest";
import { SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { createSupportHttpPrincipalResolver, createSupportJwtVerifier } from "../../src/modules/support/support-auth.js";
import { decodeSupportMessageKey } from "../../src/modules/support/support-runtime.js";
import { createSupportRouter } from "../../src/modules/support/support.routes.js";
import { makeHandoffFixture } from "./helpers/handoff.fixture.js";

const key = new Uint8Array(32).fill(9);
async function token(overrides: Record<string, unknown> = {}, signingKey = key, algorithm = "HS256", typ = "at+jwt") {
  const time = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: "user_1", role: "user", exp: time + 120, iat: time, jti: "token_1",
    iss: "kalkan-test", aud: "support-test", ...overrides }).setProtectedHeader({ alg: algorithm, typ }).sign(signingKey);
}
function setup() {
  const isActive = vi.fn(async () => true);
  const verify = createSupportJwtVerifier({ key, issuer: "kalkan-test", audience: "support-test", isActive });
  return { verify, isActive, signal: new AbortController().signal };
}
describe("Support auth integration", () => {
  it("validates signatures/claims and converts expiry to milliseconds", async () => {
    const f = setup();
    const result = await f.verify(await token(), { signal: f.signal });
    expect(result).toMatchObject({ userId: "user_1", role: "user" });
    expect(f.isActive).toHaveBeenCalledWith({ userId: "user_1", role: "user", tokenId: "token_1" }, f.signal);
  });
  it.each([{ iss: "other" }, { aud: "other" }, { exp: 1 }, { role: "owner" }, { sub: "../user" },
    { jti: "" }, { iat: Math.floor(Date.now() / 1000) + 60 }, { exp: 999999999999999 }, { nbf: 9999999999 }])(
    "rejects invalid claims %j", async (claims) => {
      const f = setup();
      expect(await f.verify(await token(claims), { signal: f.signal })).toBeNull();
      expect(f.isActive).not.toHaveBeenCalled();
    });
  it("rejects wrong signature, algorithm and token type", async () => {
    const f = setup();
    for (const value of [await token({}, new Uint8Array(32).fill(8)),
      await token({}, key, "HS384"), await token({}, key, "HS256", "JWT"), "not.jwt"]) {
      expect(await f.verify(value, { signal: f.signal })).toBeNull();
    }
  });
  it("rejects revoked tokens and propagates account-store failures", async () => {
    const f = setup();
    f.isActive.mockResolvedValueOnce(false);
    expect(await f.verify(await token(), { signal: f.signal })).toBeNull();
    f.isActive.mockRejectedValueOnce(new Error("private-database"));
    await expect(f.verify(await token(), { signal: f.signal })).rejects.toThrow("private-database");
    const controller = new AbortController();
    controller.abort();
    await expect(f.verify(await token(), { signal: controller.signal })).rejects.toThrow();
  });
  it("shares verification with HTTP and ignores query credentials", async () => {
    const f = setup();
    const fixture = makeHandoffFixture();
    const app = express();
    app.use("/support", createSupportRouter({ service: fixture.service,
      resolvePrincipal: createSupportHttpPrincipalResolver(f.verify) }));
    const jwt = await token();
    await request(app).post("/support/handoffs").set("Authorization", `Bearer ${jwt}`)
      .send({ conversationId: "chat_1" }).expect(201);
    await request(app).post("/support/handoffs").query({ token: jwt }).send({ conversationId: "chat_1" }).expect(401);
    await request(app).post("/support/handoffs").set("Authorization", `Basic ${jwt}`).send({ conversationId: "chat_1" }).expect(401);
  });
  it("bounds an unresponsive HTTP verifier and cancels it", async () => {
    const fixture = makeHandoffFixture();
    let signal: AbortSignal | undefined;
    const app = express();
    app.use("/support", createSupportRouter({ service: fixture.service,
      resolvePrincipal: createSupportHttpPrincipalResolver(async (_token, context) => {
        signal = context.signal;
        return new Promise(() => {});
      }, 50) }));
    const result = await request(app).post("/support/handoffs").set("Authorization", "Bearer test")
      .send({ conversationId: "chat_1" }).expect(503);
    expect(result.body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(signal?.aborted).toBe(true);
  });
  it("requires canonical base64 and at least 32 bytes for message keys", () => {
    const encoded = Buffer.from(key).toString("base64");
    expect(decodeSupportMessageKey(encoded)).toEqual(Buffer.from(key));
    for (const bad of ["", "short", encoded + " ", "!!!!", Buffer.alloc(8).toString("base64")]) {
      expect(() => decodeSupportMessageKey(bad)).toThrow(TypeError);
    }
  });
});
