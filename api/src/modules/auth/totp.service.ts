/**
 * Amir Ali — TOTP ile iki adımlı doğrulama (2FA), RFC 6238.
 * Kod üretimi ve doğrulaması Node'un yerleşik crypto modülüyle yapılır; ek kütüphane yoktur.
 * Gizli anahtarlar veritabanına AES-256-GCM ile şifrelenmiş olarak yazılır; düz hali loglanmaz.
 * Kalıcı depo (TwoFactorStore) Eren'in Prisma şeması hazır olduğunda uygulanır.
 * HTTP yolları Buse'nin auth.routes.ts dosyasında bu servisi çağırır (docs/api/openapi.yaml).
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "../../middlewares/errorHandler.js";

const ISSUER = "Kalkan";
const STEP_SECONDS = 30;
const DIGITS = 6;
// Saat kayması için bir önceki ve bir sonraki 30 saniyelik adım da kabul edilir.
const ALLOWED_DRIFT_STEPS = 1;
const SECRET_BYTES = 20;
const PENDING_SETUP_MS = 10 * 60_000;
const CODE_PATTERN = /^[0-9]{6}$/;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const CIPHER_PREFIX = "v1:";

/** Kullanıcının 2FA kaydı. Gizli anahtarlar yalnızca şifreli halde tutulur. */
export interface TwoFactorRecord {
  enabled: boolean;
  /** Açık 2FA'nın şifreli gizli anahtarı. */
  secret: string | null;
  /** Kurulumu bekleyen şifreli gizli anahtar. */
  pendingSecret: string | null;
  /** Bekleyen kurulumun son geçerlilik anı (Unix milisaniyesi). */
  pendingExpiresAt: number | null;
  /** Son kabul edilen kodun zaman adımı; aynı kodun tekrar kullanılmasını engeller. */
  lastUsedStep: number | null;
  /** Eşzamanlı yazmaları ayırt etmek için her kayıtta artan sürüm. */
  version: number;
}

/**
 * Kalıcı depo (Eren, Prisma). save atomik olmalıdır: kayıt hâlâ expectedVersion sürümündeyse
 * (yeni kayıtta null: kayıt yoksa) yazar ve true döner; araya başka bir yazma girdiyse false döner.
 * Böylece aynı kodla eşzamanlı iki istekten yalnızca biri kabul edilir.
 */
export interface TwoFactorStore {
  find(userId: string): Promise<TwoFactorRecord | null>;
  save(userId: string, record: TwoFactorRecord, expectedVersion: number | null): Promise<boolean>;
}

export interface TotpServiceOptions {
  store: TwoFactorStore;
  /** 32 baytlık AES-256 anahtarı (TOTP_ENCRYPTION_KEY). */
  encryptionKey: Buffer;
  /** Testler için saat. */
  now?: () => number;
}

export interface TwoFactorSetup {
  /** Base32 gizli anahtar; yalnızca bu yanıtta bir kez gösterilir. */
  secret: string;
  otpauthUrl: string;
  /** ISO 8601 zaman damgası. */
  expiresAt: string;
}

export interface TotpService {
  isEnabled(userId: string): Promise<boolean>;
  /** accountLabel kimlik doğrulama uygulamasında görünen ad (ör. e-posta). */
  startSetup(userId: string, accountLabel: string): Promise<TwoFactorSetup>;
  enable(userId: string, code: string): Promise<void>;
  disable(userId: string, code: string): Promise<void>;
  /**
   * Girişin ikinci adımı (Buse'nin /auth/2fa/verify yolu). Kod geçerliyse true döner.
   * Hangi bilginin yanlış olduğu istemciye açıklanmasın diye hata fırlatmaz.
   */
  verifyLogin(userId: string, code: string): Promise<boolean>;
}

