/**
 * Amir Ali — İstek sınırlama (rate limiting) middleware'i.
 * Sabit pencere (fixed window) yöntemi: her anahtar için bir zaman penceresinde en fazla
 * `limit` istek kabul edilir; aşılırsa 429 RATE_LIMITED ve Retry-After döner.
 * Varsayılan depo bellek içidir ve yalnızca tek süreçte doğru sayar. Birden fazla API kopyası
 * çalıştırıldığında Redis tabanlı bir RateLimitStore verilmelidir (REDIS_URL hazır olduğunda).
 */
import type { Request, RequestHandler } from "express";
import { getPrincipal } from "./authenticate.js";
import { AppError } from "./errorHandler.js";

export interface RateLimitHit {
  /** Bu penceredeki istek sayısı (bu istek dahil). */
  count: number;
  /** Pencerenin bittiği an (Unix milisaniyesi). */
  resetAt: number;
}

/** Sayaç deposu. Redis adaptörü aynı arayüzü uygulayarak bellek deposunun yerine geçer. */
export interface RateLimitStore {
  increment(key: string, windowMs: number, now: number): Promise<RateLimitHit>;
}

/** İsteği kime sayacağımızı belirler (IP, kullanıcı vb.). */
export type RateLimitKey = (request: Request) => string;

/** İstemci IP adresine göre sayar. Proxy arkasında doğru IP için app.set("trust proxy") gerekir. */
export const byIp: RateLimitKey = (request) => `ip:${request.ip ?? "bilinmiyor"}`;

/**
 * Giriş yapılmışsa kullanıcıya, yapılmamışsa IP adresine göre sayar.
 * Kullanıcıya göre saymak için authenticate bu middleware'den önce çalışmalıdır.
 */
export const byUserOrIp: RateLimitKey = (request) => {
  try {
    return `user:${getPrincipal(request).userId}`;
  } catch {
    return byIp(request);
  }
};

export interface RateLimitOptions {
  /** Sınırlayıcının adı; farklı sınırlayıcıların sayaçları karışmasın diye anahtara eklenir. */
  name: string;
  /** Pencere başına izin verilen istek sayısı. */
  limit: number;
  /** Pencere süresi (milisaniye). */
  windowMs: number;
  /** Varsayılan: byIp. */
  key?: RateLimitKey;
  /** Varsayılan: bellek içi depo (her sınırlayıcıya ayrı). */
  store?: RateLimitStore;
  /** Testler için saat. */
  now?: () => number;
}

/**
 * Bellek içi sayaç deposu. Süresi dolan kayıtlar zamanlayıcı kullanmadan, istek geldikçe
 * en fazla pencere başına bir kez temizlenir; böylece süreç açık kalmaya zorlanmaz.
 */
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

/**
 * Sınırlayıcı middleware üretir. Yanıta RateLimit-Limit, RateLimit-Remaining ve
 * RateLimit-Reset (saniye) başlıklarını ekler. Depo hata verirse istek geçirilmez (503):
 * 2FA gibi hassas uç noktalarda sınırın sessizce kalkmasını önlemek için.
 *
 * @example
 * app.use(createRateLimit({ name: "genel", limit: 300, windowMs: 60_000 }));
 * router.post("/2fa/verify", createRateLimit({ name: "2fa-dogrulama", limit: 5, windowMs: 5 * 60_000 }), handler);
 */
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
