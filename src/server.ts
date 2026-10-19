import { createClient } from "@supabase/supabase-js";
import { createApp } from "./app";
import { readConfig } from "./config";

const config = readConfig(Bun.env);
const supabase = createClient(config.supabaseUrl, config.supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const app = createApp({
  allowedOrigins: config.allowedOrigins,
  docsEnabled: config.docsEnabled,
  version: config.version,
  log: (entry) => console.log(JSON.stringify(entry)),
  resolveUser: async (token) => {
    // Remote verification works with asymmetric and legacy signing keys.
    // No JWT payload is trusted before verification.
    const { data, error } = await supabase.auth.getUser(token);
    if (error) {
      // Invalid/expired tokens are distinct from service outages.
      const status = "status" in error ? Number(error.status) : undefined;
      if (status === 400 || status === 401 || status === 403) return null;
      throw new Error("Auth verification unavailable");
    }
    return data.user ? { id: data.user.id } : null;
  },
}).listen({ port: config.port, hostname: config.host });

console.log(JSON.stringify({ event: "api_started", port: config.port }));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.stop();
    process.exit(0);
  });
}
