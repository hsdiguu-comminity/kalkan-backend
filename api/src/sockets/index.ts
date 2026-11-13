/**
 * TR: Hasti — Socket.IO bağlantısı, auth kontrolü ve bağlantı temizliği.
 * EN: Hasti — Socket.IO setup, authentication checks and connection cleanup.
 * TR: Gerçek JWT doğrulaması auth ekibinden gelir; mesajlaşma işleyicileri henüz eklenmedi.
 * EN: The auth team supplies JWT verification; messaging handlers are not implemented yet.
 */
import type { Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import { Server, type Namespace, type Socket } from "socket.io";
import { z } from "zod";

export const SUPPORT_NAMESPACE = "/support";
export const SOCKET_IO_PATH = "/socket.io";
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const principalSchema = z.strictObject({
  userId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  role: z.enum(["user", "expert", "admin"]),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

const handshakeSchema = z.strictObject({
  token: z.string().min(1).max(8192).regex(/^\S+$/),
});

const originSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.origin === value;
  } catch {
    return false;
  }
}, "Origin yalnızca şema, alan adı ve isteğe bağlı port içermelidir.");

const configSchema = z.strictObject({
  allowedOrigins: z.array(originSchema),
  allowRequestsWithoutOrigin: z.boolean().default(false),
  authenticationTimeoutMs: z.number().int().min(50).max(30_000).default(5000),
});

export type SupportPrincipal = Readonly<z.infer<typeof principalSchema>>;

export interface SupportConnectionError {
  code: "UNAUTHENTICATED" | "FORBIDDEN" | "SERVICE_UNAVAILABLE" | "INTERNAL_ERROR";
  message: string;
}

interface SocketData {
  principal: SupportPrincipal;
}

// İş olayları sonraki bölümde kendi girdi şemalarıyla kaydedilir.
type Events = Record<string, (...args: unknown[]) => void>;
type ServerEvents = {
  "support:error": (error: SupportConnectionError) => void;
};
type InterServerEvents = Record<string, never>;

export type SupportSocket = Socket<Events, ServerEvents, InterServerEvents, SocketData>;
export type SupportNamespace = Namespace<Events, ServerEvents, InterServerEvents, SocketData>;

export interface SupportSocketOptions {
  allowedOrigins: string[];
  /** Android gibi Origin göndermeyen istemciler için açıkça true seçilmelidir. */
  allowRequestsWithoutOrigin?: boolean;
  authenticationTimeoutMs?: number;
  /**
   * Auth ekibinin adaptörü: JWT imzası, izinli algoritma, issuer, audience,
   * süre ve iptal durumunu doğrular. Geçersiz token için null döndürür.
   * expiresAt Unix milisaniyesidir (JWT exp * 1000). Sadece decode yeterli değildir.
   * Altyapı hatasında throw eder; iptal edilen işlemler signal ile durdurulmalıdır.
   */
  verifyAccessToken: (token: string, context: { signal: AbortSignal }) => Promise<unknown>;
  // EN: Required verifier above must validate JWT signature/claims/revocation, return null
  // for invalid tokens, and normalize expiresAt to milliseconds; decoding alone is insufficient.
  /**
   * TR: Yalnızca doğrulanmış bağlantılarda, senkron olarak olay dinleyicilerini kurar.
   * EN: Registers event handlers synchronously, only after authentication succeeds.
   */
  registerHandlers?: (socket: SupportSocket) => void;
}

export interface SupportSocketServer {
  namespace: SupportNamespace;
  /** Bu süreçte kullanıcının tüm bağlantılarını keser; token'ı ayrıca auth katmanı iptal eder. */
  disconnectUser: (userId: string) => number;
  /** Socket.IO ile birlikte bağlı HTTP sunucusunu da kapatır. Tekrar çağrılabilir. */
  close: () => Promise<void>;
}

const errors = {
  unauthenticated: {
    code: "UNAUTHENTICATED",
    message: "Oturumunuz geçersiz veya süresi dolmuş. Lütfen yeniden giriş yapın.",
  },
  forbidden: {
    code: "FORBIDDEN",
    message: "Bu bağlantı alanına erişim izniniz yok.",
  },
  unavailable: {
    code: "SERVICE_UNAVAILABLE",
    message: "Kimlik doğrulama servisine şu anda ulaşılamıyor.",
  },
  internal: {
    code: "INTERNAL_ERROR",
    message: "Bağlantı hazırlanırken bir hata oluştu.",
  },
} as const satisfies Record<string, SupportConnectionError>;

