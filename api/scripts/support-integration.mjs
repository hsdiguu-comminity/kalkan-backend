// TR: İzole PostgreSQL test kümesi; gerçek DATABASE_URL asla kullanılmaz.
// EN: Isolated PostgreSQL test cluster; never use the application's DATABASE_URL.
import EmbeddedPostgres from "embedded-postgres";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, relative, isAbsolute } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

let database;
let directory;
let url = process.env.SUPPORT_TEST_DATABASE_URL;
async function command(file, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Test process exited: ${code}`)));
  });
}
try {
  if (url) {
    const parsed = new URL(url);
    if (!parsed.pathname.endsWith("_test")) throw new Error("SUPPORT_TEST_DATABASE_URL must name a dedicated *_test database.");
  } else {
    const reservation = createServer();
    await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    directory = await mkdtemp(join(tmpdir(), "kalkan-support-test-"));
    const password = randomBytes(24).toString("hex");
    database = new EmbeddedPostgres({ databaseDir: directory, user: "postgres", password, port,
      persistent: true, autoRehydrateSymlinks: true, initdbFlags: ["--encoding=UTF8", "--locale=C"],
      postgresFlags: ["-h", "127.0.0.1"], onLog: () => {}, onError: () => {} });
    if (process.platform === "win32") {
      // TR: Paket taskkill kullanır; pg_ctl Windows'ta çocuk süreçleri düzgün kapatır.
      // EN: Use graceful pg_ctl shutdown instead of the package's Windows taskkill tree shutdown.
      const { pg_ctl } = await import("@embedded-postgres/windows-x64");
      let stopped = false;
      database.stop = async () => {
        if (stopped) return;
        stopped = true;
        await new Promise((resolve, reject) => {
          const child = spawn(pg_ctl, ["stop", "-D", directory, "-m", "fast", "-w", "-t", "15"],
            { stdio: "ignore", windowsHide: true });
          child.once("error", reject);
          child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Temporary PostgreSQL shutdown failed")));
        });
      };
    }
    await database.initialise();
    await database.start();
    await database.createDatabase("kalkan_support_test");
    url = `postgresql://postgres:${password}@127.0.0.1:${port}/kalkan_support_test`;
  }
  const env = { ...process.env, DATABASE_URL: url, SUPPORT_TEST_DATABASE_URL: url };
  await command("node_modules/prisma/build/index.js", ["migrate", "deploy"], env);
  await command("node_modules/prisma/build/index.js", ["migrate", "diff", "--from-config-datasource",
    "--to-schema", "prisma/schema.prisma", "--exit-code"], env);
  await command("node_modules/vitest/vitest.mjs", ["run", "--config", "vitest.integration.config.ts"], env);
} catch (error) {
  // TR: Bağlantı URL/parola yazdırılmaz. EN: Never print connection URLs or passwords.
  console.error(error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/\S+/g, "[DATABASE]") : "Integration failed");
  process.exitCode = 1;
} finally {
  if (database) await database.stop();
  if (directory) {
    const target = resolve(directory);
    const inside = relative(resolve(tmpdir()), target);
    if (!isAbsolute(inside) && !inside.startsWith("..") && inside.startsWith("kalkan-support-test-")) {
      await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  }
}
