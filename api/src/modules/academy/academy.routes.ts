/**
 * TR: Umut — Farkındalık Akademisi (academy) HTTP uç noktaları; iş mantığı academy.service.ts içindedir.
 * EN: Umut — Awareness Academy HTTP endpoints; business logic lives in academy.service.ts.
 */
import { Router, json, type ErrorRequestHandler, type Request } from "express";
import {
  AcademyService,
  AcademyServiceError,
  validateAcademyActor,
  type AcademyActor,
} from "./academy.service.js";

export interface AcademyRouterOptions {
  service?: AcademyService;
  resolvePrincipal(request: Request): Promise<unknown>;
}

export function createAcademyRouter(options: AcademyRouterOptions): Router {
  const router = Router();
  const service = options.service ?? new AcademyService();
  const principals = new WeakMap<Request, AcademyActor>();

  router.use(async (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    let rawActor: unknown;
    try {
      rawActor = await options.resolvePrincipal(request);
    } catch {
      throw new AcademyServiceError("SERVICE_UNAVAILABLE");
    }
    principals.set(request, validateAcademyActor(rawActor));
    next();
  });

  router.use(json({ limit: "16kb", strict: true, inflate: false }));

  function getActor(request: Request): AcademyActor {
    return validateAcademyActor(principals.get(request));
  }

  router.get("/modules", async (request, response) => {
    const modules = await service.listModules(getActor(request), request.query);
    response.json(modules);
  });

  router.get("/modules/:moduleId", async (request, response) => {
    const detail = await service.getModuleById(getActor(request), request.params.moduleId);
    response.json(detail);
  });

  router.post("/modules/:moduleId/complete", async (request, response) => {
    const progress = await service.completeModule(
      getActor(request),
      request.params.moduleId,
      request.body
    );
    response.json(progress);
  });

  const handleError: ErrorRequestHandler = (error: unknown, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }

    const parserError =
      typeof error === "object" &&
      error !== null &&
      "type" in error &&
      [
        "entity.parse.failed",
        "entity.too.large",
        "encoding.unsupported",
        "charset.unsupported",
        "request.aborted",
        "request.size.invalid",
      ].includes(String(error.type));

    const failure =
      error instanceof AcademyServiceError
        ? error
        : new AcademyServiceError(parserError ? "INVALID_PAYLOAD" : "INTERNAL_ERROR");

    if (failure.status === 401) {
      response.setHeader("WWW-Authenticate", "Bearer");
    }

    response.status(failure.status).json({ error: failure.toJSON() });
  };

  router.use(handleError);
  return router;
}