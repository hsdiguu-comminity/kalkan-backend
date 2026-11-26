// Amir Ali — TOTP ile 2FA (RFC 6238). Henüz kullanılmıyor: kalıcı depo (TwoFactorStore) Eren'in
// Prisma şemasını, HTTP yolları Buse'nin auth.routes.ts dosyasını bekliyor.
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

/** secret ve pendingSecret yalnızca şifreli halde tutulur; düz hali asla depoya yazılmaz. */
export interface TwoFactorRecord {
  enabled: boolean;
  secret: string | null;
  pendingSecret: string | null;
  /** Unix milisaniyesi. */
  pendingExpiresAt: number | null;
  /** Aynı kodun tekrar kullanılmasını engeller. */
  lastUsedStep: number | null;
  version: number;
}

/**
 * Eren'in uygulayacağı depo. save atomik olmalıdır: kayıt hâlâ expectedVersion sürümündeyse
 * (yeni kayıtta null) yazıp true, araya başka yazma girdiyse false döner. Bu yapılmazsa
 * aynı kod eşzamanlı iki istekte iki kez kabul edilebilir.
 */
export interface TwoFactorStore {
  find(userId: string): Promise<TwoFactorRecord | null>;
  save(userId: string, record: TwoFactorRecord, expectedVersion: number | null): Promise<boolean>;
}

export interface TotpServiceOptions {
  store: TwoFactorStore;
  encryptionKey: Buffer;
  now?: () => number;
}

export interface TwoFactorSetup {
  /** Yalnızca bu yanıtta bir kez gösterilir; sonradan tekrar alınamaz. */
  secret: string;
  otpauthUrl: string;
  expiresAt: string;
}

export interface TotpService {
  isEnabled(userId: string): Promise<boolean>;
  startSetup(userId: string, accountLabel: string): Promise<TwoFactorSetup>;
  enable(userId: string, code: string): Promise<void>;
  disable(userId: string, code: string): Promise<void>;
  /** Hata fırlatmaz: girişte hangi bilginin yanlış olduğu istemciye açıklanmamalıdır. */
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

// lastUsedStep ve öncesindeki adımlar reddedilir: aynı kod iki kez kullanılamaz.
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
