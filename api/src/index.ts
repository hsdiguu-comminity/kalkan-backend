import { config as loadDotenv } from "dotenv";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { EnvValidationError, loadEnv, type AppConfig } from "./config/env.js";

// Ekip .env dosyasını repo köküne koyuyor; api/.env varsa o önceliklidir. Yollar komutun
// çalıştırıldığı klasöre değil bu dosyanın konumuna göredir. Gerçek ortam değişkenleri
// her zaman .env'deki değerlerden önce gelir; bulunmayan dosya yok sayılır.
loadDotenv({
  path: [
    fileURLToPath(new URL("../.env", import.meta.url)),
    fileURLToPath(new URL("../../.env", import.meta.url)),
  ],
  quiet: true,
});

// Hatalı yapılandırmayla sunucu hiç açılmaz; yalnızca değişken adları yazdırılır.
function readConfig(): AppConfig {
  try {
    return loadEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const config = readConfig();
const server = createServer(createApp(config));

// Socket.IO (canlı destek) bu HTTP sunucusuna api/src/sockets/ içinden bağlanacak.
// Henüz bağlı değil: Buse'nin verifyAccessToken adaptörü ve veritabanı hazır olmalı.

server.listen(config.port, () => {
  console.log(`Kalkan API http://localhost:${config.port} adresinde çalışıyor`);
});
