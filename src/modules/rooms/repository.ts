import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type MemberSession,
  type ProofRecord,
  RoomError,
  type RoomRecord,
  type RoomRepository,
} from "./service";

function mapRpcError(message: string): never {
  if (
    message.includes("DUPLICATE_PARTICIPANT") ||
    message.includes("duplicate key")
  ) {
    throw new RoomError(409, "Participant already exists");
  }
  if (message.includes("INVALID_") || message.includes("ROOM_FULL")) {
    throw new RoomError(422, "Invalid room data");
  }
  throw new RoomError(503, "Database unavailable");
}
function unwrap<T>(data: unknown): T | null {
  if (data === null) return null;
  if (!data || typeof data !== "object")
    throw new RoomError(503, "Database response unavailable");
  if ("error" in data) {
    const code = String(data.error);
    if (code === "INVALID_PIN" || code === "INVALID_RECOVERY")
      throw new RoomError(401, "PIN or recovery code is incorrect");
    if (code === "LOCKED")
      throw new RoomError(429, "Too many attempts. Try again in 15 minutes");
    if (code === "CLAIMED")
      throw new RoomError(409, "This name has already been claimed");
    if (code === "FORBIDDEN")
      throw new RoomError(403, "Only the payer can change this expense");
    if (code === "INVALID_MEMBERS")
      throw new RoomError(422, "Choose at least one eligible participant");
    throw new RoomError(503, "Database response unavailable");
  }
  return data as T;
}
export function createRoomRepository(
  client: SupabaseClient,
  admin?: SupabaseClient,
): RoomRepository {
  async function rpc<T>(
    name: string,
    args: Record<string, unknown>,
    privileged = false,
  ): Promise<T | null> {
    const connection = privileged ? admin : client;
    if (!connection) throw new RoomError(503, "Proof storage unavailable");
    const { data, error } = await connection.rpc(name, args);
    if (error) mapRpcError(error.message);
    return unwrap<T>(data);
  }
  return {
    async create(name, participants) {
      const result = await rpc<{ token: string; room: RoomRecord }>(
        "splitly_create_room",
        {
          p_name: name,
          p_names: participants,
        },
      );
      if (!result?.token || !result.room)
        throw new RoomError(503, "Database response unavailable");
      // A newly-created room has no member session yet.
      const room = await rpc<RoomRecord>("splitly_read_room_v2", {
        p_token: result.token,
        p_member_token: null,
      });
      if (!room) throw new RoomError(503, "Database response unavailable");
      return { token: result.token, room };
    },
    read(token, memberToken) {
      return rpc<RoomRecord>("splitly_read_room_v2", {
        p_token: token,
        p_member_token: memberToken ?? null,
      });
    },
    selectMember(token, participantId, pin) {
      return rpc<MemberSession>("splitly_select_member", {
        p_token: token,
        p_participant_id: participantId,
        p_pin: pin,
      });
    },
    recoverMember(token, participantId, code, pin) {
      return rpc<MemberSession>("splitly_recover_member", {
        p_token: token,
        p_participant_id: participantId,
        p_code: code,
        p_new_pin: pin,
      });
    },
    async addParticipant(token, name, pin) {
      const result = await rpc<{
        room: RoomRecord;
        memberToken: string;
        participantId: string;
        recoveryCode: string;
      }>("splitly_add_participant_v2", {
        p_token: token,
        p_name: name,
        p_pin: pin,
      });
      if (!result) return null;
      return {
        room: result.room,
        session: {
          memberToken: result.memberToken,
          participantId: result.participantId,
          recoveryCode: result.recoveryCode,
        },
      };
    },
    addExpense(token, memberToken, amountCents, description) {
      return rpc<RoomRecord>("splitly_add_expense_v2", {
        p_token: token,
        p_member_token: memberToken,
        p_amount_cents: amountCents,
        p_description: description,
      });
    },
    updateExpense(token, memberToken, expenseId, amountCents, description) {
      return rpc<RoomRecord>("splitly_update_expense", {
        p_token: token,
        p_member_token: memberToken,
        p_expense_id: expenseId,
        p_amount_cents: amountCents,
        p_description: description,
      });
    },
    deleteExpense(token, memberToken, expenseId) {
      return rpc<{ room: RoomRecord; proofPath: string | null }>(
        "splitly_delete_expense",
        {
          p_token: token,
          p_member_token: memberToken,
          p_expense_id: expenseId,
        },
      );
    },
    setExpenseMembers(token, memberToken, expenseId, participantIds) {
      return rpc<RoomRecord>("splitly_set_expense_members", {
        p_token: token,
        p_member_token: memberToken,
        p_expense_id: expenseId,
        p_participant_ids: participantIds,
      });
    },
    proofTarget(token, memberToken, expenseId) {
      return rpc<{ roomId: string }>("splitly_proof_target", {
        p_token: token,
        p_member_token: memberToken,
        p_expense_id: expenseId,
      });
    },
    setProof(token, memberToken, expenseId, proof: ProofRecord) {
      return rpc<{ previousPath: string | null }>(
        "splitly_set_proof",
        {
          p_token: token,
          p_member_token: memberToken,
          p_expense_id: expenseId,
          p_path: proof.path,
          p_mime_type: proof.mimeType,
          p_size_bytes: proof.sizeBytes,
        },
        true,
      );
    },
    proofInfo(token, expenseId) {
      return rpc<ProofRecord>(
        "splitly_proof_info",
        {
          p_token: token,
          p_expense_id: expenseId,
        },
        true,
      );
    },
  };
}
