import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("GET /health", () => {
  it("servisin ayakta olduğunu döner", async () => {
    const res = await request(createApp()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", service: "kalkan-api" });
  });
  it("reports unwired support explicitly", async () => {
    const res = await request(createApp()).post("/support/handoffs").send({ conversationId: "test" });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("SERVICE_UNAVAILABLE");
  });
});
