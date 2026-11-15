/** TR: Tek kurulum noktası; gerçek adaptörler zorunludur. EN: One composition root with mandatory real adapters. */
import { createServer } from "node:http";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { createApp } from "../../app.js";
import { createSupportSocketServer } from "../../sockets/index.js";
import { createHandoffService } from "./handoff.service.js";
import { createSupportMessageService } from "./message.service.js";
import { createPrismaConversationSource, createPrismaSupportStore } from "./prisma-support.store.js";
import { createSupportHttpPrincipalResolver, type AccessVerifier } from "./support-auth.js";
import { createSupportOutboxDispatcher, type SupportDelivery } from "./support-outbox.js";
import { createSupportRouter } from "./support.routes.js";

export interface SupportRuntimeOptions {
  prisma: PrismaClient;
  verifyAccessToken: AccessVerifier;
  messageHmacKey: Uint8Array;
  redactText(text: string): string;
  publishQueueEvent(delivery: SupportDelivery): Promise<void>;
  allowedOrigins: string[];
  allowRequestsWithoutOrigin?: boolean;
  /** TR: Yalnızca sabit hata kodu raporlanır. EN: Report a fixed error code, never raw errors. */
  onDeliveryError(code: "SUPPORT_DELIVERY_UNAVAILABLE"): void;
}

export function decodeSupportMessageKey(encoded: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new TypeError("SUPPORT_MESSAGE_HMAC_KEY geçerli base64 olmalı.");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length < 32 || bytes.toString("base64") !== encoded) throw new TypeError("HMAC anahtarı en az 32 bayt olmalı.");
  return bytes;
}

export function createSupportServer(options: SupportRuntimeOptions) {
  if (typeof options.publishQueueEvent !== "function" || typeof options.onDeliveryError !== "function") {
    throw new TypeError("Kuyruk ve hata gözlem adaptörleri gereklidir.");
  }
  const store = createPrismaSupportStore(options.prisma);
  const handoff = createHandoffService({ store, conversations: createPrismaConversationSource(options.prisma) });
  const messages = createSupportMessageService({ store, messageHmacKey: options.messageHmacKey, redactText: options.redactText });
  const router = createSupportRouter({ service: handoff, messages,
    resolvePrincipal: createSupportHttpPrincipalResolver(options.verifyAccessToken) });
  const app = createApp({ supportRouter: router, allowedOrigins: options.allowedOrigins });
  const httpServer = createServer(app);
  const realtime = createSupportSocketServer(httpServer, {
    allowedOrigins: options.allowedOrigins, allowRequestsWithoutOrigin: options.allowRequestsWithoutOrigin ?? false,
    verifyAccessToken: options.verifyAccessToken, support: { handoff, messages },
  });
  const dispatcher = createSupportOutboxDispatcher({ prisma: options.prisma, publish: options.publishQueueEvent,
    publishSessionUpdate: realtime.publishSessionUpdate });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let stopped = true;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  function startDispatcher(intervalMs = 1000) {
    if (closing) throw new Error("Sunucu kapanıyor.");
    if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000) throw new TypeError("Geçersiz interval.");
    if (!stopped) return;
    stopped = false;
    const tick = () => {
      if (stopped) return;
      running = (async () => {
        try {
          const result = await dispatcher.runOnce();
          if (result.failed) options.onDeliveryError("SUPPORT_DELIVERY_UNAVAILABLE");
        } catch { options.onDeliveryError("SUPPORT_DELIVERY_UNAVAILABLE"); }
      })().finally(() => {
        running = undefined;
        if (!stopped) { timer = setTimeout(tick, intervalMs); timer.unref(); }
      });
      // TR: Gözlem adaptörü throw etse bile unhandled rejection yok. EN: Contain observer failures too.
      void running.catch(() => {});
    };
    tick();
  }
  return { app, httpServer, handoff, messages, realtime, dispatcher, startDispatcher,
    close() {
      if (!closePromise) {
        closing = true;
        stopped = true;
        clearTimeout(timer);
        closePromise = (async () => {
          // TR: Paylaşılan Prisma/Queue çağırana aittir. EN: Caller owns shared Prisma/Queue shutdown.
          await running?.catch(() => {});
          await realtime.close();
        })();
      }
      return closePromise;
    },
  };
}
