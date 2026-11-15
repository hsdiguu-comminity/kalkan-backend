import express, { type Express, type Router } from "express";
import cors from "cors";
import helmet from "helmet";

// Express uygulaması. Modüller (auth, chat, support, tools, reports, stats, academy)
// kendi router"larını burada /api altında kaydeder; middleware"ler api/src/middlewares/ altındadır.
export function createApp(options: { supportRouter?: Router; allowedOrigins?: string[] } = {}): Express {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: options.allowedOrigins ?? process.env.CORS_ORIGIN?.split(",") ?? true, credentials: true }));
  // TR: Support kendi 8 KiB parser/auth katmanını kullanır. EN: Support owns its 8 KiB parser and auth boundary.
  if (options.supportRouter) app.use("/support", options.supportRouter);
  else app.use("/support", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ error: { code: "SERVICE_UNAVAILABLE", message: "Destek entegrasyonu henüz yapılandırılmadı." } });
  });
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "kalkan-api" });
  });

  // Örnek: app.use("/api/auth", authRouter);

  return app;
}
