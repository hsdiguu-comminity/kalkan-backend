// TR: Gerçek yerel Socket.IO bağlantılarını test eder; auth adaptörü test için taklit edilir.
// EN: Tests real local Socket.IO connections using a test double for the auth adapter.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { io as connectClient, type Socket as ClientSocket } from "socket.io-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSupportSocketServer,
  type SupportPrincipal,
  type SupportSocketOptions,
  type SupportSocketServer,
} from "../../src/sockets/index.js";

const allowedOrigin = "https://kalkan.example";
const clients: ClientSocket[] = [];
const servers: SupportSocketServer[] = [];

function principal(overrides: Partial<SupportPrincipal> = {}): SupportPrincipal {
  return { userId: "user_1", role: "user", expiresAt: Date.now() + 60_000, ...overrides };
}

async function start(options: Partial<SupportSocketOptions> = {}) {
  const httpServer = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const identity = principal();
  const verify = vi.fn<SupportSocketOptions["verifyAccessToken"]>(async () => identity);
  const handler = vi.fn<NonNullable<SupportSocketOptions["registerHandlers"]>>((socket) => {
    socket.on("probe", (...args) => {
      const ack = args.at(-1);
      if (typeof ack === "function") ack({ userId: socket.data.principal.userId });
    });
  });
  const server = createSupportSocketServer(httpServer, {
    allowedOrigins: [allowedOrigin],
    verifyAccessToken: verify,
    registerHandlers: handler,
    ...options,
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });
  const address = httpServer.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  return { server, verify, handler, identity, url, httpServer };
}

function client(
  url: string,
  options: {
    auth?: Record<string, unknown>;
    origin?: string | null;
    transport?: "websocket" | "polling";
    namespace?: string;
  } = {},
) {
  const origin = options.origin === undefined ? allowedOrigin : options.origin;
  const socket = connectClient(`${url}${options.namespace ?? "/support"}`, {
    autoConnect: false,
    forceNew: true,
    reconnection: false,
    timeout: 2500,
    transports: [options.transport ?? "websocket"],
    auth: options.auth ?? { token: "test-access-token" },
    extraHeaders: origin === null ? {} : { Origin: origin },
  });
  clients.push(socket);
  return socket;
}

function connect(socket: ClientSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("connect", () => {
      socket.off("connect_error", reject);
      resolve();
    });
    socket.once("connect_error", reject);
    socket.connect();
  });
}

function connectionFailure(socket: ClientSocket): Promise<Error & { data?: unknown }> {
  return new Promise((resolve, reject) => {
    socket.once("connect", () => reject(new Error("Bağlantı reddedilmeliydi.")));
    socket.once("connect_error", resolve);
    socket.connect();
  });
}

