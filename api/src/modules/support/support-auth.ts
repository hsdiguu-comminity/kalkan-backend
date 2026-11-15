/** TR: HTTP ve Socket.IO aynı doğrulayıcıyı kullanır. EN: HTTP and Socket.IO share one verifier. */
import { jwtVerify } from "jose";
import type { Request } from "express";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { SupportServiceError, validateSupportActor } from "./handoff.service.js";
import type { SupportSocketOptions } from "../../sockets/index.js";

export type AccessVerifier = SupportSocketOptions["verifyAccessToken"];
export interface JwtSupportOptions {
  key: Uint8Array;
  issuer: string;
  audience: string;
  /** TR: İptal ve güncel kullanıcı/rol kontrolü zorunlu. EN: Revocation and current account checks are mandatory. */
  isActive(identity: { userId: string; role: string; tokenId: string }, signal: AbortSignal): Promise<boolean>;
}

// TR: İsteğe bağlı HS256 erişim-token adaptörü; token üretmez, auth sisteminin yerine geçmez.
// EN: Optional HS256 access-token adapter; never issues tokens or replaces the auth system.
export function createSupportJwtVerifier(options: JwtSupportOptions): AccessVerifier {
  const key = new Uint8Array(options.key);
  if (key.byteLength < 32 || !options.issuer.trim() || !options.audience.trim() || typeof options.isActive !== "function") {
    throw new TypeError("JWT anahtarı, issuer, audience ve iptal kontrolü gereklidir.");
  }
  return async (token, { signal }) => {
    signal.throwIfAborted();
    let payload;
    try {
      ({ payload } = await jwtVerify(token, key, { algorithms: ["HS256"], issuer: options.issuer,
        audience: options.audience, typ: "at+jwt", requiredClaims: ["sub", "exp", "iat", "jti", "role"] }));
    } catch { return null; }
    if (typeof payload.jti !== "string" || payload.jti.length === 0 || payload.jti.length > 256 ||
        typeof payload.iat !== "number" || !Number.isSafeInteger(payload.iat) || payload.iat > Date.now() / 1000 ||
        typeof payload.exp !== "number" || !Number.isSafeInteger(payload.exp) || payload.exp <= payload.iat) return null;
    let principal;
    try { principal = validateSupportActor({ userId: payload.sub, role: payload.role, expiresAt: payload.exp * 1000 }); }
    catch { return null; }
    signal.throwIfAborted();
    // TR: Altyapı hatası null'a çevrilmez; çağıran 503 döner. EN: Infrastructure errors propagate as unavailability.
    if (!await options.isActive({ userId: principal.userId, role: principal.role, tokenId: payload.jti }, signal)) return null;
    signal.throwIfAborted();
    return validateSupportActor(principal);
  };
}

export function createPrismaAccessCheck(prisma: PrismaClient,
  isTokenRevoked: (tokenId: string, signal: AbortSignal) => Promise<boolean>): JwtSupportOptions["isActive"] {
  if (typeof isTokenRevoked !== "function") throw new TypeError("Token iptal adaptörü gereklidir.");
  return async (identity, signal) => {
    signal.throwIfAborted();
    const user = await prisma.user.findUnique({ where: { id: identity.userId }, select: { role: true, status: true } });
    if (!user || user.status !== "active" || user.role !== identity.role) return false;
    return !await isTokenRevoked(identity.tokenId, signal);
  };
}

export function createSupportHttpPrincipalResolver(verify: AccessVerifier, timeoutMs = 5000) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30_000) throw new TypeError("Geçersiz auth timeout.");
  return async (request: Request) => {
    // TR: Query/cookie kullanılmaz, çift Authorization reddedilir. EN: No query/cookie credentials or duplicate headers.
    const headers = request.rawHeaders.filter((_, index) => index % 2 === 0);
    const match = /^Bearer ([^\s]{1,8192})$/i.exec(request.get("authorization") ?? "");
    if (!match || headers.filter((h) => h.toLowerCase() === "authorization").length !== 1) return null;
    const token = match[1]!;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    const onClose = () => { if (!request.res?.writableEnded) controller.abort(); };
    request.once("aborted", onAbort);
    request.res?.once("close", onClose);
    const timer = setTimeout(onAbort, timeoutMs);
    timer.unref();
    let rejectAbort!: () => void;
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(new SupportServiceError("SERVICE_UNAVAILABLE"));
        controller.signal.addEventListener("abort", rejectAbort, { once: true });
      });
      if (request.aborted) controller.abort();
      return await Promise.race([Promise.resolve().then(() => verify(token, { signal: controller.signal })), aborted]);
    } finally {
      clearTimeout(timer);
      request.removeListener("aborted", onAbort);
      request.res?.removeListener("close", onClose);
      controller.signal.removeEventListener("abort", rejectAbort);
      controller.abort();
    }
  };
}