export function encodeBase32(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/** Belirli bir zaman adımı için RFC 6238 / RFC 4226 kodu üretir (HMAC-SHA1, 6 hane). */
export function generateTotp(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", secret).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function timeStep(timestampMs: number): number {
  return Math.floor(timestampMs / 1000 / STEP_SECONDS);
}

function codesEqual(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Kodu ±1 adım içinde arar; lastUsedStep ve öncesindeki adımlar kabul edilmez (tekrar kullanım).
 * Eşleşen adımı, yoksa null döner.
 */
function matchStep(secret: Buffer, code: string, now: number, lastUsedStep: number | null): number | null {
  if (!CODE_PATTERN.test(code)) return null;
  const current = timeStep(now);
  for (let drift = -ALLOWED_DRIFT_STEPS; drift <= ALLOWED_DRIFT_STEPS; drift += 1) {
    const step = current + drift;
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    if (codesEqual(generateTotp(secret, step), code)) return step;
  }
  return null;
}

function encryptSecret(key: Buffer, secret: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(secret), cipher.final()]);
  return CIPHER_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

function decryptSecret(key: Buffer, stored: string): Buffer {
  if (!stored.startsWith(CIPHER_PREFIX)) throw new Error("Bilinmeyen gizli anahtar biçimi");
  const raw = Buffer.from(stored.slice(CIPHER_PREFIX.length), "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
}

function emptyRecord(): TwoFactorRecord {
  return {
    enabled: false,
    secret: null,
    pendingSecret: null,
    pendingExpiresAt: null,
    lastUsedStep: null,
    version: 0,
  };
}

export function createTotpService(options: TotpServiceOptions): TotpService {
  if (options.encryptionKey.length !== 32) {
    throw new RangeError("TOTP şifreleme anahtarı 32 bayt olmalıdır.");
  }
  const { store, encryptionKey: key } = options;
  const now = options.now ?? Date.now;

  async function load(userId: string): Promise<{ record: TwoFactorRecord; expected: number | null }> {
    const record = await store.find(userId);
    return record ? { record, expected: record.version } : { record: emptyRecord(), expected: null };
  }

  // Araya başka bir yazma girdiyse (ör. aynı kodla eşzamanlı istek) işlem reddedilir.
  async function save(userId: string, next: TwoFactorRecord, expected: number | null, onConflict: AppError) {
    const saved = await store.save(userId, { ...next, version: (expected ?? 0) + 1 }, expected);
    if (!saved) throw onConflict;
  }

  return {
    async isEnabled(userId) {
      return (await store.find(userId))?.enabled ?? false;
    },

    async startSetup(userId, accountLabel) {
      const { record, expected } = await load(userId);
      if (record.enabled) throw new AppError("TWO_FACTOR_ALREADY_ENABLED");

      const secret = randomBytes(SECRET_BYTES);
      const expiresAt = now() + PENDING_SETUP_MS;
      await save(userId, {
        ...record,
        pendingSecret: encryptSecret(key, secret),
        pendingExpiresAt: expiresAt,
      }, expected, new AppError("SERVICE_UNAVAILABLE"));

      const base32 = encodeBase32(secret);
      const label = encodeURIComponent(`${ISSUER}:${accountLabel}`);
      const params = new URLSearchParams({
        secret: base32,
        issuer: ISSUER,
        algorithm: "SHA1",
        digits: String(DIGITS),
        period: String(STEP_SECONDS),
      });
      return {
        secret: base32,
        otpauthUrl: `otpauth://totp/${label}?${params.toString()}`,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    },

    async enable(userId, code) {
      const { record, expected } = await load(userId);
      if (record.enabled) throw new AppError("TWO_FACTOR_ALREADY_ENABLED");
      if (record.pendingSecret === null || record.pendingExpiresAt === null || record.pendingExpiresAt <= now()) {
        throw new AppError("TWO_FACTOR_SETUP_REQUIRED");
      }
      const step = matchStep(decryptSecret(key, record.pendingSecret), code, now(), null);
      if (step === null) throw new AppError("INVALID_TOTP_CODE");

      await save(userId, {
        ...record,
        enabled: true,
        secret: record.pendingSecret,
        pendingSecret: null,
        pendingExpiresAt: null,
        lastUsedStep: step,
      }, expected, new AppError("INVALID_TOTP_CODE"));
    },

    async disable(userId, code) {
      const { record, expected } = await load(userId);
      if (!record.enabled || record.secret === null) throw new AppError("TWO_FACTOR_NOT_ENABLED");
      const step = matchStep(decryptSecret(key, record.secret), code, now(), record.lastUsedStep);
      if (step === null) throw new AppError("INVALID_TOTP_CODE");

      // Kapatınca gizli anahtar silinir; tekrar açmak için kurulum baştan yapılır.
      await save(userId, emptyRecord(), expected, new AppError("INVALID_TOTP_CODE"));
    },

    async verifyLogin(userId, code) {
      const { record, expected } = await load(userId);
      if (!record.enabled || record.secret === null) return false;
      const step = matchStep(decryptSecret(key, record.secret), code, now(), record.lastUsedStep);
      if (step === null) return false;
      return store.save(userId, { ...record, lastUsedStep: step, version: record.version + 1 }, expected);
    },
  };
}
