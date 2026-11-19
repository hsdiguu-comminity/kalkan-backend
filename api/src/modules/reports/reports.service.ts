/**
 * TR: Umut — İhbar (reports) CRUD iş mantığı, doğrulama ve kişisel veri maskeleme katmanı.
 * EN: Umut — Report CRUD business logic, validation and PII masking layer.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";

const resourceIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

const reportCategorySchema = z.enum([
  "phishing_link",
  "fake_sms",
  "fraud_iban",
  "malware",
  "other",
]);

const reportStatusSchema = z.enum(["pending", "verified", "rejected"]);

const actorSchema = z.strictObject({
  userId: resourceIdSchema,
  role: z.enum(["user", "expert", "admin"]),
});

export type ReportActor = Readonly<z.infer<typeof actorSchema>>;
export type ReportCategory = z.infer<typeof reportCategorySchema>;
export type ReportStatus = z.infer<typeof reportStatusSchema>;

export const createReportSchema = z.strictObject({
  category: reportCategorySchema,
  title: z.string().trim().min(3).max(150),
  description: z.string().trim().min(10).max(3000),
  targetValue: z.string().trim().min(1).max(500).optional(),
  evidenceUploadIds: z.array(resourceIdSchema).max(5).optional(),
});

export const updateReportSchema = z
  .strictObject({
    title: z.string().trim().min(3).max(150).optional(),
    description: z.string().trim().min(10).max(3000).optional(),
    targetValue: z.string().trim().min(1).max(500).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Güncelleme için en az bir alan gönderilmelidir.",
  });

export const listReportsQuerySchema = z.strictObject({
  status: reportStatusSchema.optional(),
  category: reportCategorySchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export interface ReportItem {
  readonly id: string;
  readonly userId: string;
  readonly category: ReportCategory;
  readonly title: string;
  readonly description: string;
  readonly targetValue: string | null;
  readonly evidenceUploadIds: readonly string[];
  readonly status: ReportStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReportListResponse {
  readonly items: readonly ReportItem[];
  readonly total: number;
  readonly page: number;
  readonly limit: number;
}

export type ReportErrorCode =
  | "INVALID_PAYLOAD"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "REPORT_LOCKED"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR";

const ERROR_META: Record<ReportErrorCode, { status: number; message: string }> = {
  INVALID_PAYLOAD: { status: 400, message: "Geçersiz istek verisi gönderildi." },
  UNAUTHENTICATED: { status: 401, message: "Bu işlem için oturum açmanız gerekiyor." },
  FORBIDDEN: { status: 403, message: "Bu ihbar üzerinde işlem yapma yetkiniz yok." },
  NOT_FOUND: { status: 404, message: "İhbar kaydı bulunamadı." },
  REPORT_LOCKED: { status: 409, message: "İncelenmiş veya sonuçlanmış ihbarlar düzenlenemez." },
  SERVICE_UNAVAILABLE: { status: 503, message: "Servis geçici olarak kullanılamıyor." },
  INTERNAL_ERROR: { status: 500, message: "Beklenmeyen bir sunucu hatası oluştu." },
};

export class ReportsServiceError extends Error {
  readonly code: ReportErrorCode;
  readonly status: number;

  constructor(code: ReportErrorCode, customMessage?: string) {
    const meta = ERROR_META[code];
    super(customMessage ?? meta.message);
    this.name = "ReportsServiceError";
    this.code = code;
    this.status = meta.status;
  }

  toJSON(): { code: ReportErrorCode; message: string } {
    return {
      code: this.code,
      message: this.message,
    };
  }
}

export function validateReportActor(raw: unknown): ReportActor {
  const parsed = actorSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ReportsServiceError("UNAUTHENTICATED");
  }
  return parsed.data;
}

/**
 * TR: KVKK gereği metin içindeki IBAN ve telefon numaralarını veritabanına yazmadan maskeler.
 * EN: Masks IBANs and Turkish phone numbers before persistence per KVKK rules.
 */
export function maskSensitiveText(text: string): string {
  const maskedIban = text.replace(/\bTR\d{2}[0-9A-Z]{22}\b/gi, (match) => {
    return `${match.slice(0, 4)}****************${match.slice(-4)}`;
  });

  return maskedIban.replace(/(?:\+90|0)?5\d{2}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}\b/g, (match) => {
    const digits = match.replace(/\D/g, "");
    return `${digits.slice(0, 4)}*****${digits.slice(-2)}`;
  });
}

/**
 * TR: Veritabanı adaptörü; Eren'in Prisma şeması bağlanana kadar bellek içi deposu da destekler.
 * EN: Persistence repository interface; supports in-memory fallback until Prisma schema is wired.
 */
export interface ReportsRepository {
  create(item: ReportItem): Promise<ReportItem>;
  findById(id: string): Promise<ReportItem | null>;
  list(params: {
    userId?: string;
    status?: ReportStatus;
    category?: ReportCategory;
    page: number;
    limit: number;
  }): Promise<{ items: ReportItem[]; total: number }>;
  update(
    id: string,
    patch: Partial<Pick<ReportItem, "title" | "description" | "targetValue" | "status" | "updatedAt">>
  ): Promise<ReportItem | null>;
  delete(id: string): Promise<boolean>;
}

export class InMemoryReportsRepository implements ReportsRepository {
  private readonly store = new Map<string, ReportItem>();

  async create(item: ReportItem): Promise<ReportItem> {
    this.store.set(item.id, item);
    return item;
  }

  async findById(id: string): Promise<ReportItem | null> {
    return this.store.get(id) ?? null;
  }

