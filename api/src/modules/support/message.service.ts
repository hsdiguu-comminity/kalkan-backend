/**
 * TR: Kalıcı mesaj, tekrar kontrolü ve yetkili geçmiş. Gerçek depo/maskeleme adaptörleri zorunludur.
 * EN: Persistent messaging, deduplication and authorized history. Storage/redaction adapters are required.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { requireParticipant, supportSessionSchema, SupportServiceError, validateSupportActor,
  type SupportActor, type SupportSession, type SupportStore, type SupportTransaction,
} from "./handoff.service.js";

const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const sequenceSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
// TR: Unicode kod noktaları sayılır; 4000 emoji de geçerlidir. Metin trim edilmez.
// EN: Count Unicode code points: 4000 emoji are valid too. Preserve exact input text.
const textSchema = z.string().refine((text) => {
  const length = Array.from(text).length;
  return length >= 1 && length <= 4000 && /\S/u.test(text);
});
export const joinSupportSchema = z.strictObject({ sessionId: idSchema });
export const sendSupportMessageSchema = z.strictObject({
  sessionId: idSchema,
  clientMessageId: z.uuid().transform((id) => id.toLowerCase()),
  text: textSchema,
});
export const supportMessageSchema = z.strictObject({
  id: idSchema, sessionId: idSchema, clientMessageId: z.uuid(), senderId: idSchema,
  senderRole: z.enum(["user", "expert"]), sequence: sequenceSchema,
  text: textSchema, createdAt: z.iso.datetime(),
});
export type SupportMessage = Readonly<z.infer<typeof supportMessageSchema>>;
export interface StoredSupportMessage {
  message: SupportMessage;
  /** TR: Ham metin yerine HMAC saklanır; istemciye gönderilmez. EN: HMAC replaces raw text; never sent to clients. */
  contentFingerprint: string | null;
}
export interface MessagePage {
  items: SupportMessage[];
  nextAfterSequence: number;
  hasMore: boolean;
}
const integerQuery = z.union([z.number(), z.string().regex(/^(0|[1-9]\d*)$/).transform(Number)]);
const historyQuerySchema = z.strictObject({
  afterSequence: integerQuery.pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)).default(0),
  limit: integerQuery.pipe(z.number().int().min(1).max(100)).default(50),
});
export interface SupportMessageService {
  sendMessage(actor: unknown, input: unknown): Promise<{ created: boolean; message: SupportMessage }>;
  listMessages(actor: unknown, sessionId: unknown, query?: unknown): Promise<MessagePage>;
}
export interface MessageDependencies {
  store: SupportStore;
  /** TR: En az 32 rastgele bayt; ortamdan gelir. EN: At least 32 random bytes supplied from configuration. */
  messageHmacKey: Uint8Array;
  /** TR: Eren'in yerel, deterministik maskelemesi; ağ/log yan etkisi yok. EN: Pure local deterministic redaction; no network/logging. */
  redactText(text: string): string;
  now?: () => Date;
  newMessageId?: () => string;
}

