/**
 * Amir Ali — Ortak hata yönetimi: her hatayı { error: { code, message } } JSON zarfına çevirir.
 * İstemciye stack trace, ham hata mesajı veya kullanıcı girdisi gönderilmez.
 */
import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";

// Kod -> [HTTP durumu, Türkçe kullanıcı mesajı]. Kodlar docs/api/openapi.yaml ile aynıdır.
const errorDefinitions = {
  INVALID_PAYLOAD: [400, "İstek geçersiz. Lütfen gönderdiğiniz bilgileri kontrol edin."],
  INVALID_TOTP_CODE: [400, "Doğrulama kodu geçersiz veya süresi dolmuş."],
  UNAUTHENTICATED: [401, "Oturum doğrulanamadı. Lütfen yeniden giriş yapın."],
  FORBIDDEN: [403, "Bu işlem için yetkiniz yok."],
  NOT_FOUND: [404, "İstenen kaynak bulunamadı."],
  TWO_FACTOR_ALREADY_ENABLED: [409, "İki adımlı doğrulama zaten açık."],
  TWO_FACTOR_NOT_ENABLED: [409, "İki adımlı doğrulama açık değil."],
  TWO_FACTOR_SETUP_REQUIRED: [409, "Önce iki adımlı doğrulama kurulumunu başlatın."],
  RATE_LIMITED: [429, "Çok fazla istek gönderildi. Lütfen biraz sonra tekrar deneyin."],
  INTERNAL_ERROR: [500, "Beklenmeyen bir hata oluştu. Lütfen daha sonra tekrar deneyin."],
  SERVICE_UNAVAILABLE: [503, "Servis geçici olarak kullanılamıyor. Lütfen daha sonra tekrar deneyin."],
} as const satisfies Record<string, readonly [number, string]>;

export type AppErrorCode = keyof typeof errorDefinitions;

export interface AppErrorBody {
  code: AppErrorCode;
  message: string;
  retryAfterSeconds?: number;
}

export interface AppErrorOptions {
  /** Yalnızca RATE_LIMITED için; saniye, en az 1. */
  retryAfterSeconds?: number;
  /** Sunucu loglarında görünür; istemciye gönderilmez. */
  cause?: unknown;
}

/**
 * Modüllerin fırlatacağı ortak hata. Mesaj koddan gelir; serbest metin kabul edilmez
 * ki kullanıcı girdisi veya iç ayrıntı istemciye sızmasın.
 */
export class AppError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;

  constructor(readonly code: AppErrorCode, options: AppErrorOptions = {}) {
    const [status, message] = errorDefinitions[code];
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.status = status;
    this.retryAfterSeconds = code === "RATE_LIMITED"
      ? normalizeRetryAfter(options.retryAfterSeconds)
      : undefined;
  }

  toJSON(): AppErrorBody {
    return this.retryAfterSeconds === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, retryAfterSeconds: this.retryAfterSeconds };
  }
}

function normalizeRetryAfter(seconds: number | undefined): number {
  return seconds !== undefined && Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : 1;
}

// express.json() (body-parser) hata türleri; hepsi 400 INVALID_PAYLOAD olur (sözleşme).
const PARSER_ERROR_TYPES = new Set([
  "entity.parse.failed",
  "entity.too.large",
  "encoding.unsupported",
  "charset.unsupported",
  "request.aborted",
  "request.size.invalid",
]);

function isParserError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "type" in error &&
    PARSER_ERROR_TYPES.has(String(error.type));
}

function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError || isParserError(error)) {
    return new AppError("INVALID_PAYLOAD", { cause: error });
  }
  return new AppError("INTERNAL_ERROR", { cause: error });
}

export interface ErrorHandlerOptions {
  /**
   * 5xx hatalarını loglar. Varsayılan console.error; istek gövdesi loglanmaz.
   */
  log?: (error: unknown) => void;
}

/**
 * app.ts içinde tüm router'lardan sonra en son middleware olarak bağlanır.
 */
export function createErrorHandler(options: ErrorHandlerOptions = {}): ErrorRequestHandler {
  const log = options.log ?? ((error: unknown) => console.error("[errorHandler]", error));

  return (error: unknown, _request, response, next) => {
    // Yanıt yazılmaya başladıysa Express'in varsayılan işleyicisi bağlantıyı kapatır.
    if (response.headersSent) {
      next(error);
      return;
    }
    const failure = toAppError(error);
    if (failure.status >= 500) log(failure.cause ?? failure);

    response.setHeader("Cache-Control", "no-store");
    if (failure.status === 401) response.setHeader("WWW-Authenticate", "Bearer");
    if (failure.retryAfterSeconds !== undefined) {
      response.setHeader("Retry-After", String(failure.retryAfterSeconds));
    }
    response.status(failure.status).json({ error: failure.toJSON() });
  };
}

/**
 * Hiçbir yolla eşleşmeyen istekler için 404 NOT_FOUND; hata işleyiciden hemen önce bağlanır.
 */
export const notFoundHandler: RequestHandler = (_request, _response, next) => {
  next(new AppError("NOT_FOUND"));
};
