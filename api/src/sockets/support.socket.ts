/**
 * TR: Yetkili odalar, kalıcı mesaj ack'i ve her alıcı için yeniden erişim kontrolü.
 * EN: Authorized rooms, persisted-message acknowledgements and per-recipient access checks.
 */
import { joinSupportSchema, type SupportMessage, type SupportMessageService } from "../modules/support/message.service.js";
import { SupportServiceError, validateSupportActor, type HandoffService, type SupportSession } from "../modules/support/handoff.service.js";
import type { SupportNamespace, SupportSocket } from "./index.js";

export interface SupportRealtimeDependencies {
  namespace: SupportNamespace;
  handoff: HandoffService;
  messages: SupportMessageService;
  authorizeSocket(socket: SupportSocket): Promise<void>;
}
type Ack = (result: unknown) => void;
const roomFor = (sessionId: string) => `support:session:${sessionId}`;
function failure(error: unknown): SupportServiceError {
  return error instanceof SupportServiceError ? error : new SupportServiceError("SERVICE_UNAVAILABLE");
}

export function createSupportRealtime(dependencies: SupportRealtimeDependencies) {
  function ensureConnected(socket: SupportSocket): void {
    if (!socket.connected) throw new SupportServiceError("UNAUTHENTICATED");
    validateSupportActor(socket.data.principal);
  }
  async function authorizedSession(socket: SupportSocket, sessionId: string): Promise<SupportSession> {
    await dependencies.authorizeSocket(socket);
    ensureConnected(socket);
    const session = await dependencies.handoff.getSession(socket.data.principal, sessionId);
    ensureConnected(socket);
    return session;
  }
  async function deliver(sessionId: string, message?: SupportMessage): Promise<void> {
    const room = roomFor(sessionId);
    const recipients = [...dependencies.namespace.sockets.values()].filter((socket) => socket.rooms.has(room));
    await Promise.all(recipients.map(async (socket) => {
      try {
        // TR: Oda üyeliği tek başına yetki değildir; token ve oturum tekrar kontrol edilir.
        // EN: Room membership is not authorization; recheck both token and session before delivery.
        const session = await authorizedSession(socket, sessionId);
        if (!socket.rooms.has(room)) return;
        if (message) socket.emit("support:message:created", message);
        else socket.emit("support:session:updated", session);
      } catch (error) {
        await socket.leave(room);
        if (socket.connected) socket.emit("support:error", failure(error).toJSON());
      }
    }));
  }
  return {
    /** TR: Outbox tüketicisi commit sonrası çağırır. EN: The outbox consumer calls this after commit. */
    async publishSessionUpdate(sessionId: string): Promise<void> {
      const parsed = joinSupportSchema.safeParse({ sessionId });
      if (!parsed.success) throw new SupportServiceError("INVALID_PAYLOAD");
      await deliver(parsed.data.sessionId);
    },
    registerHandlers(socket: SupportSocket): void {
      function command(args: unknown[], work: (input: unknown, ack: Ack) => Promise<void>): void {
        const candidate = args.at(-1);
        const ack: Ack | undefined = typeof candidate === "function" ? (value) => candidate(value) : undefined;
        if (!ack || args.length !== 2) {
          const error = new SupportServiceError("INVALID_PAYLOAD").toJSON();
          if (ack) ack({ ok: false, error });
          else socket.emit("support:error", error);
          return;
        }
        void work(args[0], ack).catch((error: unknown) => {
          if (socket.connected) ack({ ok: false, error: failure(error).toJSON() });
        });
      }
      socket.on("support:join", (...args) => command(args, async (input, ack) => {
        const parsed = joinSupportSchema.safeParse(input);
        if (!parsed.success) throw new SupportServiceError("INVALID_PAYLOAD");
        const id = parsed.data.sessionId;
        const room = roomFor(id);
        await authorizedSession(socket, id);
        try {
          await socket.join(room);
          // TR: Önce katıl, sonra güncel görünümü al; istemci revision ile eski olayı eler.
          // EN: Join before fetching the latest snapshot; clients discard stale revisions.
          const session = await authorizedSession(socket, id);
          ack({ ok: true, data: session });
        } catch (error) {
          await socket.leave(room);
          throw error;
        }
      }));
      socket.on("support:message:send", (...args) => command(args, async (input, ack) => {
        ensureConnected(socket);
        const result = await dependencies.messages.sendMessage(socket.data.principal, input);
        // TR: Ack commit sonrasıdır; alıcının mesajı okuduğunu göstermez.
        // EN: Acknowledge only after commit; this does not mean the recipient read the message.
        if (socket.connected) ack({ ok: true, data: result.message });
        if (result.created) {
          // TR: Yayın başarısız olsa da kayıt kalır; eksik mesajlar HTTP geçmişinden alınır.
          // EN: Persistence survives delivery failure; clients recover missing messages via HTTP history.
          await deliver(result.message.sessionId, result.message).catch(() => {});
        }
      }));
    },
  };
}
