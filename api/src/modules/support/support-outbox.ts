/** TR: Kalıcı lease, yeniden deneme ve tekilleştirilmiş bildirim. EN: Durable leases, retries and idempotent notices. */
import { createHash, randomUUID } from "node:crypto";
import type { Queue } from "bullmq";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { sessionFromRow } from "./prisma-support.store.js";

export interface SupportDelivery {
  eventId: string;
  sessionId: string;
}
export function createBullMqSupportPublisher(queue: Pick<Queue, "add">) {
  return async (delivery: SupportDelivery): Promise<void> => {
    // TR: BullMQ kimliğinde ':' yoktur; kuyrukta kişisel veri/metin taşınmaz.
    // EN: BullMQ IDs contain no colons; queue payloads contain no identities or message text.
    const jobId = `support-${createHash("sha256").update(delivery.eventId).digest("hex")}`;
    await queue.add("support.reconcile", delivery, { jobId, attempts: 8,
      backoff: { type: "exponential", delay: 1000 }, removeOnComplete: false, removeOnFail: false });
  };
}
export interface SupportOutboxOptions {
  prisma: PrismaClient;
  publish(delivery: SupportDelivery): Promise<void>;
  publishSessionUpdate(sessionId: string): Promise<void>;
  now?: () => Date;
  leaseMs?: number;
  deliveryTimeoutMs?: number;
}

export function createSupportOutboxDispatcher(options: SupportOutboxOptions) {
  const now = options.now ?? (() => new Date());
  const leaseMs = options.leaseMs ?? 30_000;
  const deliveryTimeoutMs = options.deliveryTimeoutMs ?? 10_000;
  if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300_000) throw new TypeError("Geçersiz lease süresi.");
  if (!Number.isInteger(deliveryTimeoutMs) || deliveryTimeoutMs < 50 || deliveryTimeoutMs >= leaseMs) {
    throw new TypeError("Teslim timeout'u lease süresinden kısa olmalı.");
  }
  const db = options.prisma;
  async function runOnce(limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("Geçersiz batch boyutu.");
    const due = () => ({ processedAt: null, nextAttemptAt: { lte: now() },
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now() } }] });
    const rows = await db.supportOutboxEvent.findMany({ where: due(), orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: limit });
    let delivered = 0;
    let failed = 0;
    for (const row of rows) {
      const leaseToken = randomUUID();
      const claim = await db.supportOutboxEvent.updateMany({ where: { id: row.id, ...due() },
        data: { leaseToken, leaseExpiresAt: new Date(now().getTime() + leaseMs), attempts: { increment: 1 } } });
      if (claim.count !== 1) continue;
      try {
        // TR: Kuyruk tüketicisi ID ile güncel durumu yeniden okur. EN: Consumer reloads current state by ID.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            (async () => {
              await options.publish({ eventId: row.id, sessionId: row.sessionId });
              await options.publishSessionUpdate(row.sessionId);
            })(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error("delivery_timeout")), deliveryTimeoutMs);
              timer.unref();
            }),
          ]);
        } finally { clearTimeout(timer); }
        await db.$transaction(async (tx) => {
          // TR: Süresi dolmuş işçi tamamlandı işaretleyemez. EN: A stale worker cannot finalize another lease.
          const owned = await tx.supportOutboxEvent.updateMany({ where: { id: row.id, leaseToken,
            leaseExpiresAt: { gt: now() }, processedAt: null },
            data: { processedAt: now(), leaseToken: null, leaseExpiresAt: null, lastErrorCode: null } });
          if (owned.count !== 1) throw new Error("lease_lost");
          const current = await tx.supportSession.findUniqueOrThrow({ where: { id: row.sessionId } });
          const recipients = [...new Set([current.userId, current.agentId].filter((id): id is string => id !== null))];
          const body = { queued: "Destek talebiniz sıraya alındı.", active: "Destek görüşmeniz başladı.",
            closed: "Destek görüşmeniz kapatıldı." }[current.status];
          for (const userId of recipients) {
            const id = `support-${createHash("sha256").update(`${current.id}:${current.revision}:${userId}`).digest("hex")}`;
            await tx.notification.upsert({ where: { id }, update: {}, create: { id, userId,
              type: "support_update", title: "Canlı destek", body, link: `/support/sessions/${current.id}` } });
          }
        });
        delivered++;
      } catch {
        failed++;
        await db.supportOutboxEvent.updateMany({ where: { id: row.id, leaseToken, processedAt: null },
          data: { leaseToken: null, leaseExpiresAt: null, lastErrorCode: "DELIVERY_FAILED",
            nextAttemptAt: new Date(now().getTime() + Math.min(1000 * 2 ** Math.min(row.attempts, 8), 300_000)) } });
      }
    }
    return { delivered, failed };
  }
  return { runOnce };
}

/** TR: Seyit'in worker'ına geç güncel durum verilir. EN: Feed current state, never a stale event snapshot, to the team worker. */
export function createSupportQueueHandler(prisma: PrismaClient,
  reconcile: (session: ReturnType<typeof sessionFromRow>, eventId: string) => Promise<void>) {
  return async (input: unknown) => {
    if (!input || typeof input !== "object" || !("eventId" in input) || !("sessionId" in input) ||
        typeof input.eventId !== "string" || typeof input.sessionId !== "string" ||
        Object.keys(input).some((key) => !["eventId", "sessionId"].includes(key))) throw new TypeError("Geçersiz kuyruk verisi.");
    const event = await prisma.supportOutboxEvent.findUnique({ where: { id: input.eventId } });
    if (!event || event.sessionId !== input.sessionId) throw new TypeError("Kuyruk olayı bulunamadı.");
    const current = await prisma.supportSession.findUnique({ where: { id: input.sessionId } });
    if (!current) return;
    // TR: reconcile atomik revision kontrolüyle idempotent olmalı. EN: Reconcile must enforce revision atomically and be idempotent.
    await reconcile(sessionFromRow(current), event.id);
  };
}
