// Amir Ali — Bearer token ile kimlik doğrulama. Token'ın imzası, süresi ve iptali burada değil,
// Buse'nin verifyAccessToken adaptöründe doğrulanır; o hazır olana kadar bu middleware
// hiçbir yola bağlı değildir.
import type { Request, RequestHandler } from "express";
import { z } from "zod";
import { AppError } from "./errorHandler.js";

const principalSchema = z.strictObject({
  userId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  role: z.enum(["user", "expert", "admin"]),
  // Unix milisaniyesi (JWT exp * 1000).
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

/** Kimlik ve rol yalnızca buradan alınır; body/query'deki değerlere asla güvenilmez. */
export type Principal = Readonly<z.infer<typeof principalSchema>>;
export type Role = Principal["role"];

/**
 * Buse'nin sağlayacağı adaptörle anlaşılan imza (Hasti'nin Socket.IO sunucusu da aynısını bekler):
 * geçersiz/süresi dolmuş/iptal edilmiş token'da null döner, altyapı hatasında throw eder.
 */
export type AccessTokenVerifier = (
  token: string,
  context: { signal: AbortSignal },
) => Promise<unknown>;

export interface AuthenticationOptions {
  verifyAccessToken: AccessTokenVerifier;
  /** Aşılırsa 503 SERVICE_UNAVAILABLE döner ve signal iptal edilir. */
  timeoutMs?: number;
  now?: () => number;
}

export interface Authentication {
  authenticate: RequestHandler;
  /** Hasti'nin destek router'ının beklediği imza: token yoksa veya geçersizse null döner. */
  resolvePrincipal: (request: Request) => Promise<Principal | null>;
}

const BEARER_PATTERN = /^Bearer ([^\s]{1,8192})$/i;
const DEFAULT_TIMEOUT_MS = 5000;

// İstek nesnesine bağlı doğrulama sonucu; istek bitince çöp toplayıcı temizler.
const principals = new WeakMap<Request, Principal | null>();

// authenticate çalışmadıysa 401 fırlatır; böylece unutulan bir authenticate sessizce geçmez.
export function getPrincipal(request: Request): Principal {
  const principal = principals.get(request);
  if (!principal) throw new AppError("UNAUTHENTICATED");
  return principal;
}

function readBearerToken(request: Request): string | null {
  const header = request.get("authorization");
  if (header === undefined) return null;
  const match = BEARER_PATTERN.exec(header.trim());
  return match?.[1] ?? null;
}

export function createAuthentication(options: AuthenticationOptions): Authentication {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  async function verify(token: string): Promise<Principal | null> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AppError("SERVICE_UNAVAILABLE", { cause: new Error("Token doğrulama zaman aşımı") }));
      }, timeoutMs);
    });

    let value: unknown;
    try {
      value = await Promise.race([
        options.verifyAccessToken(token, { signal: controller.signal }),
        timeout,
      ]);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("SERVICE_UNAVAILABLE", { cause: error });
    } finally {
      clearTimeout(timer);
    }

    if (value === null) return null;
    const parsed = principalSchema.safeParse(value);
    // Adaptör beklenmeyen bir şekil döndürdüyse bu bir sunucu hatasıdır; kullanıcıya 500 döner.
    if (!parsed.success) {
      throw new AppError("INTERNAL_ERROR", { cause: new Error("Geçersiz doğrulama adaptörü çıktısı") });
    }
    if (parsed.data.expiresAt <= now()) return null;
    return Object.freeze(parsed.data);
  }

  async function resolvePrincipal(request: Request): Promise<Principal | null> {
    if (principals.has(request)) return principals.get(request) ?? null;
    const token = readBearerToken(request);
    const principal = token === null ? null : await verify(token);
    principals.set(request, principal);
    return principal;
  }

  const authenticate: RequestHandler = async (request, _response, next) => {
    const principal = await resolvePrincipal(request);
    if (!principal) throw new AppError("UNAUTHENTICATED");
    next();
  };

  return { authenticate, resolvePrincipal };
}
