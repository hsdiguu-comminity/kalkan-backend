// Amir Ali — İstek sınırlama (sabit pencere). Uyarı: varsayılan bellek içi depo yalnızca tek
// süreçte doğru sayar; birden fazla API kopyası çalışırsa Redis tabanlı bir RateLimitStore
// gerekir (Redis henüz kurulmadı).
import type { Request, RequestHandler } from "express";
import { getPrincipal } from "./authenticate.js";
import { AppError } from "./errorHandler.js";

export interface RateLimitHit {
  /** Bu istek dahil. */
  count: number;
  /** Unix milisaniyesi. */
  resetAt: number;
}

export interface RateLimitStore {
  increment(key: string, windowMs: number, now: number): Promise<RateLimitHit>;
}

export type RateLimitKey = (request: Request) => string;

// Proxy arkasında app.set("trust proxy") ayarlanmazsa tüm kullanıcılar proxy'nin IP'si sayılır.
export const byIp: RateLimitKey = (request) => `ip:${request.ip ?? "bilinmiyor"}`;

// Kullanıcıya göre sayması için authenticate bu middleware'den önce çalışmalıdır; yoksa IP'ye düşer.
export const byUserOrIp: RateLimitKey = (request) => {
  try {
    return `user:${getPrincipal(request).userId}`;
  } catch {
    return byIp(request);
  }
};

export interface RateLimitOptions {
  /** Anahtara eklenir; aynı depoyu paylaşan sınırlayıcıların sayaçları karışmasın diye. */
  name: string;
  limit: number;
  windowMs: number;
  key?: RateLimitKey;
  /** Verilmezse her sınırlayıcının kendi bellek deposu olur. */
  store?: RateLimitStore;
  now?: () => number;
}

// Temizlik zamanlayıcıyla değil istek geldikçe yapılır; zamanlayıcı süreci açık kalmaya zorlardı.
export function createMemoryStore(): RateLimitStore {
  const hits = new Map<string, RateLimitHit>();
  let nextSweepAt = 0;

  return {
    async increment(key, windowMs, now) {
      if (now >= nextSweepAt) {
        for (const [storedKey, hit] of hits) {
          if (hit.resetAt <= now) hits.delete(storedKey);
        }
        nextSweepAt = now + windowMs;
      }
      const current = hits.get(key);
      if (!current || current.resetAt <= now) {
        const hit = { count: 1, resetAt: now + windowMs };
        hits.set(key, hit);
        return { ...hit };
      }
      current.count += 1;
      return { ...current };
    },
  };
}

// Depo hata verirse istek geçirilmez (503): 2FA gibi hassas uç noktalarda sınır sessizce kalkmasın.
export function createRateLimit(options: RateLimitOptions): RequestHandler {
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new RangeError("Rate limit: limit en az 1 olan bir tam sayı olmalıdır.");
  }
  if (!Number.isInteger(options.windowMs) || options.windowMs < 1000) {
    throw new RangeError("Rate limit: windowMs en az 1000 olan bir tam sayı olmalıdır.");
  }
  const key = options.key ?? byIp;
  const store = options.store ?? createMemoryStore();
  const now = options.now ?? Date.now;

  return async (request, response, next) => {
    const timestamp = now();
    let hit: RateLimitHit;
    try {
      hit = await store.increment(`${options.name}:${key(request)}`, options.windowMs, timestamp);
    } catch (error) {
      throw new AppError("SERVICE_UNAVAILABLE", { cause: error });
    }

    const resetSeconds = Math.max(1, Math.ceil((hit.resetAt - timestamp) / 1000));
    response.setHeader("RateLimit-Limit", String(options.limit));
    response.setHeader("RateLimit-Remaining", String(Math.max(0, options.limit - hit.count)));
    response.setHeader("RateLimit-Reset", String(resetSeconds));

    if (hit.count > options.limit) {
      throw new AppError("RATE_LIMITED", { retryAfterSeconds: resetSeconds });
    }
    next();
  };
}