  async list(params: {
    userId?: string;
    status?: ReportStatus;
    category?: ReportCategory;
    page: number;
    limit: number;
  }): Promise<{ items: ReportItem[]; total: number }> {
    let all = Array.from(this.store.values());

    if (params.userId) {
      all = all.filter((r) => r.userId === params.userId);
    }
    if (params.status) {
      all = all.filter((r) => r.status === params.status);
    }
    if (params.category) {
      all = all.filter((r) => r.category === params.category);
    }

    all.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

    const total = all.length;
    const offset = (params.page - 1) * params.limit;
    const items = all.slice(offset, offset + params.limit);

    return { items, total };
  }

  async update(
    id: string,
    patch: Partial<Pick<ReportItem, "title" | "description" | "targetValue" | "status" | "updatedAt">>
  ): Promise<ReportItem | null> {
    const existing = this.store.get(id);
    if (!existing) return null;
    const updated: ReportItem = { ...existing, ...patch };
    this.store.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.store.delete(id);
  }
}

export class ReportsService {
  constructor(private readonly repository: ReportsRepository = new InMemoryReportsRepository()) {}

  async createReport(actor: ReportActor, rawPayload: unknown): Promise<ReportItem> {
    const parsed = createReportSchema.safeParse(rawPayload);
    if (!parsed.success) {
      throw new ReportsServiceError("INVALID_PAYLOAD");
    }

    const now = new Date().toISOString();
    const item: ReportItem = {
      id: `rep_${randomUUID().replace(/-/g, "")}`,
      userId: actor.userId,
      category: parsed.data.category,
      title: maskSensitiveText(parsed.data.title),
      description: maskSensitiveText(parsed.data.description),
      targetValue: parsed.data.targetValue ? maskSensitiveText(parsed.data.targetValue) : null,
      evidenceUploadIds: parsed.data.evidenceUploadIds ?? [],
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };

    return this.repository.create(item);
  }

  async listReports(actor: ReportActor, rawQuery: unknown): Promise<ReportListResponse> {
    const parsed = listReportsQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new ReportsServiceError("INVALID_PAYLOAD");
    }

    const { status, category, page, limit } = parsed.data;
    const scopedUserId = actor.role === "user" ? actor.userId : undefined;

    const result = await this.repository.list({
      ...(scopedUserId !== undefined ? { userId: scopedUserId } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(category !== undefined ? { category } : {}),
      page,
      limit,
    });

    return {
      items: result.items,
      total: result.total,
      page,
      limit,
    };
  }

  async getReportById(actor: ReportActor, rawId: unknown): Promise<ReportItem> {
    const idParsed = resourceIdSchema.safeParse(rawId);
    if (!idParsed.success) {
      throw new ReportsServiceError("INVALID_PAYLOAD");
    }

    const report = await this.repository.findById(idParsed.data);
    if (!report) {
      throw new ReportsServiceError("NOT_FOUND");
    }

    if (actor.role === "user" && report.userId !== actor.userId) {
      throw new ReportsServiceError("FORBIDDEN");
    }

    return report;
  }

  async updateReport(actor: ReportActor, rawId: unknown, rawPayload: unknown): Promise<ReportItem> {
    const report = await this.getReportById(actor, rawId);

    if (actor.role === "user" && report.userId !== actor.userId) {
      throw new ReportsServiceError("FORBIDDEN");
    }
    if (report.status !== "pending") {
      throw new ReportsServiceError("REPORT_LOCKED");
    }

    const parsed = updateReportSchema.safeParse(rawPayload);
    if (!parsed.success) {
      throw new ReportsServiceError("INVALID_PAYLOAD");
    }

    const updated = await this.repository.update(report.id, {
      ...(parsed.data.title !== undefined ? { title: maskSensitiveText(parsed.data.title) } : {}),
      ...(parsed.data.description !== undefined
        ? { description: maskSensitiveText(parsed.data.description) }
        : {}),
      ...(parsed.data.targetValue !== undefined
        ? { targetValue: maskSensitiveText(parsed.data.targetValue) }
        : {}),
      updatedAt: new Date().toISOString(),
    });

    if (!updated) {
      throw new ReportsServiceError("NOT_FOUND");
    }

    return updated;
  }

  /**
   * TR: Ayşe'nin (Kullanıcı-11) admin moderasyonu için kullanacağı durum güncelleme metodu.
   * EN: Moderation status update helper exposed for Ayşe's admin module.
   */
  async moderateReportStatus(
    actor: ReportActor,
    rawId: unknown,
    rawStatus: unknown
  ): Promise<ReportItem> {
    if (actor.role !== "admin" && actor.role !== "expert") {
      throw new ReportsServiceError("FORBIDDEN");
    }

    const idParsed = resourceIdSchema.safeParse(rawId);
    const statusParsed = reportStatusSchema.safeParse(rawStatus);
    if (!idParsed.success || !statusParsed.success) {
      throw new ReportsServiceError("INVALID_PAYLOAD");
    }

    const updated = await this.repository.update(idParsed.data, {
      status: statusParsed.data,
      updatedAt: new Date().toISOString(),
    });

    if (!updated) {
      throw new ReportsServiceError("NOT_FOUND");
    }

    return updated;
  }

  async deleteReport(actor: ReportActor, rawId: unknown): Promise<{ deleted: true }> {
    const report = await this.getReportById(actor, rawId);

    if (actor.role === "user" && report.userId !== actor.userId) {
      throw new ReportsServiceError("FORBIDDEN");
    }

    await this.repository.delete(report.id);
    return { deleted: true };
  }
}