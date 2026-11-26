// totp.service.ts'yi bellek içi depo ve sahte saatle sınar; anahtarlar yalnızca test değeridir.
import { describe, expect, it } from "vitest";
import { AppError } from "../../src/middlewares/errorHandler.js";
import {
  createTotpService,
  encodeBase32,
  generateTotp,
  timeStep,
  type TwoFactorRecord,
  type TwoFactorStore,
} from "../../src/modules/auth/totp.service.js";

const KEY = Buffer.alloc(32, 7);
const START = 1_800_000_000_000;
const USER = "user_1";

function decodeBase32(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let acc = 0;
  const bytes: number[] = [];
  for (const char of value) {
    acc = (acc << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// Prisma adaptörünün yerine geçen, sürüm kontrollü bellek içi depo.
function memoryStore() {
  const records = new Map<string, TwoFactorRecord>();
  const store: TwoFactorStore = {
    async find(userId) {
      const record = records.get(userId);
      return record ? { ...record } : null;
    },
    async save(userId, record, expectedVersion) {
      const current = records.get(userId);
      if ((current?.version ?? null) !== expectedVersion) return false;
      records.set(userId, { ...record });
      return true;
    },
  };
  return { store, records };
}

function setup() {
  const clock = { now: START };
  const { store, records } = memoryStore();
  const service = createTotpService({ store, encryptionKey: KEY, now: () => clock.now });
  const codeAt = (secret: Buffer, ms: number) => generateTotp(secret, timeStep(ms));
  return { clock, service, records, codeAt };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toSatisfy((error) => error instanceof AppError && error.code === code);
}

async function enabledUser() {
  const ctx = setup();
  const { secret } = await ctx.service.startSetup(USER, "amir@example.com");
  const raw = decodeBase32(secret);
  await ctx.service.enable(USER, ctx.codeAt(raw, ctx.clock.now));
  return { ...ctx, raw };
}

describe("RFC 6238 test vektörleri", () => {
  const secret = Buffer.from("12345678901234567890", "ascii");
  it.each([
    [59, "287082"],
    [1_111_111_109, "081804"],
    [1_234_567_890, "005924"],
    [2_000_000_000, "279037"],
  ])("T=%i saniyede kod %s", (seconds, code) => {
    expect(generateTotp(secret, timeStep(seconds * 1000))).toBe(code);
  });

  it("Base32 kodlaması RFC 4648 ile uyumludur", () => {
    expect(encodeBase32(secret)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });
});

describe("2FA kurulumu", () => {
  it("bekleyen kurulum üretir; gizli anahtar depoya şifreli yazılır", async () => {
    const { service, records } = setup();
    const result = await service.startSetup(USER, "amir@example.com");
    expect(result.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(result.expiresAt).toBe(new Date(START + 10 * 60_000).toISOString());
    expect(result.otpauthUrl).toBe(
      `otpauth://totp/Kalkan%3Aamir%40example.com?secret=${result.secret}` +
        "&issuer=Kalkan&algorithm=SHA1&digits=6&period=30",
    );
    const stored = records.get(USER);
    expect(stored?.enabled).toBe(false);
    expect(stored?.pendingSecret).toMatch(/^v1:/);
    expect(stored?.pendingSecret).not.toContain(result.secret);
    expect(await service.isEnabled(USER)).toBe(false);
  });

  it("doğru kodla 2FA açılır", async () => {
    const { service, records } = await enabledUser();
    expect(await service.isEnabled(USER)).toBe(true);
    expect(records.get(USER)?.pendingSecret).toBeNull();
  });

  it("yanlış veya biçimsiz kod INVALID_TOTP_CODE verir", async () => {
    const { service } = setup();
    await service.startSetup(USER, "amir@example.com");
    await expectCode(service.enable(USER, "000000"), "INVALID_TOTP_CODE");
    await expectCode(service.enable(USER, "12ab56"), "INVALID_TOTP_CODE");
    await expectCode(service.enable(USER, "1234567"), "INVALID_TOTP_CODE");
  });

  it("kurulum yoksa veya süresi dolduysa TWO_FACTOR_SETUP_REQUIRED verir", async () => {
    const { service, clock } = setup();
    await expectCode(service.enable(USER, "123456"), "TWO_FACTOR_SETUP_REQUIRED");
    await service.startSetup(USER, "amir@example.com");
    clock.now += 10 * 60_000;
    await expectCode(service.enable(USER, "123456"), "TWO_FACTOR_SETUP_REQUIRED");
  });

  it("2FA açıkken yeniden kurulum veya açma TWO_FACTOR_ALREADY_ENABLED verir", async () => {
    const { service } = await enabledUser();
    await expectCode(service.startSetup(USER, "amir@example.com"), "TWO_FACTOR_ALREADY_ENABLED");
    await expectCode(service.enable(USER, "123456"), "TWO_FACTOR_ALREADY_ENABLED");
  });
});

describe("Girişte doğrulama", () => {
  it("açılışta kullanılan kod tekrar kullanılamaz, sonraki adımın kodu kabul edilir", async () => {
    const { service, raw, clock, codeAt } = await enabledUser();
    expect(await service.verifyLogin(USER, codeAt(raw, clock.now))).toBe(false);
    clock.now += 30_000;
    expect(await service.verifyLogin(USER, codeAt(raw, clock.now))).toBe(true);
    expect(await service.verifyLogin(USER, codeAt(raw, clock.now))).toBe(false);
  });

  it("±1 adım saat kaymasını kabul eder, daha eskisini reddeder", async () => {
    const { service, raw, clock, codeAt } = await enabledUser();
    clock.now += 5 * 30_000;
    expect(await service.verifyLogin(USER, codeAt(raw, clock.now - 30_000))).toBe(true);
    clock.now += 5 * 30_000;
    expect(await service.verifyLogin(USER, codeAt(raw, clock.now - 60_000))).toBe(false);
  });

  it("aynı kodla eşzamanlı iki istekten yalnızca biri kabul edilir", async () => {
    const { service, raw, clock, codeAt } = await enabledUser();
    clock.now += 30_000;
    const code = codeAt(raw, clock.now);
    const results = await Promise.all([service.verifyLogin(USER, code), service.verifyLogin(USER, code)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("2FA kapalı kullanıcıda false döner", async () => {
    const { service } = setup();
    expect(await service.verifyLogin(USER, "123456")).toBe(false);
  });

  it("farklı anahtarla şifrelenmiş kayıt çözülemez", async () => {
    const { records } = await enabledUser();
    const other = createTotpService({
      store: { find: async () => records.get(USER) ?? null, save: async () => true },
      encryptionKey: Buffer.alloc(32, 9),
    });
    await expect(other.verifyLogin(USER, "123456")).rejects.toThrow();
  });
});

describe("2FA kapatma", () => {
  it("açık değilse TWO_FACTOR_NOT_ENABLED verir", async () => {
    const { service } = setup();
    await expectCode(service.disable(USER, "123456"), "TWO_FACTOR_NOT_ENABLED");
  });

  it("yanlış kodla kapatılamaz; doğru kodla kapanır ve anahtar silinir", async () => {
    const { service, raw, clock, codeAt, records } = await enabledUser();
    clock.now += 30_000;
    await expectCode(service.disable(USER, "000000"), "INVALID_TOTP_CODE");
    await service.disable(USER, codeAt(raw, clock.now));
    expect(await service.isEnabled(USER)).toBe(false);
    expect(records.get(USER)?.secret).toBeNull();
  });
});

it("32 bayt olmayan şifreleme anahtarı reddedilir", () => {
  expect(() => createTotpService({ store: memoryStore().store, encryptionKey: Buffer.alloc(16) }))
    .toThrow(RangeError);
});
