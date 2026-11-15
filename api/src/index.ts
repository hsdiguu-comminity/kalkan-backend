import "dotenv/config";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createApp } from "./app.js";
import { createSupportServer, type SupportRuntimeOptions } from "./modules/support/support-runtime.js";

/** TR: Ekip gerçek adaptörleri sağlar. EN: The team supplies real auth/redaction/queue adapters. */
export interface SupportBootstrap {
  options: SupportRuntimeOptions;
  closeDependencies(): Promise<void>;
}

async function main() {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError("Geçersiz PORT.");
  let bootstrap: SupportBootstrap | undefined;
  let support: ReturnType<typeof createSupportServer> | undefined;
  try {
    if (process.env.SUPPORT_ADAPTER_MODULE) {
      const module = await import(pathToFileURL(resolve(process.env.SUPPORT_ADAPTER_MODULE)).href) as {
        createSupportBootstrap?: () => Promise<SupportBootstrap>;
      };
      if (typeof module.createSupportBootstrap !== "function") throw new TypeError("createSupportBootstrap gereklidir.");
      bootstrap = await module.createSupportBootstrap();
      if (typeof bootstrap.closeDependencies !== "function") throw new TypeError("closeDependencies gereklidir.");
      support = createSupportServer(bootstrap.options);
    }
    // TR: Adaptörsüz modda /support 503 döner. EN: Without adapters /support explicitly returns 503.
    const server = support?.httpServer ?? createServer(createApp());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, resolve);
    });
    support?.startDispatcher();
    console.log(`Kalkan API ${port} portunda çalışıyor. Canlı destek: ${support ? "etkin" : "yapılandırılmadı"}.`);
    let shutdown: Promise<void> | undefined;
    const close = () => {
      shutdown ??= (async () => {
        if (support) await support.close();
        else await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await bootstrap?.closeDependencies();
      })();
      void shutdown.catch(() => { console.error("Sunucu kapatma hatası."); process.exitCode = 1; });
    };
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
  } catch (error) {
    await support?.close();
    await bootstrap?.closeDependencies?.();
    throw error;
  }
}
void main().catch(() => {
  // TR: Bağlantı sırları loglanmaz. EN: Never log credentials from configuration failures.
  console.error("Sunucu başlatılamadı; PORT ve adaptör yapılandırmasını kontrol edin.");
  process.exitCode = 1;
});
