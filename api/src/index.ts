import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { EnvValidationError, loadEnv, type AppConfig } from "./config/env.js";

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
