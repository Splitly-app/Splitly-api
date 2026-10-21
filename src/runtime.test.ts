import { expect, test } from "bun:test";
import { readConfig } from "./config";
import { createRuntimeApp } from "./runtime";

test("preview entry serves health without opening a listening socket", async () => {
  const config = readConfig({
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "publishable-example",
    ALLOWED_ORIGINS: "https://splitly-preview.vercel.app",
    APP_VERSION: "0.1.0",
  });
  const app = createRuntimeApp(config);
  const response = await app.handle(
    new Request("https://api.example.test/healthz"),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok", version: "0.1.0" });
  expect(app.server).toBeNull();
});