export function createSupportMessageService(dependencies: MessageDependencies): SupportMessageService {
  const key = Buffer.from(dependencies.messageHmacKey);
  if (key.length < 32 || typeof dependencies.redactText !== "function") {
    throw new TypeError("En az 32 bayt HMAC anahtarı ve maskeleme adaptörü gereklidir.");
  }
  const now = dependencies.now ?? (() => new Date());
  const newMessageId = dependencies.newMessageId ?? randomUUID;
  function time(): number {
    const value = now().getTime();
    if (!Number.isFinite(value)) throw new SupportServiceError("INTERNAL_ERROR");
    return value;
  }
  function actor(value: unknown): SupportActor {
    const result = validateSupportActor(value, time());
    if (result.role === "admin") throw new SupportServiceError("FORBIDDEN");
    return result;
  }
  async function available<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (error instanceof SupportServiceError) throw error;
      throw new SupportServiceError("SERVICE_UNAVAILABLE");
    }
  }
  async function sessionFor(tx: SupportTransaction, principal: SupportActor, id: string): Promise<SupportSession> {
    const row = await tx.findById(id);
    if (!row) throw new SupportServiceError("NOT_FOUND");
    const parsed = supportSessionSchema.safeParse(row);
    if (!parsed.success || parsed.data.id !== id) throw new SupportServiceError("INTERNAL_ERROR");
    validateSupportActor(principal, time());
    requireParticipant(principal, parsed.data);
    return parsed.data;
  }
  function readMessage(value: unknown, session: SupportSession): SupportMessage {
    const parsed = supportMessageSchema.safeParse(value);
    if (!parsed.success || parsed.data.sessionId !== session.id) throw new SupportServiceError("INTERNAL_ERROR");
    const message = parsed.data;
    if (message.senderId !== (message.senderRole === "user" ? session.userId : session.agentId)) {
      throw new SupportServiceError("INTERNAL_ERROR");
    }
    return Object.freeze(message);
  }
  return {
    sendMessage(value, input) {
      return available(async () => {
        const principal = actor(value);
        const parsed = sendSupportMessageSchema.safeParse(input);
        if (!parsed.success) throw new SupportServiceError("INVALID_PAYLOAD");
        const { sessionId, clientMessageId, text } = parsed.data;
        const fingerprint = createHmac("sha256", key)
          .update(JSON.stringify([sessionId, principal.userId, text])).digest("hex");
        return dependencies.store.transaction(async (tx) => {
          const session = await sessionFor(tx, principal, sessionId);
          const existing = await tx.findMessageByClientId(sessionId, principal.userId, clientMessageId);
          validateSupportActor(principal, time());
          // TR: Önce tekrar kontrolü: kapanıştan önce kaydedilen mesaj yine dönebilir.
          // EN: Deduplicate first: retries of messages committed before closure can still succeed.
          if (existing) {
            // TR: Eski mesajların ham metni bilinmez. EN: Legacy rows cannot prove an exact-text retry.
            if (existing.contentFingerprint === null) throw new SupportServiceError("MESSAGE_ID_CONFLICT");
            if (!/^[a-f0-9]{64}$/.test(existing.contentFingerprint)) throw new SupportServiceError("INTERNAL_ERROR");
            const message = readMessage(existing.message, session);
            if (message.senderId !== principal.userId || message.clientMessageId.toLowerCase() !== clientMessageId) {
              throw new SupportServiceError("INTERNAL_ERROR");
            }
            if (!timingSafeEqual(Buffer.from(fingerprint, "hex"), Buffer.from(existing.contentFingerprint, "hex"))) {
              throw new SupportServiceError("MESSAGE_ID_CONFLICT");
            }
            return { created: false, message };
          }
          if (session.status === "closed") throw new SupportServiceError("SESSION_CLOSED");
          if (session.status !== "active") throw new SupportServiceError("SESSION_NOT_ACTIVE");
          let redacted: string;
          try { redacted = dependencies.redactText(text); }
          catch { throw new SupportServiceError("SERVICE_UNAVAILABLE"); }
          if (!textSchema.safeParse(redacted).success) throw new SupportServiceError("INTERNAL_ERROR");
          const sequence = await tx.nextMessageSequence(sessionId);
          validateSupportActor(principal, time());
          const message = readMessage({
            id: newMessageId(), sessionId, clientMessageId, senderId: principal.userId,
            senderRole: principal.role, sequence, text: redacted,
            createdAt: new Date(time()).toISOString(),
          }, session);
          await tx.saveMessage({ message, contentFingerprint: fingerprint });
          return { created: true, message };
        });
      });
    },
    listMessages(value, sessionId, query = {}) {
      return available(async () => {
        const principal = actor(value);
        const id = idSchema.safeParse(sessionId);
        const parsed = historyQuerySchema.safeParse(query);
        if (!id.success || !parsed.success) throw new SupportServiceError("INVALID_PAYLOAD");
        const { afterSequence, limit } = parsed.data;
        return dependencies.store.transaction(async (tx) => {
          const session = await sessionFor(tx, principal, id.data);
          const rows = await tx.listMessages(id.data, afterSequence, limit + 1);
          validateSupportActor(principal, time());
          if (rows.length > limit + 1) throw new SupportServiceError("INTERNAL_ERROR");
          const messages = rows.map((row) => readMessage(row, session));
          let previous = afterSequence;
          const ids = new Set<string>();
          for (const message of messages) {
            if (message.sequence <= previous || ids.has(message.id)) throw new SupportServiceError("INTERNAL_ERROR");
            previous = message.sequence;
            ids.add(message.id);
          }
          const items = messages.slice(0, limit);
          return { items, nextAfterSequence: items.at(-1)?.sequence ?? afterSequence, hasMore: messages.length > limit };
        });
      });
    },
  };
}
