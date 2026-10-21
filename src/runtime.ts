import { createClient } from "@supabase/supabase-js";
import { createApp } from "./application";
import type { readConfig } from "./config";
import { createRoomRepository } from "./modules/rooms/repository";
import { createRoomService } from "./modules/rooms/service";
import { createProofStorage } from "./modules/rooms/storage";

export function createRuntimeApp(config: ReturnType<typeof readConfig>) {
  const supabase = createClient(config.supabaseUrl, config.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const supabaseAdmin = config.supabaseSecretKey
    ? createClient(config.supabaseUrl, config.supabaseSecretKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : undefined;

  return createApp({
    allowedOrigins: config.allowedOrigins,
    docsEnabled: config.docsEnabled,
    version: config.version,
    log: (entry) => console.log(JSON.stringify(entry)),
    resolveUser: async (token) => {
      const { data, error } = await supabase.auth.getUser(token);
      if (error) {
        const status = "status" in error ? Number(error.status) : undefined;
        if (status === 400 || status === 401 || status === 403) return null;
        throw new Error("Auth verification unavailable");
      }
      return data.user ? { id: data.user.id } : null;
    },
    rooms: createRoomService(
      createRoomRepository(supabase, supabaseAdmin),
      supabaseAdmin ? createProofStorage(supabaseAdmin) : undefined,
    ),
  });
}
