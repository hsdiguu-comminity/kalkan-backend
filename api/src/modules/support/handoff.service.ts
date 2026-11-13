/**
 * TR: Hasti — Kullanıcı/AI sohbetini uzmana devretme, kabul ve kapanış mantığı.
 * EN: Hasti — User/AI handoff to an expert, acceptance and session closure.
 * TR: DB ve kuyruk teslimi adaptörlerle bağlanır; burada üretim deposu/dispatcher yoktur.
 * EN: Storage and queue delivery need adapters; no production store/dispatcher is included here.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";

const resourceIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const handoffRequestSchema = z.strictObject({ conversationId: resourceIdSchema });
const actorSchema = z.strictObject({
  userId: resourceIdSchema,
  role: z.enum(["user", "expert", "admin"]),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export type SupportActor = Readonly<z.infer<typeof actorSchema>>;

// TR: Yanıt yapısını ve queued/active/closed durumlarının tutarlılığını doğrular.
// EN: Validates response fields and consistency of queued/active/closed states.
export const supportSessionSchema = z.strictObject({
  id: resourceIdSchema,
  conversationId: resourceIdSchema,
  userId: resourceIdSchema,
  agentId: resourceIdSchema.nullable(),
  status: z.enum(["queued", "active", "closed"]),
  source: z.enum(["user_request", "assistant_escalation"]),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
  closeReason: z.enum(["user_closed", "agent_closed"]).nullable(),
}).refine((session) => {
  if (Date.parse(session.updatedAt) < Date.parse(session.createdAt)) return false;
  if (session.status === "queued" && session.agentId !== null) return false;
  if (session.status === "active" && session.agentId === null) return false;
  if (session.status === "closed") {
    return session.closedAt === session.updatedAt && session.closeReason !== null &&
      (session.closeReason !== "agent_closed" || session.agentId !== null);
  }
  return session.closedAt === null && session.closeReason === null;
}, "Destek oturumu durumu tutarsız.");

export type SupportSession = Readonly<z.infer<typeof supportSessionSchema>>;
export type HandoffResult = Readonly<{ created: boolean; session: SupportSession }>;

const errorDefinitions = {
  INVALID_PAYLOAD: [400, "İstek alanları geçersiz."],
  UNAUTHENTICATED: [401, "Oturumunuz geçersiz veya süresi dolmuş. Lütfen yeniden giriş yapın."],
  FORBIDDEN: [403, "Bu işlem için yetkiniz yok."],
  NOT_FOUND: [404, "Destek oturumu veya sohbet bulunamadı."],
  SESSION_CLOSED: [409, "Bu destek görüşmesi kapanmış."],
  ALREADY_ASSIGNED: [409, "Görüşme başka bir uzmana atanmış."],
  SERVICE_UNAVAILABLE: [503, "Destek hizmetine şu anda ulaşılamıyor."],
  INTERNAL_ERROR: [500, "Destek işlemi tamamlanırken bir hata oluştu."],
} as const;

export type SupportErrorCode = keyof typeof errorDefinitions;

// TR: İstemciye yalnızca sabit hata kodu ve Türkçe mesaj verir; teknik ayrıntı sızdırmaz.
// EN: Exposes fixed error codes and Turkish messages without leaking internal details.
export class SupportServiceError extends Error {
  readonly status: number;
  constructor(readonly code: SupportErrorCode) {
    const [status, message] = errorDefinitions[code];
    super(message);
    this.name = "SupportServiceError";
    this.status = status;
  }
  toJSON(): { code: SupportErrorCode; message: string } {
    return { code: this.code, message: this.message };
  }
}

/**
 * TR: Kuyruk/AI/bildirim için oturumla aynı DB transaction'ında saklanan teslim kaydı.
 * EN: Delivery record stored in the session's DB transaction for queue/AI/notification consumers.
 */
export interface SupportOutboxEvent {
  readonly id: string;
  readonly type: "support.queued" | "support.accepted" | "support.closed";
  readonly session: SupportSession;
}

export interface SupportTransaction {
  findByConversationId(conversationId: string): Promise<SupportSession | null>;
  findById(sessionId: string): Promise<SupportSession | null>;
  /**
   * TR: Seyit'in geçerli uzman teklifini aynı transaction'da okur; atama durumu değildir.
   * EN: Reads Seyit's valid agent offer in the same transaction; this is not assignment status.
   */
  hasAgentOffer(sessionId: string, agentId: string): Promise<boolean>;
  saveSession(session: SupportSession): Promise<void>;
  appendOutbox(event: SupportOutboxEvent): Promise<void>;
}

