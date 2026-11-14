import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

// Uygulama genelinde tek PrismaClient örneği. Sorgular yalnızca Prisma ile (parametreli) yazılır.
// Kişisel veri içeren alanlar yazılmadan önce lib/masking.ts ile maskelenmelidir.
let client: PrismaClient | undefined;

export function getPrisma(): PrismaClient {
  if (!client) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL tanımlı değil (.env.example dosyasına bakın).");
    }
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  }
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  await client?.$disconnect();
  client = undefined;
}
