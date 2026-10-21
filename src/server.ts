import { readConfig } from "./config";
import { createRuntimeApp } from "./runtime";

const config = readConfig(Bun.env);
const app = createRuntimeApp(config).listen({
  port: config.port,
  hostname: config.host,
});

console.log(JSON.stringify({ event: "api_started", port: config.port }));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.stop();
    process.exit(0);
  });
}