export interface SupportStore {
  /**
   * Eren'in kalıcı adaptörü: ilgili okuma/yazmaları seri hale getirir, hata halinde
   * tamamını rollback eder, serialization/unique yarışlarını tekrarlar.
   * conversationId ve outbox.id benzersiz olmalıdır. Henüz bulunmayan bir sohbetin
   * eşzamanlı oluşturulması da korunmalıdır; yalnızca var olan satırı kilitlemek yetmez.
   * Callback tekrar çalışabilir: callback içinde dış servise yan etki yapılmaz.
   * EN: Eren's adapter must serialize conflicting operations, roll back all writes on
   * failure and retry serialization/unique conflicts. Protect creation of missing rows too.
   * Enforce unique conversationId/outbox.id; retryable callbacks must not call external services.
   */
  transaction<T>(work: (tx: SupportTransaction) => Promise<T>): Promise<T>;
}

export interface HandoffDependencies {
  store: SupportStore;
  /**
   * TR: Furkan'ın sohbet kaynağı; sahiplik değişmez, silme politikası ayrıca koordine edilir.
   * EN: Furkan's chat ownership source; ownership is immutable, deletion policy needs coordination.
   */
  conversations: { getOwnerId(conversationId: string): Promise<string | null> };
  now?: () => Date;
  newSessionId?: () => string;
}

export interface HandoffService {
  requestHandoff(actor: unknown, input: unknown): Promise<HandoffResult>;
  /**
   * TR: Yalnızca güvenilir AI/chat sunucu kodu çağırır; public HTTP route'u yoktur.
   * EN: Trusted AI/chat server code only; never expose this method as a public HTTP route.
   */
  requestAssistantHandoff(input: unknown): Promise<HandoffResult>;
  getSession(actor: unknown, sessionId: unknown): Promise<SupportSession>;
  acceptSession(actor: unknown, sessionId: unknown): Promise<SupportSession>;
  closeSession(actor: unknown, sessionId: unknown): Promise<SupportSession>;
}

/**
 * TR: Auth adaptörünün sonucunu/süresini kontrol eder; JWT imzasını doğrulamaz.
 * EN: Checks the auth adapter's output and expiry; does not verify JWT signatures.
 */
export function validateSupportActor(value: unknown, now = Date.now()): SupportActor {
  const parsed = actorSchema.safeParse(value);
  if (!parsed.success || parsed.data.expiresAt <= now) {
    throw new SupportServiceError("UNAUTHENTICATED");
  }
  return Object.freeze(parsed.data);
}

function inputId(value: unknown): string {
  const result = resourceIdSchema.safeParse(value);
  if (!result.success) throw new SupportServiceError("INVALID_PAYLOAD");
  return result.data;
}

function readSession(value: unknown): SupportSession {
  const result = supportSessionSchema.safeParse(value);
  if (!result.success) throw new SupportServiceError("INTERNAL_ERROR");
  return Object.freeze(result.data);
}

function requireRole(actor: SupportActor, roles: SupportActor["role"][]): void {
  if (!roles.includes(actor.role)) throw new SupportServiceError("FORBIDDEN");
}

// TR: Yalnızca sahibi veya atanmış uzman erişebilir; diğerlerine kaynak gizlenir (404).
// EN: Only the owner or assigned expert may access; hide the resource from others with 404.
function requireParticipant(actor: SupportActor, session: SupportSession): void {
  const owner = actor.role === "user" && actor.userId === session.userId;
  const agent = actor.role === "expert" && actor.userId === session.agentId;
  if (!owner && !agent) throw new SupportServiceError("NOT_FOUND");
}

