import { describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { readConfig } from "./config";

const makeApp = (
  resolveUser = async (_token: string) => null as { id: string } | null,
) =>
  createApp({
    allowedOrigins: ["https://app.example.com"],
    resolveUser,
    version: "test-sha",
  });

describe("authentication boundary", () => {
  test("rejects a missing token without calling the auth provider", async () => {
    let calls = 0;
    const app = makeApp(async () => {
      calls += 1;
      return { id: "user-a" };
    });
    const response = await app.handle(new Request("http://localhost/v1/me"));
    expect(response.status).toBe(401);
    expect(calls).toBe(0);
  });

  test("rejects a malformed bearer value", async () => {
    const app = makeApp(async () => ({ id: "user-a" }));
    const response = await app.handle(
      new Request("http://localhost/v1/me", {
        headers: { authorization: "Basic secret" },
      }),
    );
    expect(response.status).toBe(401);
  });

  test("rejects a token that failed verification", async () => {
    const response = await makeApp().handle(
      new Request("http://localhost/v1/me", {
        headers: { authorization: "Bearer expired-token" },
      }),
    );
    expect(response.status).toBe(401);
  });

  test("returns only the verified user's ID", async () => {
    const response = await makeApp(async (token) =>
      token === "valid-token" ? { id: "user-a" } : null,
    ).handle(
      new Request("http://localhost/v1/me", {
        headers: { authorization: "Bearer valid-token" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { id: "user-a" } });
  });

  test("reports a provider outage without exposing internal details", async () => {
    const response = await makeApp(async () => {
      throw new Error("private connection details");
    }).handle(
      new Request("http://localhost/v1/me", {
        headers: { authorization: "Bearer valid-token" },
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private connection");
  });
});

test("identifies the deployed release and supplies a request ID", async () => {
  const response = await makeApp().handle(
    new Request("http://localhost/healthz"),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("x-request-id")).toBeTruthy();
  expect(await response.json()).toEqual({ status: "ok", version: "test-sha" });
});

test("does not grant CORS access to an unlisted browser origin", async () => {
  const response = await makeApp().handle(
    new Request("http://localhost/v1/me", {
      method: "OPTIONS",
      headers: {
        origin: "https://untrusted.example",
        "access-control-request-method": "GET",
      },
    }),
  );
  expect(response.headers.get("access-control-allow-origin")).not.toBe(
    "https://untrusted.example",
  );
});

test("rejects incomplete deployment configuration", () => {
  expect(() => readConfig({})).toThrow();
  expect(() =>
    readConfig({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test",
      ALLOWED_ORIGINS: "*",
    }),
  ).toThrow();
});

test("serves Swagger UI and the documented bearer API only when enabled", async () => {
  const enabled = createApp({
    allowedOrigins: ["http://localhost:3003"],
    docsEnabled: true,
    resolveUser: async () => null,
    version: "test-sha",
  });
  const page = await enabled.handle(new Request("http://localhost/docs"));
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("swagger-ui");

  const specResponse = await enabled.handle(
    new Request("http://localhost/docs/json"),
  );
  expect(specResponse.status).toBe(200);
  const spec = await specResponse.json();
  expect(spec.paths["/healthz"].get).toBeDefined();
  expect(spec.paths["/v1/me"].get.security).toEqual([{ BearerAuth: [] }]);
  expect(spec.components.securitySchemes.BearerAuth).toMatchObject({
    type: "http",
    scheme: "bearer",
  });

  const disabled = await makeApp().handle(new Request("http://localhost/docs"));
  expect(disabled.status).toBe(404);
  const disabledSpec = await makeApp().handle(
    new Request("http://localhost/docs/json"),
  );
  expect(disabledSpec.status).toBe(404);
});

test("API docs stay disabled unless explicitly enabled", () => {
  const config = readConfig({
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "test",
    ALLOWED_ORIGINS: "http://localhost:3003",
  });
  expect(config.docsEnabled).toBe(false);
  expect(() =>
    readConfig({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test",
      ALLOWED_ORIGINS: "http://localhost:3003",
      API_DOCS_ENABLED: "yes",
    }),
  ).toThrow();
});