afterEach(async () => {
  for (const socket of clients.splice(0)) socket.disconnect();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("Socket.IO bağlantı altyapısı", () => {
  it.each(["websocket", "polling"] as const)("%s ile doğrulanmış bağlantı kurar", async (transport) => {
    const { url, verify, handler, identity } = await start();
    const socket = client(url, { transport });
    await connect(socket);
    expect(verify).toHaveBeenCalledOnce();
    expect(verify.mock.calls[0]?.[0]).toBe("test-access-token");
    expect(handler).toHaveBeenCalledOnce();
    const serverSocket = handler.mock.calls[0]?.[0];
    expect(serverSocket?.data.principal).toEqual(identity);
    expect(serverSocket?.handshake.auth).toEqual({});
    expect(Object.isFrozen(serverSocket?.data.principal)).toBe(true);
    expect(await socket.timeout(2000).emitWithAck("probe", {})).toEqual({ userId: "user_1" });
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it.each(["user", "expert", "admin"] as const)("%s rolünü auth adaptöründen alır", async (role) => {
    const identity = principal({ role });
    const { url, handler } = await start({ verifyAccessToken: async () => identity });
    await connect(client(url));
    expect(handler.mock.calls[0]?.[0].data.principal.role).toBe(role);
  });

  it.each([
    {},
    { token: "" },
    { token: 123 },
    { token: "token with spaces" },
    { token: "x".repeat(8193) },
    { token: "test-access-token", role: "expert" },
  ])("geçersiz handshake'i auth çağırmadan reddeder: %#", async (auth) => {
    const { url, verify, handler } = await start();
    const error = await connectionFailure(client(url, { auth }));
    expect(error.data).toMatchObject({ code: "UNAUTHENTICATED" });
    expect(verify).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { userId: "user_1", role: "root", expiresAt: 9_000_000_000_000 },
    { userId: "", role: "user", expiresAt: 9_000_000_000_000 },
    { userId: "user_1", role: "user" },
    { userId: "user_1", role: "user", expiresAt: 1 },
  ])("geçersiz auth sonucunu reddeder: %#", async (value) => {
    const { url, handler } = await start({ verifyAccessToken: async () => value });
    const error = await connectionFailure(client(url));
    expect(error.data).toMatchObject({ code: "UNAUTHENTICATED" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("auth servisi hatasını ve ham token'ı istemciye sızdırmaz", async () => {
    const { url } = await start({
      verifyAccessToken: async () => { throw new Error("secret-database-url test-access-token"); },
    });
    const error = await connectionFailure(client(url));
    expect(error.data).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(JSON.stringify(error)).not.toContain("secret-database-url");
    expect(JSON.stringify(error)).not.toContain("test-access-token");
  });

  it("yanıt vermeyen auth servisini zaman aşımıyla iptal eder", async () => {
    let signal: AbortSignal | undefined;
    const { url, handler } = await start({
      authenticationTimeoutMs: 50,
      verifyAccessToken: async (_token, context) => {
        signal = context.signal;
        return new Promise(() => {});
      },
    });
    const error = await connectionFailure(client(url));
    expect(error.data).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(signal?.aborted).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(["websocket", "polling"] as const)("%s için izin verilmeyen origin'i engeller", async (transport) => {
    const { url, verify } = await start();
    await connectionFailure(client(url, { origin: "https://untrusted.example", transport }));
    expect(verify).not.toHaveBeenCalled();
  });

  it("Origin içermeyen istemciyi varsayılan olarak reddeder", async () => {
    const { url, verify } = await start();
    await connectionFailure(client(url, { origin: null }));
    expect(verify).not.toHaveBeenCalled();
  });

  it("Origin içermeyen mobil istemciye açık ayarla izin verir ve yine token ister", async () => {
    const { url, verify } = await start({ allowRequestsWithoutOrigin: true });
    await connect(client(url, { origin: null }));
    expect(verify).toHaveBeenCalledOnce();
    const error = await connectionFailure(client(url, { origin: null, auth: {} }));
    expect(error.data).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("kök namespace üzerinden auth atlanmasına izin vermez", async () => {
    const { url, verify } = await start();
    const error = await connectionFailure(client(url, { namespace: "/" }));
    expect(error.data).toMatchObject({ code: "FORBIDDEN" });
    expect(verify).not.toHaveBeenCalled();
  });

  it("token süresi dolunca boşta duran bağlantıyı ve oda üyeliğini kaldırır", async () => {
    const identity = principal({ expiresAt: Date.now() + 600 });
    const { url, server } = await start({ verifyAccessToken: async () => identity });
    const socket = client(url);
    const expired = new Promise<unknown>((resolve) => socket.once("support:error", resolve));
    await connect(socket);
    await expect(expired).resolves.toMatchObject({ code: "UNAUTHENTICATED" });
    await vi.waitFor(() => expect(socket.connected).toBe(false));
    expect(server.namespace.sockets.size).toBe(0);
    expect(server.namespace.adapter.rooms.size).toBe(0);
  });

  it("uzun ömürlü token'da Node zamanlayıcı taşması nedeniyle hemen bağlantıyı kesmez", async () => {
    const identity = principal({ expiresAt: Date.now() + 40 * 24 * 60 * 60 * 1000 });
    const { url } = await start({ verifyAccessToken: async () => identity });
    const socket = client(url);
    await connect(socket);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await socket.timeout(2000).emitWithAck("probe", {})).toEqual({ userId: "user_1" });
  });

  it("iptal edilmiş token'ın sonraki komutunu işleyiciye iletmez", async () => {
    const identity = principal();
    let revoked = false;
    let received = 0;
    const { url } = await start({
      verifyAccessToken: async () => revoked ? null : identity,
      registerHandlers: (socket) => socket.on("probe", () => { received += 1; }),
    });
    const socket = client(url);
    await connect(socket);
    revoked = true;
    expect(await socket.timeout(2000).emitWithAck("probe", {})).toMatchObject({
      ok: false, error: { code: "UNAUTHENTICATED" },
    });
    await vi.waitFor(() => expect(socket.connected).toBe(false));
    expect(received).toBe(0);
  });

  it("yeniden doğrulamada aktör veya rol değişirse komutu reddeder", async () => {
    const identity = principal();
    let roleChanged = false;
    const { url } = await start({
      verifyAccessToken: async () => roleChanged ? { ...identity, role: "expert" } : identity,
    });
    const socket = client(url);
    await connect(socket);
    roleChanged = true;
    expect(await socket.timeout(2000).emitWithAck("probe", {})).toMatchObject({
      ok: false, error: { code: "UNAUTHENTICATED" },
    });
  });

  it("kullanıcının tüm yerel bağlantılarını keser, diğer kullanıcıyı korur", async () => {
    const first = principal();
    const second = principal({ userId: "user_2" });
    const { url, server } = await start({
      verifyAccessToken: async (token) => token === "second-user-token" ? second : first,
    });
    const a = client(url);
    const b = client(url);
    const c = client(url, { auth: { token: "second-user-token" } });
    await Promise.all([connect(a), connect(b), connect(c)]);
    expect(server.disconnectUser("user_1")).toBe(2);
    await vi.waitFor(() => {
      expect(a.connected).toBe(false);
      expect(b.connected).toBe(false);
    });
    expect(server.disconnectUser("user_1")).toBe(0);
    expect(c.connected).toBe(true);
    expect(server.namespace.sockets.size).toBe(1);
  });

  it("istemci doğrulama sırasında ayrılırsa bekleyen işi iptal eder", async () => {
    let signal: AbortSignal | undefined;
    const { url, handler } = await start({
      verifyAccessToken: async (_token, context) => {
        signal = context.signal;
        return new Promise(() => {});
      },
    });
    const socket = client(url);
    socket.connect();
    await vi.waitFor(() => expect(signal).toBeDefined());
    socket.disconnect();
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(handler).not.toHaveBeenCalled();
  });

  it("normal ayrılmada odaları temizler ve yeniden bağlantıda tekrar doğrular", async () => {
    const { url, server, verify } = await start();
    const socket = client(url);
    await connect(socket);
    socket.disconnect();
    await vi.waitFor(() => expect(server.namespace.sockets.size).toBe(0));
    expect(server.namespace.adapter.rooms.size).toBe(0);
    await connect(socket);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it("kapatma bekleyen auth işini iptal eder ve tekrar çağrılabilir", async () => {
    let signal: AbortSignal | undefined;
    const { url, server, httpServer } = await start({
      verifyAccessToken: async (_token, context) => {
        signal = context.signal;
        return new Promise(() => {});
      },
    });
    client(url).connect();
    await vi.waitFor(() => expect(signal).toBeDefined());
    const firstClose = server.close();
    expect(server.close()).toBe(firstClose);
    await firstClose;
    expect(signal?.aborted).toBe(true);
    expect(httpServer.listening).toBe(false);
  });

  it("başlatılmamış HTTP sunucusunu da güvenle kapatır", async () => {
    const server = createSupportSocketServer(createServer(), {
      allowedOrigins: [], verifyAccessToken: async () => null,
    });
    servers.push(server);
    await expect(server.close()).resolves.toBeUndefined();
  });

  it.each(["*", "null", "https://kalkan.example/path", "https://kalkan.example/"])(
    "geçersiz origin yapılandırmasını reddeder: %s",
    (origin) => {
      expect(() => createSupportSocketServer(createServer(), {
        allowedOrigins: [origin], verifyAccessToken: async () => null,
      })).toThrow();
    },
  );
});
