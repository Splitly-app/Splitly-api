import { createClient } from "@supabase/supabase-js";

const url = Bun.env.SUPABASE_URL;
const key = Bun.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  throw new Error(
    "Set SUPABASE_URL and SUPABASE_SECRET_KEY before storage:setup",
  );
}
const storage = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
}).storage;
const id = "expense-proofs";
const options = {
  public: false,
  allowedMimeTypes: [
    "image/jpeg",
    "image/png",
    "image/webp",
    "application/pdf",
  ],
  fileSizeLimit: "5MB",
};
const { data: buckets, error: listError } = await storage.listBuckets();
if (listError) throw listError;
const result = buckets?.some((bucket) => bucket.id === id)
  ? await storage.updateBucket(id, options)
  : await storage.createBucket(id, options);
if (result.error) throw result.error;
console.log(`Private bucket ${id} is ready`);
