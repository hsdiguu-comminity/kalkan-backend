/** TR: Gerçek Prisma/PostgreSQL adaptörü. EN: Production Prisma/PostgreSQL storage adapter. */
import { setTimeout as delay } from "node:timers/promises";
import { Prisma, type PrismaClient, type SupportSession as SessionRow,
  type SupportMessage as MessageRow } from "../../generated/prisma/client.js";
import { supportSessionSchema, SupportServiceError, type SupportStore,
  type SupportTransaction } from "./handoff.service.js";
import { supportMessageSchema } from "./message.service.js";

export function sessionFromRow(row: SessionRow) {
  const { lastMessageSequence: _counter, ...session } = row;
  return supportSessionSchema.parse({ ...session, createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(), closedAt: row.closedAt?.toISOString() ?? null });
}
function messageFromRow(row: MessageRow) {
  return supportMessageSchema.parse({ id: row.id, sessionId: row.sessionId, senderId: row.senderId,
    senderRole: row.senderRole, clientMessageId: row.clientMessageId, sequence: row.sequence,
    text: row.content, createdAt: row.createdAt.toISOString() });
}

export function createPrismaSupportStore(prisma: PrismaClient): SupportStore {
  return {
    async transaction<T>(work: (tx: SupportTransaction) => Promise<T>): Promise<T> {
      // TR: Satır kilidi oturum işlerini, advisory kilit henüz olmayan sohbeti korur.
      // EN: Row locks serialize session work; advisory locks protect missing-conversation races.
      for (let attempt = 0; ; attempt++) {
        try {
          return await prisma.$transaction(async (db) => work({
            async findByConversationId(conversationId) {
              // TR: Snapshot kilit bekledikten sonra alınır. EN: ReadCommitted reads fresh state after acquiring locks.
              await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`support:conversation:${conversationId}`}, 0))::text`;
              await db.$queryRaw`SELECT id FROM support_sessions WHERE conversation_id = ${conversationId} FOR UPDATE`;
              const row = await db.supportSession.findUnique({ where: { conversationId } });
              return row ? sessionFromRow(row) : null;
            },
            async findById(id) {
              await db.$queryRaw`SELECT id FROM support_sessions WHERE id = ${id} FOR UPDATE`;
              const row = await db.supportSession.findUnique({ where: { id } });
              return row ? sessionFromRow(row) : null;
            },
            async hasAgentOffer(sessionId, agentId) {
              return await db.supportAgentOffer.count({ where: { sessionId, agentId,
                expiresAt: { gt: new Date() }, agent: { status: "active", role: "expert" } } }) > 0;
            },
            async saveSession(session) {
              const data = { ...session, createdAt: new Date(session.createdAt),
                updatedAt: new Date(session.updatedAt), closedAt: session.closedAt ? new Date(session.closedAt) : null };
              await db.supportSession.upsert({ where: { id: session.id }, create: data, update: data });
            },
            async appendOutbox(event) {
              await db.supportOutboxEvent.create({ data: { id: event.id, sessionId: event.session.id,
                type: event.type, payload: event.session as Prisma.InputJsonValue } });
            },
            async findMessageByClientId(sessionId, senderId, clientMessageId) {
              const row = await db.supportMessage.findUnique({ where: {
                sessionId_senderId_clientMessageId: { sessionId, senderId, clientMessageId },
              } });
              return row ? { message: messageFromRow(row), contentFingerprint: row.contentFingerprint } : null;
            },
            async nextMessageSequence(id) {
              const previous = await db.supportSession.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } });
              const row = await db.supportSession.update({ where: { id },
                data: { lastMessageSequence: { increment: 1 }, updatedAt: previous.updatedAt }, select: { lastMessageSequence: true } });
              return row.lastMessageSequence;
            },
            async saveMessage({ message, contentFingerprint }) {
              if (!contentFingerprint || !/^[a-f0-9]{64}$/.test(contentFingerprint)) {
                throw new SupportServiceError("INTERNAL_ERROR");
              }
              const { text, ...rest } = message;
              await db.supportMessage.create({ data: { ...rest, content: text, contentFingerprint,
                createdAt: new Date(message.createdAt) } });
            },
            async listMessages(sessionId, afterSequence, take) {
              const rows = await db.supportMessage.findMany({ where: { sessionId, sequence: { gt: afterSequence } },
                orderBy: { sequence: "asc" }, take });
              return rows.map(messageFromRow);
            },
          }), { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 10_000 });
        } catch (error) {
          const retryable = error instanceof Prisma.PrismaClientKnownRequestError &&
            ["P2034", "P2002"].includes(error.code);
          if (!retryable || attempt >= 7) throw error;
          await delay(Math.min(10 * 2 ** attempt, 250) + Math.floor(Math.random() * 20));
        }
      }
    },
  };
}

export function createPrismaConversationSource(prisma: PrismaClient) {
  return { async getOwnerId(id: string) {
    const row = await prisma.conversation.findFirst({ where: { id, deletedAt: null }, select: { userId: true } });
    return row?.userId ?? null;
  } };
}
