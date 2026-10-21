import type { SupabaseClient } from "@supabase/supabase-js";
import { type ProofStorage, RoomError } from "./service";

const bucketName = "expense-proofs";
function signature(bytes: Uint8Array): string {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return "image/jpeg";
  if (
    bytes.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, index) => bytes[index] === value,
    )
  ) {
    return "image/png";
  }
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.slice(start, end));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP")
    return "image/webp";
  if (bytes.length >= 5 && ascii(0, 5) === "%PDF-") return "application/pdf";
  return "unknown";
}
export function createProofStorage(client: SupabaseClient): ProofStorage {
  const bucket = client.storage.from(bucketName);
  return {
    async createUpload(path) {
      const { data, error } = await bucket.createSignedUploadUrl(path);
      if (error || !data)
        throw new RoomError(503, "Could not prepare proof upload");
      return { token: data.token };
    },
    async inspect(path) {
      const [info, download] = await Promise.all([
        bucket.info(path),
        bucket.download(path),
      ]);
      if (info.error || !info.data || download.error || !download.data)
        return null;
      const bytes = new Uint8Array(
        await download.data.slice(0, 16).arrayBuffer(),
      );
      return {
        mimeType: info.data.contentType ?? "",
        sizeBytes: info.data.size ?? download.data.size,
        signature: signature(bytes),
      };
    },
    async createReadUrl(path) {
      const { data, error } = await bucket.createSignedUrl(path, 60);
      if (error || !data) throw new RoomError(503, "Could not open proof");
      return data.signedUrl;
    },
    async remove(path) {
      const { error } = await bucket.remove([path]);
      if (error) throw new RoomError(503, "Could not remove old proof");
    },
  };
}
