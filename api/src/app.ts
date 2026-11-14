import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";

// Express uygulaması. Modüller (auth, chat, support, tools, reports, stats, academy)
// kendi router"larını burada /api altında kaydeder; middleware"ler api/src/middlewares/ altındadır.
export function createApp(): Express {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: process.env.CORS_ORIGIN?.split(",") ?? true, credentials: true }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "kalkan-api" });
  });

  // Örnek: app.use("/api/auth", authRouter);

  return app;
}
