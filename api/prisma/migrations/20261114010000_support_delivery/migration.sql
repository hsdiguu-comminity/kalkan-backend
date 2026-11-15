-- TR: Eren'in ilk migration'ı korunur; mevcut mesajlar silinmez.
-- EN: Preserve the upstream initial migration and all existing messages.
ALTER TABLE "support_sessions" ADD COLUMN "last_message_sequence" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "support_messages"
  ADD COLUMN "client_message_id" UUID,
  ADD COLUMN "sequence" INTEGER,
  ADD COLUMN "content_fingerprint" VARCHAR(64);
WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "session_id" ORDER BY "created_at", "id")::INTEGER AS seq
  FROM "support_messages"
)
UPDATE "support_messages" m SET "sequence" = ranked.seq, "client_message_id" = gen_random_uuid()
FROM ranked WHERE m."id" = ranked."id";
UPDATE "support_sessions" s SET "last_message_sequence" = m.seq
FROM (SELECT "session_id", MAX("sequence") AS seq FROM "support_messages" GROUP BY "session_id") m
WHERE s."id" = m."session_id";
ALTER TABLE "support_messages" ALTER COLUMN "client_message_id" SET NOT NULL, ALTER COLUMN "sequence" SET NOT NULL;
ALTER TABLE "support_messages" ADD CONSTRAINT "support_message_sequence_positive" CHECK ("sequence" > 0);
CREATE UNIQUE INDEX "support_messages_session_id_sender_id_client_message_id_key"
  ON "support_messages"("session_id", "sender_id", "client_message_id");
CREATE UNIQUE INDEX "support_messages_session_id_sequence_key" ON "support_messages"("session_id", "sequence");
ALTER TABLE "support_outbox_events"
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "lease_token" TEXT,
  ADD COLUMN "lease_expires_at" TIMESTAMP(3),
  ADD COLUMN "last_error_code" VARCHAR(40);
CREATE INDEX "support_outbox_delivery_due_idx"
  ON "support_outbox_events"("processed_at", "next_attempt_at", "lease_expires_at");
