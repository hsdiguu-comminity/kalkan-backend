import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import { loadEnv, type AppConfig } from "./config/env.js";
import { createErrorHandler, notFoundHandler } from "./middlewares/errorHandler.js";

// Express uygulaması. Modüller (auth, chat, support, tools, reports, stats, academy)
// kendi router'larını burada /api altında kaydeder; middleware'ler api/src/middlewares/ altındadır.
// Yapılandırma verilmezse ortam değişkenlerinden okunur (testlerde geliştirme varsayılanları).
export function createApp(config: AppConfig = loadEnv()): Express {
  const app = express();

  app.use(helmet());
  // CORS_ORIGIN tanımlı değilse (yalnızca geliştirme/test) her origin kabul edilir;
  // üretimde env.ts CORS_ORIGIN'i zorunlu tutar.
  app.use(cors({ origin: config.corsOrigins ? [...config.corsOrigins] : true, credentials: true }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "kalkan-api" });
  });

  // Örnek: app.use("/api/auth", authRouter);

  // Bu iki satır her zaman en sonda kalmalıdır: önce eşleşmeyen yollar, sonra ortak hata işleyici.
  app.use(notFoundHandler);
  app.use(createErrorHandler());

  return app;
}
