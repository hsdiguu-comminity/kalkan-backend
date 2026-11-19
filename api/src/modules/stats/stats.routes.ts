/**
 * TR: Umut — İstatistik (stats) HTTP uç noktaları; iş mantığı stats.service.ts içindedir.
 * EN: Umut — Statistics HTTP endpoints; business logic lives in stats.service.ts.
 */
import { Router, type ErrorRequestHandler, type Request } from "express";
import {
  StatsService,
  StatsServiceError,
  validateStatsActor,
  type StatsActor,
} from "./stats.service.js";

export interface StatsRouterOptions {
  service?: StatsService;
  resolvePrincipal(request: Request): Promise<unknown>;
}

export function createStatsRouter(options: StatsRouterOptions): Router {
  const router = Router();
  const service = options.service ?? new StatsService();
  const principals = new WeakMap<Request, StatsActor>();

  router.use(async (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    let rawActor: unknown;
    try {
      rawActor = await options.resolvePrincipal(request);
    } catch {
      throw new StatsServiceError("SERVICE_UNAVAILABLE");
    }
    principals.set(request, validateStatsActor(rawActor));
    next();
  });

  function getActor(request: Request): StatsActor {
    return validateStatsActor(principals.get(request));
  }

  router.get("/overview", async (request, response) => {
    const overview = await service.getOverview(getActor(request), request.query);
    response.json(overview);
  });

  const handleError: ErrorRequestHandler = (error: unknown, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }

    const failure =
      error instanceof StatsServiceError
        ? error
        : new StatsServiceError("INTERNAL_ERROR");

    if (failure.status === 401) {
      response.setHeader("WWW-Authenticate", "Bearer");
    }

    response.status(failure.status).json({ error: failure.toJSON() });
  };

  router.use(handleError);
  return router;
}