/**
 * TR: Hasti — Devir, durum, kabul ve kapanış için HTTP katmanı; iş mantığı servistedir.
 * EN: Hasti — HTTP layer for handoff, status, acceptance and closure; logic lives in the service.
 */
import { Router, json, type ErrorRequestHandler, type Request } from "express";
import {
  SupportServiceError,
  validateSupportActor,
  type HandoffService,
  type SupportActor,
} from "./handoff.service.js";

export interface SupportRouterOptions {
  service: HandoffService;
  /**
   * TR: Auth middleware/servisinden doğrulanmış aktör alınır; body/query asla kullanılmaz.
   * EN: Supply an authenticated principal from the auth layer, never from body/query fields.
   */
  resolvePrincipal(request: Request): Promise<unknown>;
}

/**
 * TR: Ana uygulama bu router'ı /support altında bağlar. Mesaj geçmişi henüz uygulanmadı.
 * EN: Mount this router at /support in the main app. Message history is not implemented yet.
 */
export function createSupportRouter(options: SupportRouterOptions): Router {
  const router = Router();
  const principals = new WeakMap<Request, SupportActor>();
  router.use(async (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    let value: unknown;
    try {
      value = await options.resolvePrincipal(request);
    } catch {
      throw new SupportServiceError("SERVICE_UNAVAILABLE");
    }
    principals.set(request, validateSupportActor(value));
    next();
  });
  router.use(json({ limit: "8kb", strict: true, inflate: false }));

  function actor(request: Request): SupportActor {
    return validateSupportActor(principals.get(request));
  }

  // TR: Yalnızca devir JSON gövdesi alır; diğer işlemlerde gövde ve bilinmeyen sorgu reddedilir.
  // EN: Only handoff accepts a JSON body; reject bodies on other actions and unknown query fields.
  function checkRequest(request: Request, allowBody = false): void {
    if (Object.keys(request.query).length !== 0 || (!allowBody && request.body !== undefined)) {
      throw new SupportServiceError("INVALID_PAYLOAD");
    }
    // JSON ayrıştırıcısının atladığı text/plain vb. gövdeler de kabul edilmez.
    const hasBody = request.headers["transfer-encoding"] !== undefined ||
      Number(request.headers["content-length"] ?? 0) > 0;
    if (hasBody && (!allowBody || !request.is("application/json"))) {
      throw new SupportServiceError("INVALID_PAYLOAD");
    }
  }

  // TR: Yeni oturum 201, mevcut açık oturum 200 döner; uzman atanmış olması gerekmez.
  // EN: Return 201 for a new session, 200 for an existing open one; an expert need not be assigned yet.
  router.post("/handoffs", async (request, response) => {
    checkRequest(request, true);
    const result = await options.service.requestHandoff(actor(request), request.body);
    response.status(result.created ? 201 : 200).json(result.session);
  });
  router.get("/sessions/:sessionId", async (request, response) => {
    checkRequest(request);
    response.json(await options.service.getSession(actor(request), request.params.sessionId));
  });
  router.post("/sessions/:sessionId/accept", async (request, response) => {
    checkRequest(request);
    response.json(await options.service.acceptSession(actor(request), request.params.sessionId));
  });
  router.post("/sessions/:sessionId/close", async (request, response) => {
    checkRequest(request);
    response.json(await options.service.closeSession(actor(request), request.params.sessionId));
  });

  // TR: Parser ve servis hatalarını ortak JSON zarfına çevirir; stack/ham hata göndermez.
  // EN: Normalize parser/service failures to the shared JSON envelope without exposing stack traces.
  const handleError: ErrorRequestHandler = (error: unknown, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const parserError = typeof error === "object" && error !== null && "type" in error &&
      ["entity.parse.failed", "entity.too.large", "encoding.unsupported", "charset.unsupported",
        "request.aborted", "request.size.invalid"].includes(String(error.type));
    const failure = error instanceof SupportServiceError ? error
      : new SupportServiceError(parserError ? "INVALID_PAYLOAD" : "INTERNAL_ERROR");
    if (failure.status === 401) response.setHeader("WWW-Authenticate", "Bearer");
    response.status(failure.status).json({ error: failure.toJSON() });
  };
  router.use(handleError);
  return router;
}
