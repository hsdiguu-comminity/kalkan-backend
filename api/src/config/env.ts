/**
 * Amir Ali — Ortam değişkenlerini uygulama başlarken Zod ile doğrular.
 * Hata mesajları yalnızca değişken adlarını içerir; değerler (gizli anahtarlar) asla yazılmaz.
 */
import { z } from "zod";

export type NodeEnv = "development" | "test" | "production";

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly port: number;
  /**
   * İzin verilen tarayıcı origin'leri. null: tanımlı değil (yalnızca geliştirme/test).
   */
  readonly corsOrigins: readonly string[] | null;
  readonly databaseUrl: string | null;
  readonly redisUrl: string | null;
  /** JWT imzalama anahtarı; Buse'nin lib/jwt.ts dosyası kullanır. */
  readonly jwtSecret: string | null;
  readonly services: Readonly<{ ai: string; data: string; tools: string }>;
}

/**
 * Eksik/geçersiz değişkenlerin yalnızca adlarını taşır.
 */
export class EnvValidationError extends Error {
  constructor(readonly variables: readonly string[]) {
    super(`Geçersiz veya eksik ortam değişkenleri: ${variables.join(", ")}`);
    this.name = "EnvValidationError";
  }
}

// Yerel geliştirmede servis adresleri (README ve docker-compose portları).
const DEV_SERVICE_URLS = {
  ai: "http://localhost:8002",
  data: "http://localhost:8003",
  tools: "http://localhost:8001",
} as const;

// Üretimde boş bırakılamayan değişkenler.
const REQUIRED_IN_PRODUCTION = [
  "CORS_ORIGIN",
  "DATABASE_URL",
  "REDIS_URL",
  "JWT_SECRET",
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
  AI_SERVICE_URL: optional(urlWithProtocols(["http:", "https:"])),
  DATA_SERVICE_URL: optional(urlWithProtocols(["http:", "https:"])),
  TOOLS_SERVICE_URL: optional(urlWithProtocols(["http:", "https:"])),
});

/**
 * Ortam değişkenlerini okur, doğrular ve dondurulmuş yapılandırma döndürür.
 * Uygulama girişinde (index.ts) bir kez çağrılır; testlerde kaynak verilebilir.
 * @throws {EnvValidationError} Eksik veya geçersiz değişken varsa.
 */
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
    services: Object.freeze({
      ai: env.AI_SERVICE_URL ?? DEV_SERVICE_URLS.ai,
      data: env.DATA_SERVICE_URL ?? DEV_SERVICE_URLS.data,
      tools: env.TOOLS_SERVICE_URL ?? DEV_SERVICE_URLS.tools,
    }),
  });
}
