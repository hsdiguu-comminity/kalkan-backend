import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import { loadEnv, type AppConfig } from "./config/env.js";
import { createErrorHandler, notFoundHandler } from "./middlewares/errorHandler.js";
import { byIp, createRateLimit } from "./middlewares/rateLimit.js";

// Tüm API için IP başına genel sınır. Hassas uç noktalar (ör. 2FA doğrulama) kendi
// router'larında ayrıca daha sıkı bir sınır kullanır.
export const GLOBAL_RATE_LIMIT = { limit: 300, windowMs: 60_000 } as const;

// Express uygulaması. Modüller (auth, chat, support, tools, reports, stats, academy)
// kendi router'larını burada /api altında kaydeder; middleware'ler api/src/middlewares/ altındadır.
// config varsayılanı, parametresiz createApp() çağıran mevcut testler (health.test.ts) içindir.
export function createApp(config: AppConfig = loadEnv()): Express {
  const app = express();

  app.use(helmet());
  // CORS_ORIGIN tanımlı değilse (yalnızca geliştirme/test) her origin kabul edilir;
  // üretimde env.ts CORS_ORIGIN'i zorunlu tutar.
  app.use(cors({ origin: config.corsOrigins ? [...config.corsOrigins] : true, credentials: true }));

  // Sağlık kontrolü sınırın dışındadır; izleme araçları sık sorgulayabilir.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "kalkan-api" });
  });

  // Gövde ayrıştırılmadan önce sayılır; böylece sınırı aşan istekler JSON işleme maliyeti yaratmaz.
  app.use(createRateLimit({ name: "genel", key: byIp, ...GLOBAL_RATE_LIMIT }));
  app.use(express.json({ limit: "1mb" }));

  // Örnek: app.use("/api/auth", authRouter);
  // Henüz bağlı değil: authenticate (Buse'nin verifyAccessToken'ını bekliyor) ve Hasti'nin destek
  // router'ı. Destek router'ı express.json'dan ÖNCE bağlanmalıdır; yoksa gövde burada ayrıştırılır
  // ve router'ın kendi 8 KB sınırı devre dışı kalır.

  // Bu iki satır her zaman en sonda kalmalıdır: önce eşleşmeyen yollar, sonra ortak hata işleyici.
  app.use(notFoundHandler);
  app.use(createErrorHandler());

  return app;
}
