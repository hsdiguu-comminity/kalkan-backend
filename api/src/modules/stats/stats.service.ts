/**
 * TR: Umut — Dashboard istatistikleri ve Python veri servisi (DATA_SERVICE_URL) entegrasyon katmanı.
 * EN: Umut — Dashboard statistics and Python data service integration layer.
 */
import { z } from "zod";
import type { ReportCategory } from "../reports/reports.service.js";

const resourceIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

const actorSchema = z.strictObject({
  userId: resourceIdSchema,
  role: z.enum(["user", "expert", "admin"]),
});

export type StatsActor = Readonly<z.infer<typeof actorSchema>>;

export const statsOverviewQuerySchema = z.strictObject({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

export interface DashboardStats {
  readonly totalReports: number;
  readonly verifiedThreats: number;
  readonly pendingReports: number;
  readonly categoryBreakdown: Readonly<Record<ReportCategory, number>>;
  readonly trendSummary: readonly {
    readonly date: string;
    readonly count: number;
  }[];
  readonly source: "data_service" | "local_fallback";
  readonly updatedAt: string;
}

export type StatsErrorCode =
  | "INVALID_PAYLOAD"
  | "UNAUTHENTICATED"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR";

const ERROR_META: Record<StatsErrorCode, { status: number; message: string }> = {
  INVALID_PAYLOAD: { status: 400, message: "Geçersiz istatistik sorgu parametresi." },
  UNAUTHENTICATED: { status: 401, message: "İstatistikleri görüntülemek için oturum açmalısınız." },
  SERVICE_UNAVAILABLE: { status: 503, message: "İstatistik servisi geçici olarak kullanılamıyor." },
  INTERNAL_ERROR: { status: 500, message: "İstatistikler hesaplanırken sunucu hatası oluştu." },
};

export class StatsServiceError extends Error {
  readonly code: StatsErrorCode;
  readonly status: number;

  constructor(code: StatsErrorCode, customMessage?: string) {
    const meta = ERROR_META[code];
    super(customMessage ?? meta.message);
    this.name = "StatsServiceError";
    this.code = code;
    this.status = meta.status;
  }

  toJSON(): { code: StatsErrorCode; message: string } {
    return {
      code: this.code,
      message: this.message,
    };
  }
}

export function validateStatsActor(raw: unknown): StatsActor {
  const parsed = actorSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StatsServiceError("UNAUTHENTICATED");
  }
  return parsed.data;
}

const externalDataServiceSchema = z.strictObject({
  totalReports: z.number().int().min(0),
  verifiedThreats: z.number().int().min(0),
  pendingReports: z.number().int().min(0),
  categoryBreakdown: z.strictObject({
    phishing_link: z.number().int().min(0),
    fake_sms: z.number().int().min(0),
    fraud_iban: z.number().int().min(0),
    malware: z.number().int().min(0),
    other: z.number().int().min(0),
  }),
  trendSummary: z.array(
    z.strictObject({
      date: z.string().min(1),
      count: z.number().int().min(0),
    })
  ),
});

export interface StatsDataProvider {
  getLocalSnapshot(days: number): Promise<Omit<DashboardStats, "source" | "updatedAt">>;
}

export class DefaultLocalStatsProvider implements StatsDataProvider {
  async getLocalSnapshot(_days: number): Promise<Omit<DashboardStats, "source" | "updatedAt">> {
    return {
      totalReports: 0,
      verifiedThreats: 0,
      pendingReports: 0,
      categoryBreakdown: {
        phishing_link: 0,
        fake_sms: 0,
        fraud_iban: 0,
        malware: 0,
        other: 0,
      },
      trendSummary: [],
    };
  }
}

export class StatsService {
  private readonly dataServiceUrl: string | undefined;

  constructor(
    private readonly localProvider: StatsDataProvider = new DefaultLocalStatsProvider(),
    dataServiceUrl: string | undefined = process.env.DATA_SERVICE_URL
  ) {
    this.dataServiceUrl = dataServiceUrl?.trim() ? dataServiceUrl.trim().replace(/\/+$/, "") : undefined;
  }

  async getOverview(actor: StatsActor, rawQuery: unknown): Promise<DashboardStats> {
    validateStatsActor(actor);

    const parsedQuery = statsOverviewQuerySchema.safeParse(rawQuery);
    if (!parsedQuery.success) {
      throw new StatsServiceError("INVALID_PAYLOAD");
    }

    const { days } = parsedQuery.data;

    if (this.dataServiceUrl) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);

        const response = await fetch(`${this.dataServiceUrl}/stats/overview?days=${days}`, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (response.ok) {
          const jsonBody: unknown = await response.json();
          const validated = externalDataServiceSchema.safeParse(jsonBody);
          if (validated.success) {
            return {
              ...validated.data,
              source: "data_service",
              updatedAt: new Date().toISOString(),
            };
          }
        }
      } catch {
        // Veri servisi henüz ayakta değilse yerel yedek veriye düşer.
      }
    }

    const fallback = await this.localProvider.getLocalSnapshot(days);
    return {
      ...fallback,
      source: "local_fallback",
      updatedAt: new Date().toISOString(),
    };
  }
}