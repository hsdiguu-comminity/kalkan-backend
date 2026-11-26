// config/env.ts doğrulamasını sınar; buradaki anahtarlar yalnızca test değeridir.
import { describe, expect, it } from "vitest";
import { EnvValidationError, loadEnv } from "../../src/config/env.js";

const TEST_SECRET = "test-secret-0123456789-abcdefghijkl";

const productionEnv = {
  NODE_ENV: "production",
  PORT: "8080",
  CORS_ORIGIN: "https://kalkan.example, https://admin.kalkan.example",
  DATABASE_URL: "postgresql://user:pass@db:5432/kalkan",
  REDIS_URL: "redis://redis:6379",
  JWT_SECRET: TEST_SECRET,
  AI_SERVICE_URL: "http://ai:8002",
  DATA_SERVICE_URL: "http://data:8003",
  TOOLS_SERVICE_URL: "http://tools:8001",
};

function captureError(source: NodeJS.ProcessEnv): EnvValidationError {
  try {
    loadEnv(source);
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  throw new Error("loadEnv hata fırlatmadı");
}

describe("loadEnv", () => {
  it("boş ortamda geliştirme varsayılanlarını döner", () => {
    const config = loadEnv({});
    expect(config).toEqual({
      nodeEnv: "development",
      port: 3000,
      corsOrigins: null,
      databaseUrl: null,
      redisUrl: null,
      jwtSecret: null,
      services: {
        ai: "http://localhost:8002",
        data: "http://localhost:8003",
        tools: "http://localhost:8001",
      },
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.services)).toBe(true);
  });

  it(".env.example'daki gibi boş değerleri tanımsız sayar", () => {
    const config = loadEnv({ PORT: "", JWT_SECRET: "", DATABASE_URL: "  ", NODE_ENV: "" });
    expect(config.port).toBe(3000);
    expect(config.jwtSecret).toBeNull();
    expect(config.databaseUrl).toBeNull();
    expect(config.nodeEnv).toBe("development");
  });

  it("üretimde tüm değerleri okur ve CORS listesini ayrıştırır", () => {
    const config = loadEnv(productionEnv);
    expect(config.nodeEnv).toBe("production");
    expect(config.port).toBe(8080);
    expect(config.corsOrigins).toEqual(["https://kalkan.example", "https://admin.kalkan.example"]);
    expect(config.services.tools).toBe("http://tools:8001");
  });

  it("üretimde eksik değişkenlerin adlarını listeler", () => {
    const error = captureError({ NODE_ENV: "production", JWT_SECRET: TEST_SECRET });
    expect(error.variables).toEqual([
      "CORS_ORIGIN",
      "DATABASE_URL",
      "REDIS_URL",
      "AI_SERVICE_URL",
      "DATA_SERVICE_URL",
      "TOOLS_SERVICE_URL",
    ]);
  });

  it("geçersiz değerlerde yalnızca adları verir, değerleri asla yazmaz", () => {
    const shortSecret = "kisa-gizli-anahtar";
    const error = captureError({
      PORT: "99999",
      JWT_SECRET: shortSecret,
      DATABASE_URL: "mysql://secret-host/db",
    });
    expect(error.variables).toEqual(["DATABASE_URL", "JWT_SECRET", "PORT"]);
    expect(error.message).not.toContain(shortSecret);
    expect(error.message).not.toContain("secret-host");
    expect(error.message).not.toContain("99999");
  });

  it("bilinmeyen NODE_ENV ve sayı olmayan PORT reddedilir", () => {
    expect(captureError({ NODE_ENV: "staging" }).variables).toEqual(["NODE_ENV"]);
    expect(captureError({ PORT: "abc" }).variables).toEqual(["PORT"]);
  });

  it("yol veya sondaki / içeren CORS origin'lerini reddeder", () => {
    expect(captureError({ CORS_ORIGIN: "https://kalkan.example/" }).variables).toEqual(["CORS_ORIGIN"]);
    expect(captureError({ CORS_ORIGIN: "https://a.example,ftp://b.example" }).variables)
      .toEqual(["CORS_ORIGIN"]);
  });

  it("ilgisiz ortam değişkenlerini yok sayar", () => {
    expect(() => loadEnv({ PATH: "/usr/bin", HOME: "/home/test" })).not.toThrow();
  });
});
