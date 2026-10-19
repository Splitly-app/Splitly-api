export function readConfig(env: Record<string, string | undefined>) {
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_PUBLISHABLE_KEY;
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!supabaseUrl || !supabaseKey || allowedOrigins.length === 0) {
    throw new Error(
      "SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and ALLOWED_ORIGINS are required",
    );
  }
  new URL(supabaseUrl);
  for (const origin of allowedOrigins) {
    if (new URL(origin).origin !== origin) {
      throw new Error("ALLOWED_ORIGINS must contain exact URL origins");
    }
  }
  const port = Number(env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  const docsFlag = env.API_DOCS_ENABLED ?? "false";
  if (docsFlag !== "true" && docsFlag !== "false") {
    throw new Error("API_DOCS_ENABLED must be true or false");
  }
  return {
    supabaseUrl,
    supabaseKey,
    allowedOrigins,
    port,
    host: env.HOST ?? "0.0.0.0",
    version: env.APP_VERSION ?? "local",
    docsEnabled: docsFlag === "true",
  };
}
