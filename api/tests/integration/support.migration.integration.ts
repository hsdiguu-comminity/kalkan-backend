// TR: Eski mesajları olan şema üzerinde yükseltme. EN: Upgrade a legacy schema containing messages.
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { expect, it } from "vitest";

it("preserves legacy messages and backfills ordered cursors without inventing raw fingerprints", async () => {
  const url = process.env.SUPPORT_TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("Dedicated test DB required");
  const client = new Client({ connectionString: url });
  await client.connect();
  // TR: Ad yalnızca üretilen hex içerir. EN: Identifier contains only generated hexadecimal characters.
  const schema = `migration_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query(await readFile("prisma/migrations/20261114000000_init/migration.sql", "utf8"));
    await client.query(`INSERT INTO users (id,email,password_hash,role,updated_at) VALUES ('legacy_user','legacy@example.test','test','user',NOW())`);
    await client.query(`INSERT INTO conversations (id,user_id,updated_at) VALUES ('legacy_chat','legacy_user',NOW())`);
    await client.query(`INSERT INTO support_sessions (id,conversation_id,user_id,source,updated_at)
      VALUES ('legacy_session','legacy_chat','legacy_user','user_request',NOW())`);
    await client.query(`INSERT INTO support_messages (id,session_id,sender_id,sender_role,content,created_at)
      VALUES ('msg_b','legacy_session','legacy_user','user','masked second','2026-01-02'),
      ('msg_a','legacy_session','legacy_user','user','masked first','2026-01-01')`);
    await client.query(await readFile("prisma/migrations/20261114010000_support_delivery/migration.sql", "utf8"));
    const { rows } = await client.query("SELECT id,content,sequence,client_message_id,content_fingerprint FROM support_messages ORDER BY sequence");
    expect(rows).toEqual([
      expect.objectContaining({ id: "msg_a", content: "masked first", sequence: 1, content_fingerprint: null }),
      expect.objectContaining({ id: "msg_b", content: "masked second", sequence: 2, content_fingerprint: null }),
    ]);
    expect(new Set(rows.map((row) => row.client_message_id)).size).toBe(2);
    expect((await client.query("SELECT last_message_sequence FROM support_sessions")).rows[0].last_message_sequence).toBe(2);
  } finally {
    // TR: Test DDL dahil geri alınır, diğer şemalara dokunulmaz. EN: Roll back all test DDL without touching other schemas.
    await client.query("ROLLBACK");
    await client.end();
  }
});
