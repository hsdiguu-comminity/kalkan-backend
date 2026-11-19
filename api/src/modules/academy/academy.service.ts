/**
 * TR: Umut — Farkındalık Akademisi (academy) eğitim modülleri ve ilerleme takibi iş mantığı.
 * EN: Umut — Awareness Academy training modules and user progress tracking logic.
 */
import { z } from "zod";

const resourceIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

const moduleLevelSchema = z.enum(["beginner", "intermediate", "advanced"]);

const actorSchema = z.strictObject({
  userId: resourceIdSchema,
  role: z.enum(["user", "expert", "admin"]),
});

export type AcademyActor = Readonly<z.infer<typeof actorSchema>>;
export type AcademyLevel = z.infer<typeof moduleLevelSchema>;

export const listModulesQuerySchema = z.strictObject({
  level: moduleLevelSchema.optional(),
});

export const completeModuleSchema = z.strictObject({
  score: z.number().int().min(0).max(100),
});

export interface AcademyModule {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly level: AcademyLevel;
  readonly estimatedMinutes: number;
}

export interface AcademyModuleDetail extends AcademyModule {
  readonly contentMarkdown: string;
}

export interface AcademyProgress {
  readonly moduleId: string;
  readonly userId: string;
  readonly completed: boolean;
  readonly score: number;
  readonly completedAt: string;
}

export type AcademyErrorCode =
  | "INVALID_PAYLOAD"
  | "UNAUTHENTICATED"
  | "NOT_FOUND"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR";

const ERROR_META: Record<AcademyErrorCode, { status: number; message: string }> = {
  INVALID_PAYLOAD: { status: 400, message: "Geçersiz akademi istek verisi gönderildi." },
  UNAUTHENTICATED: { status: 401, message: "Akademi modüllerine erişmek için oturum açmalısınız." },
  NOT_FOUND: { status: 404, message: "Eğitim modülü bulunamadı." },
  SERVICE_UNAVAILABLE: { status: 503, message: "Akademi servisi geçici olarak kullanılamıyor." },
  INTERNAL_ERROR: { status: 500, message: "Beklenmeyen bir sunucu hatası oluştu." },
};

export class AcademyServiceError extends Error {
  readonly code: AcademyErrorCode;
  readonly status: number;

  constructor(code: AcademyErrorCode, customMessage?: string) {
    const meta = ERROR_META[code];
    super(customMessage ?? meta.message);
    this.name = "AcademyServiceError";
    this.code = code;
    this.status = meta.status;
  }

  toJSON(): { code: AcademyErrorCode; message: string } {
    return {
      code: this.code,
      message: this.message,
    };
  }
}

export function validateAcademyActor(raw: unknown): AcademyActor {
  const parsed = actorSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AcademyServiceError("UNAUTHENTICATED");
  }
  return parsed.data;
}

const DEFAULT_MODULES: readonly AcademyModuleDetail[] = [
  {
    id: "mod_phishing_101",
    title: "Sahte SMS ve Oltalama (Phishing) Linklerini Tanıma",
    summary: "Kargo, banka ve kamu kurumu taklidi yapan zararlı bağlantıları ayırt etme rehberi.",
    level: "beginner",
    estimatedMinutes: 5,
    contentMarkdown:
      "# Sahte SMS ve Linkleri Nasıl Anlarsınız?\n\nResmi kurumlar SMS ile doğrudan giriş şifresi veya kart bilgisi istemez. Alan adını mutlaka kontrol edin.",
  },
  {
    id: "mod_iban_fraud_102",
    title: "IBAN Dolandırıcılığı ve Sosyal Mühendislik",
    summary: "İkinci el satış siteleri ve sahte dekont yöntemlerine karşı korunma adımları.",
    level: "intermediate",
    estimatedMinutes: 7,
    contentMarkdown:
      "# IBAN ve Sahte Dekont Tuzakları\n\nHesabınıza fiilen geçmeyen hiçbir havale dekontuna güvenmeyin ve tanımadığınız kişilere hesabınızı kullandırmayın.",
  },
  {
    id: "mod_2fa_security_201",
    title: "İki Aşamalı Doğrulama (2FA) ve Hesap Güvenliği",
    summary: "Parola sızıntılarına karşı authenticator uygulamaları ile hesaplarınızı kilitleyin.",
    level: "advanced",
    estimatedMinutes: 8,
    contentMarkdown:
      "# Güçlü Hesap Koruması\n\nSMS yerine doğrulama uygulaması (TOTP) kullanarak SIM kart kopyalama saldırılarına karşı koruma sağlayın.",
  },
];

export interface AcademyRepository {
  listModules(level?: AcademyLevel): Promise<AcademyModule[]>;
  findModuleById(id: string): Promise<AcademyModuleDetail | null>;
  saveProgress(progress: AcademyProgress): Promise<AcademyProgress>;
}

export class InMemoryAcademyRepository implements AcademyRepository {
  private readonly progressStore = new Map<string, AcademyProgress>();

  async listModules(level?: AcademyLevel): Promise<AcademyModule[]> {
    const filtered = level
      ? DEFAULT_MODULES.filter((mod) => mod.level === level)
      : DEFAULT_MODULES;

    return filtered.map(({ contentMarkdown: _ignored, ...summary }) => summary);
  }

  async findModuleById(id: string): Promise<AcademyModuleDetail | null> {
    return DEFAULT_MODULES.find((mod) => mod.id === id) ?? null;
  }

  async saveProgress(progress: AcademyProgress): Promise<AcademyProgress> {
    const key = `${progress.userId}:${progress.moduleId}`;
    this.progressStore.set(key, progress);
    return progress;
  }
}

export class AcademyService {
  constructor(private readonly repository: AcademyRepository = new InMemoryAcademyRepository()) {}

  async listModules(actor: AcademyActor, rawQuery: unknown): Promise<AcademyModule[]> {
    validateAcademyActor(actor);

    const parsed = listModulesQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new AcademyServiceError("INVALID_PAYLOAD");
    }

    return this.repository.listModules(parsed.data.level);
  }

  async getModuleById(actor: AcademyActor, rawId: unknown): Promise<AcademyModuleDetail> {
    validateAcademyActor(actor);

    const idParsed = resourceIdSchema.safeParse(rawId);
    if (!idParsed.success) {
      throw new AcademyServiceError("INVALID_PAYLOAD");
    }

    const found = await this.repository.findModuleById(idParsed.data);
    if (!found) {
      throw new AcademyServiceError("NOT_FOUND");
    }

    return found;
  }

  async completeModule(
    actor: AcademyActor,
    rawId: unknown,
    rawPayload: unknown
  ): Promise<AcademyProgress> {
    const moduleItem = await this.getModuleById(actor, rawId);

    const parsed = completeModuleSchema.safeParse(rawPayload);
    if (!parsed.success) {
      throw new AcademyServiceError("INVALID_PAYLOAD");
    }

    const progress: AcademyProgress = {
      moduleId: moduleItem.id,
      userId: actor.userId,
      completed: parsed.data.score >= 60,
      score: parsed.data.score,
      completedAt: new Date().toISOString(),
    };

    return this.repository.saveProgress(progress);
  }
}