import "dotenv/config";
import { defineConfig } from "prisma/config";

// Prisma CLI ayarları. DATABASE_URL .env dosyasından okunur (bkz. ../.env.example).
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL ?? "" },
});
