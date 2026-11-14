import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const server = createServer(createApp());

// Socket.IO (canlı destek) bu HTTP sunucusuna api/src/sockets/ içinden bağlanacak.

server.listen(port, () => {
  console.log(`Kalkan API http://localhost:${port} adresinde çalışıyor`);
});