// TR: Gerçek DB/chat adaptörleri zorunludur; varsayılan bellek deposu oluşturulmaz.
// EN: Requires real storage/chat adapters; no in-memory storage is silently substituted.
export function createHandoffService(dependencies: HandoffDependencies): HandoffService {
  const now = dependencies.now ?? (() => new Date());
  const newSessionId = dependencies.newSessionId ?? randomUUID;

  function timestamp(): number {
    const value = now().getTime();
    if (!Number.isFinite(value)) throw new SupportServiceError("INTERNAL_ERROR");
    return value;
  }

  async function available<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof SupportServiceError) throw error;
      // Ham DB/ağ exception'ları response veya log metnine taşınmaz.
      throw new SupportServiceError("SERVICE_UNAVAILABLE");
    }
  }

  async function load(tx: SupportTransaction, id: string): Promise<SupportSession> {
    const value = await tx.findById(id);
    if (!value) throw new SupportServiceError("NOT_FOUND");
    const session = readSession(value);
    if (session.id !== id) throw new SupportServiceError("INTERNAL_ERROR");
    return session;
  }

  // TR: Durum ve teslim olayı birlikte yazılır; outbox hatasında adaptör tamamını geri almalıdır.
  // EN: Store state and delivery event together; the adapter must roll back both on outbox failure.
  async function persist(
    tx: SupportTransaction,
    session: SupportSession,
    type: SupportOutboxEvent["type"],
  ): Promise<SupportSession> {
    const checked = readSession(session);
    await tx.saveSession(checked);
    await tx.appendOutbox({
      id: `support:${checked.id}:${checked.revision}`,
      type,
      session: checked,
    });
    return checked;
  }

  // TR: Sohbet sahibini doğrular; mevcut açık oturumu tekrar kullanarak çift kayıt oluşmasını önler.
  // EN: Checks chat ownership and reuses an open session to avoid duplicate handoffs.
  async function request(
    input: unknown,
    source: SupportSession["source"],
    actor?: SupportActor,
  ): Promise<HandoffResult> {
    const parsed = handoffRequestSchema.safeParse(input);
    if (!parsed.success) throw new SupportServiceError("INVALID_PAYLOAD");
    const { conversationId } = parsed.data;
    return available(async () => {
      const ownerId = await dependencies.conversations.getOwnerId(conversationId);
      if (actor) validateSupportActor(actor, timestamp());
      if (!ownerId || (actor && ownerId !== actor.userId)) {
        throw new SupportServiceError("NOT_FOUND");
      }
      if (!resourceIdSchema.safeParse(ownerId).success) {
        throw new SupportServiceError("INTERNAL_ERROR");
      }
      return dependencies.store.transaction(async (tx) => {
        const existing = await tx.findByConversationId(conversationId);
        if (actor) validateSupportActor(actor, timestamp());
        if (existing) {
          const session = readSession(existing);
          if (session.conversationId !== conversationId || session.userId !== ownerId) {
            throw new SupportServiceError("INTERNAL_ERROR");
          }
          if (session.status === "closed") throw new SupportServiceError("SESSION_CLOSED");
          return { created: false, session };
        }
        const time = new Date(timestamp()).toISOString();
        const session = await persist(tx, {
          id: newSessionId(), conversationId, userId: ownerId, agentId: null,
          status: "queued", source, revision: 1, createdAt: time, updatedAt: time,
          closedAt: null, closeReason: null,
        }, "support.queued");
        return { created: true, session };
      });
    });
  }

  return {
    requestHandoff(value, input) {
      // Metotlar Promise döndürür; senkron doğrulama hataları da reject olur.
      return available(async () => {
        const actor = validateSupportActor(value, timestamp());
        requireRole(actor, ["user"]);
        return request(input, "user_request", actor);
      });
    },
    requestAssistantHandoff(input) {
      return request(input, "assistant_escalation");
    },
    getSession(value, sessionId) {
      return available(async () => {
        const actor = validateSupportActor(value, timestamp());
        requireRole(actor, ["user", "expert"]);
        const id = inputId(sessionId);
        return dependencies.store.transaction(async (tx) => {
          const session = await load(tx, id);
          validateSupportActor(actor, timestamp());
          requireParticipant(actor, session);
          return session;
        });
      });
    },
    // TR: Teklif ve durum aynı transaction'da kontrol edilir; yalnızca bir uzman atanabilir.
    // EN: Check offer and state in one transaction so only one expert can claim the session.
    acceptSession(value, sessionId) {
      return available(async () => {
        const actor = validateSupportActor(value, timestamp());
        requireRole(actor, ["expert"]);
        const id = inputId(sessionId);
        return dependencies.store.transaction(async (tx) => {
          const session = await load(tx, id);
          const assigned = session.agentId === actor.userId;
          if (!assigned && !await tx.hasAgentOffer(id, actor.userId)) {
            throw new SupportServiceError("NOT_FOUND");
          }
          validateSupportActor(actor, timestamp());
          if (session.status === "closed") throw new SupportServiceError("SESSION_CLOSED");
          if (session.status === "active") {
            if (!assigned) throw new SupportServiceError("ALREADY_ASSIGNED");
            return session;
          }
          const time = new Date(Math.max(timestamp(), Date.parse(session.updatedAt))).toISOString();
          return persist(tx, {
            ...session, agentId: actor.userId, status: "active",
            revision: session.revision + 1, updatedAt: time,
          }, "support.accepted");
        });
      });
    },
    // TR: Kapanış tekrarları yeni olay oluşturmaz; kapalı oturum yeniden açılmaz.
    // EN: Repeated closure creates no new event; closed sessions are not reopened.
    closeSession(value, sessionId) {
      return available(async () => {
        const actor = validateSupportActor(value, timestamp());
        requireRole(actor, ["user", "expert"]);
        const id = inputId(sessionId);
        return dependencies.store.transaction(async (tx) => {
          const session = await load(tx, id);
          validateSupportActor(actor, timestamp());
          requireParticipant(actor, session);
          if (session.status === "closed") return session;
          const time = new Date(Math.max(timestamp(), Date.parse(session.updatedAt))).toISOString();
          return persist(tx, {
            ...session, status: "closed", revision: session.revision + 1,
            updatedAt: time, closedAt: time,
            closeReason: actor.role === "user" ? "user_closed" : "agent_closed",
          }, "support.closed");
        });
      });
    },
  };
}
