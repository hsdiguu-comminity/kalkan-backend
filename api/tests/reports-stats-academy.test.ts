/**
 * TR: Umut — Reports, Stats ve Academy modülleri için Vitest + Supertest entegrasyon testleri.
 * EN: Umut — Vitest + Supertest integration tests for Reports, Stats and Academy modules.
 */
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createReportsRouter } from "../src/modules/reports/reports.routes.js";
import { createStatsRouter } from "../src/modules/stats/stats.routes.js";
import { createAcademyRouter } from "../src/modules/academy/academy.routes.js";

function buildTestApp(actor: unknown = { userId: "user_umut_1", role: "user" }) {
  const app = express();
  const resolvePrincipal = async () => actor;

  app.use("/api/reports", createReportsRouter({ resolvePrincipal }));
  app.use("/api/stats", createStatsRouter({ resolvePrincipal }));
  app.use("/api/academy", createAcademyRouter({ resolvePrincipal }));

  return app;
}

describe("Reports, Stats & Academy Modülleri", () => {
  it("KVKK gereği ihbar içindeki IBAN ve telefon numarasını maskeler ve CRUD işlemlerini yapar", async () => {
    const app = buildTestApp();

    // 1. Yeni ihbar oluşturma (POST)
    const createRes = await request(app)
      .post("/api/reports")
      .send({
        category: "fraud_iban",
        title: "Sahte kargo dolandırıcılığı",
        description: "Beni 0532 123 45 67 numarasından arayıp TR120006100519786457841326 hesabına para istediler.",
        targetValue: "TR120006100519786457841326",
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.id).toMatch(/^rep_/);
    expect(createRes.body.description).not.toContain("0532 123 45 67");
    expect(createRes.body.description).not.toContain("TR120006100519786457841326");
    expect(createRes.body.targetValue).toBe("TR12****************1326");

    const reportId = createRes.body.id as string;

    // 2. İhbar listeleme (GET)
    const listRes = await request(app).get("/api/reports");
    expect(listRes.status).toBe(200);
    expect(listRes.body.total).toBe(1);

    // 3. İhbar güncelleme (PATCH)
    const patchRes = await request(app)
      .patch(`/api/reports/${reportId}`)
      .send({ title: "Güncellenmiş dolandırıcılık ihbarı" });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.title).toBe("Güncellenmiş dolandırıcılık ihbarı");

    // 4. İhbar silme (DELETE)
    const deleteRes = await request(app).delete(`/api/reports/${reportId}`);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body).toEqual({ deleted: true });
  });

  it("Yetkisiz kullanıcıya 401 döner", async () => {
    const app = buildTestApp(null);
    const res = await request(app).get("/api/reports");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("Dashboard istatistiklerini fallback modunda sorunsuz döner", async () => {
    const app = buildTestApp();
    const res = await request(app).get("/api/stats/overview?days=7");
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("local_fallback");
    expect(res.body.totalReports).toBe(0);
  });

  it("Akademi eğitim modüllerini listeler ve tamamlama puanını kaydeder", async () => {
    const app = buildTestApp();

    const modulesRes = await request(app).get("/api/academy/modules?level=beginner");
    expect(modulesRes.status).toBe(200);
    expect(modulesRes.body.length).toBeGreaterThan(0);

    const moduleId = modulesRes.body[0].id as string;

    const completeRes = await request(app)
      .post(`/api/academy/modules/${moduleId}/complete`)
      .send({ score: 85 });

    expect(completeRes.status).toBe(200);
    expect(completeRes.body.completed).toBe(true);
    expect(completeRes.body.score).toBe(85);
  });
});