class ConnectionError extends Error {
  constructor(readonly data: SupportConnectionError) {
    super(data.message);
  }
}

interface ConnectionState {
  token: string;
  principal?: SupportPrincipal;
  controller: AbortController;
  cleanup: () => void;
}

/**
 * Var olan HTTP(S) sunucusuna eklenir; port açmaz, auth/DB uygulaması üretmez.
 * Aynı HTTP sunucusuna yalnızca bir kez kurulmalıdır.
 * EN: Attach once to an existing HTTP(S) server; this function does not open a port.
 */
export function createSupportSocketServer(
  httpServer: HttpServer | HttpsServer,
  options: SupportSocketOptions,
): SupportSocketServer {
  const config = configSchema.parse({
    allowedOrigins: options.allowedOrigins,
    allowRequestsWithoutOrigin: options.allowRequestsWithoutOrigin,
    authenticationTimeoutMs: options.authenticationTimeoutMs,
  });
  if (typeof options.verifyAccessToken !== "function") {
    throw new TypeError("verifyAccessToken adaptörü gereklidir.");
  }
  const origins = new Set(config.allowedOrigins);
  const io = new Server<Events, ServerEvents, InterServerEvents, SocketData>(httpServer, {
    path: SOCKET_IO_PATH,
    serveClient: false,
    maxHttpBufferSize: 64 * 1024,
    connectTimeout: config.authenticationTimeoutMs + 5000,
    cors: { origin: [...origins], methods: ["GET", "POST"] },
    // CORS tek başına WebSocket bağlantılarını kısıtlamaz.
    allowRequest: (request, callback) => {
      const origin = request.headers.origin;
      const allowed = origin === undefined
        ? config.allowRequestsWithoutOrigin
        : origins.has(origin);
      callback(null, allowed);
    },
    // Kurtarma açılmaz: her yeniden bağlantıda kimlik doğrulama tekrarlanır.
  });
  io.use((_socket, next) => next(new ConnectionError(errors.forbidden)));
  const namespace = io.of(SUPPORT_NAMESPACE);
  const connections = new WeakMap<SupportSocket, ConnectionState>();
  const pendingAndActive = new Set<ConnectionState>();
  let closing = false;
  let closePromise: Promise<void> | undefined;

  // TR: Auth çağrısını süreyle sınırlar; ayrılınca bekleyen doğrulamayı iptal eder.
  // EN: Bounds verification time and cancels pending authentication on disconnect.
  function authenticate(token: string, signal: AbortSignal): Promise<SupportPrincipal> {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let settled = false;
      const finish = (principal?: SupportPrincipal, failure?: SupportConnectionError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        controller.abort();
        if (principal) resolve(principal);
        else reject(new ConnectionError(failure ?? errors.unavailable));
      };
      const onAbort = () => finish(undefined, errors.unavailable);
      const timer = setTimeout(onAbort, config.authenticationTimeoutMs);
      timer.unref();
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted || closing) {
        onAbort();
        return;
      }
      void Promise.resolve()
        .then(() => options.verifyAccessToken(token, { signal: controller.signal }))
        .then((value) => {
          const parsed = principalSchema.safeParse(value);
          if (!parsed.success || parsed.data.expiresAt <= Date.now()) {
            finish(undefined, errors.unauthenticated);
          } else {
            finish(Object.freeze(parsed.data));
          }
        })
        .catch(() => finish(undefined, errors.unavailable));
    });
  }

  // TR: İlk bağlantıda yalnızca handshake.auth.token kabul edilir; kimlik sunucudan gelir.
  // EN: Initial authentication accepts handshake.auth.token; identity comes from the verifier.
  namespace.use((socket, next) => {
    if (closing) {
      next(new ConnectionError(errors.unavailable));
      return;
    }
    const parsed = handshakeSchema.safeParse(socket.handshake.auth);
    // Ham token socket.data veya uygulama loglarına taşınmaz.
    socket.handshake.auth = {};
    if (!parsed.success) {
      next(new ConnectionError(errors.unauthenticated));
      return;
    }
    const controller = new AbortController();
    const state: ConnectionState = {
      token: parsed.data.token,
      controller,
      cleanup: () => {
        controller.abort();
        state.token = "";
        socket.conn.removeListener("close", state.cleanup);
        pendingAndActive.delete(state);
        connections.delete(socket);
      },
    };
    connections.set(socket, state);
    pendingAndActive.add(state);
    socket.conn.once("close", state.cleanup);
    void authenticate(state.token, controller.signal).then(
      (principal) => {
        if (controller.signal.aborted || closing) return;
        state.principal = principal;
        socket.data.principal = principal;
        next();
      },
      (error: ConnectionError) => {
        state.cleanup();
        if (socket.conn.readyState === "open") next(error);
      },
    );
  });

  function disconnect(socket: SupportSocket, error: SupportConnectionError): void {
    if (!socket.connected) return;
    socket.emit("support:error", error);
    socket.disconnect(true);
  }

  namespace.on("connection", (socket) => {
    const state = connections.get(socket);
    if (!state?.principal || closing) {
      disconnect(socket, errors.unavailable);
      return;
    }
    const principal = state.principal;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    // TR: Boşta duran bağlantı da token süresi dolunca kapatılır.
    // EN: Expired tokens disconnect even idle clients.
    const scheduleExpiry = () => {
      const remaining = principal.expiresAt - Date.now();
      if (remaining <= 0) {
        disconnect(socket, errors.unauthenticated);
        return;
      }
      expiryTimer = setTimeout(scheduleExpiry, Math.min(remaining, MAX_TIMER_DELAY_MS));
      expiryTimer.unref();
    };
    socket.once("disconnect", () => {
      clearTimeout(expiryTimer);
      state.cleanup();
    });
    scheduleExpiry();
    if (!socket.connected) return;

    // TR: Her komutta token yeniden kontrol edilir; oda/oturum yetkisi işleyicide kontrol edilmelidir.
    // EN: Recheck the token for every command; handlers must also enforce room/session access.
    socket.use((packet, next) => {
      const rejectPacket = (error: SupportConnectionError) => {
        if (!socket.connected) return;
        const ack: unknown = packet.at(-1);
        if (typeof ack === "function") ack({ ok: false, error });
        disconnect(socket, error);
        // Reddedilen paket iş olayına iletilmez; unhandled 'error' olayı üretilmez.
      };
      if (principal.expiresAt <= Date.now() || state.controller.signal.aborted) {
        rejectPacket(errors.unauthenticated);
        return;
      }
      void authenticate(state.token, state.controller.signal).then(
        (current) => {
          if (!socket.connected || state.controller.signal.aborted) return;
          if (
            current.userId !== principal.userId ||
            current.role !== principal.role ||
            current.expiresAt !== principal.expiresAt
          ) {
            rejectPacket(errors.unauthenticated);
            return;
          }
          next();
        },
        (error: ConnectionError) => rejectPacket(error.data),
      );
    });

    try {
      options.registerHandlers?.(socket);
    } catch {
      disconnect(socket, errors.internal);
    }
  });

  return {
    namespace,
    // TR: Yalnızca bu süreçteki bağlantıları keser; token iptali auth ekibinin sorumluluğudur.
    // EN: Disconnects this process's clients only; the auth team must revoke the token separately.
    disconnectUser(userId) {
      let count = 0;
      for (const socket of namespace.sockets.values()) {
        if (socket.data.principal.userId === userId) {
          disconnect(socket, errors.unauthenticated);
          count += 1;
        }
      }
      return count;
    },
    // TR: Bekleyen işleri temizler; Socket.IO ile bağlı HTTP sunucusunu birlikte kapatır.
    // EN: Cleans up pending work and closes both Socket.IO and its attached HTTP server.
    close() {
      if (!closePromise) {
        closing = true;
        for (const state of pendingAndActive) state.cleanup();
        closePromise = new Promise<void>((resolve, reject) => {
          io.close((error?: Error) => {
            if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
              reject(error);
            } else {
              resolve();
            }
          });
        });
      }
      return closePromise;
    },
  };
}
