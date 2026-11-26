import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { EnvValidationError, loadEnv, type AppConfig } from "./config/env.js";

// Ortam değişkenleri başlangıçta bir kez doğrulanır; hata varsa yalnızca değişken adları
// yazdırılır ve sunucu açılmaz.
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

server.listen(config.port, () => {
  console.log(`Kalkan API http://localhost:${config.port} adresinde çalışıyor`);
});
