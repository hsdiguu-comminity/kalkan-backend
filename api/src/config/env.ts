// Amir Ali — Ortam değişkenleri. Hata mesajları yalnızca değişken adlarını içerir;
// değerler (gizli anahtarlar) asla yazılmaz.
import { z } from "zod";

export type NodeEnv = "development" | "test" | "production";

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly port: number;
  /** null yalnızca geliştirme/testte olabilir; üretimde CORS_ORIGIN zorunludur. */
  readonly corsOrigins: readonly string[] | null;
  readonly databaseUrl: string | null;
  readonly redisUrl: string | null;
  /** Henüz kullanılmıyor; Buse'nin lib/jwt.ts dosyası hazır olduğunda kullanılacak. */
  readonly jwtSecret: string | null;
  readonly totpEncryptionKey: Buffer | null;
  readonly services: Readonly<{ ai: string; data: string; tools: string }>;
}

export class EnvValidationError extends Error {
  constructor(readonly variables: readonly string[]) {
    super(`Geçersiz veya eksik ortam değişkenleri: ${variables.join(", ")}`);
    this.name = "EnvValidationError";
  }
}

// Yalnızca geliştirme/test varsayılanları; portlar README'deki yerel kurulumla aynıdır.
const DEV_SERVICE_URLS = {
  ai: "http://localhost:8002",
  data: "http://localhost:8003",
  tools: "http://localhost:8001",
} as const;

const REQUIRED_IN_PRODUCTION = [
  "CORS_ORIGIN",
  "DATABASE_URL",
  "REDIS_URL",
  "JWT_SECRET",
  "TOTP_ENCRYPTION_KEY",
  "AI_SERVICE_URL",
  "DATA_SERVICE_URL",
  "TOOLS_SERVICE_URL",
] as const;

// .env.example'daki "JWT_SECRET=" gibi boş değerler tanımsız sayılır.
function emptyToUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

function optional<T extends z.ZodType>(schema: T) {
  return z.preprocess(emptyToUndefined, schema.optional());
}

function urlWithProtocols(protocols: readonly string[]) {
  return z.string().refine((value) => {
    try {
      return protocols.includes(new URL(value).protocol);
    } catch {
      return false;
    }
  });
}

// Anahtar üretmek için: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
function isBase64Key(value: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, "base64").length === 32;
}

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.origin === value;
  } catch {
    return false;
  }
}

const envSchema = z.object({
  NODE_ENV: z.preprocess(
    emptyToUndefined,
    z.enum(["development", "test", "production"]).default("development"),
  ),
  PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(65_535).default(3000)),
  CORS_ORIGIN: optional(
    z.string().refine((value) => value.split(",").every((origin) => isOrigin(origin.trim()))),
  ),
  DATABASE_URL: optional(urlWithProtocols(["postgresql:", "postgres:"])),
  REDIS_URL: optional(urlWithProtocols(["redis:", "rediss:"])),
  JWT_SECRET: optional(z.string().min(32)),
  TOTP_ENCRYPTION_KEY: optional(z.string().refine(isBase64Key)),
  AI_SERVICE_URL: optional(urlWithProtocols(["http:", "https:"])),
  DATA_SERVICE_URL: optional(urlWithProtocols(["http:", "https:"])),
  TOOLS_SERVICE_URL: optional(urlWithProtocols(["http:", "https:"])),
});

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const names = new Set(parsed.error.issues.map((issue) => String(issue.path[0])));
    throw new EnvValidationError([...names].sort());
  }
  const env = parsed.data;

  if (env.NODE_ENV === "production") {
    const missing = REQUIRED_IN_PRODUCTION.filter((name) => env[name] === undefined);
    if (missing.length > 0) throw new EnvValidationError(missing);
  }

  const corsOrigins = env.CORS_ORIGIN === undefined
    ? null
    : Object.freeze(env.CORS_ORIGIN.split(",").map((origin) => origin.trim()));

  return Object.freeze({
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    corsOrigins,
    databaseUrl: env.DATABASE_URL ?? null,
    redisUrl: env.REDIS_URL ?? null,
    jwtSecret: env.JWT_SECRET ?? null,
    totpEncryptionKey: env.TOTP_ENCRYPTION_KEY === undefined
      ? null
      : Buffer.from(env.TOTP_ENCRYPTION_KEY, "base64"),
    services: Object.freeze({
      ai: env.AI_SERVICE_URL ?? DEV_SERVICE_URLS.ai,
      data: env.DATA_SERVICE_URL ?? DEV_SERVICE_URLS.data,
      tools: env.TOOLS_SERVICE_URL ?? DEV_SERVICE_URLS.tools,
    }),
  });
}
