/**
 * TR: Umut — İhbar (reports) HTTP uç noktaları (CRUD); iş mantığı reports.service.ts içindedir.
 * EN: Umut — Report HTTP endpoints (CRUD); business logic lives in reports.service.ts.
 */
import { Router, json, type ErrorRequestHandler, type Request } from "express";
import {
  ReportsService,
  ReportsServiceError,
  validateReportActor,
  type ReportActor,
} from "./reports.service.js";

export interface ReportsRouterOptions {
  service?: ReportsService;
  resolvePrincipal(request: Request): Promise<unknown>;
}

export function createReportsRouter(options: ReportsRouterOptions): Router {
  const router = Router();
  const service = options.service ?? new ReportsService();
  const principals = new WeakMap<Request, ReportActor>();

  router.use(async (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    let rawActor: unknown;
    try {
      rawActor = await options.resolvePrincipal(request);
    } catch {
      throw new ReportsServiceError("SERVICE_UNAVAILABLE");
    }
    principals.set(request, validateReportActor(rawActor));
    next();
  });

  router.use(json({ limit: "32kb", strict: true, inflate: false }));

  function getActor(request: Request): ReportActor {
    return validateReportActor(principals.get(request));
  }

  router.get("/", async (request, response) => {
    const result = await service.listReports(getActor(request), request.query);
    response.json(result);
  });

  router.post("/", async (request, response) => {
    const created = await service.createReport(getActor(request), request.body);
    response.status(201).json(created);
  });

  router.get("/:reportId", async (request, response) => {
    const report = await service.getReportById(getActor(request), request.params.reportId);
    response.json(report);
  });

  router.patch("/:reportId", async (request, response) => {
    const updated = await service.updateReport(
      getActor(request),
      request.params.reportId,
      request.body
    );
    response.json(updated);
  });

  router.delete("/:reportId", async (request, response) => {
    const result = await service.deleteReport(getActor(request), request.params.reportId);
    response.json(result);
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
      error instanceof ReportsServiceError
        ? error
        : new ReportsServiceError(parserError ? "INVALID_PAYLOAD" : "INTERNAL_ERROR");

    if (failure.status === 401) {
      response.setHeader("WWW-Authenticate", "Bearer");
    }

    response.status(failure.status).json({ error: failure.toJSON() });
  };

  router.use(handleError);
  return router;
}