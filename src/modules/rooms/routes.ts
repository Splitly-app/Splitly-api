import { Elysia, t } from "elysia";
import { RoomError, type RoomService } from "./service";

const tokenPattern = /^[0-9a-f]{64}$/;
const id = t.String({ pattern: "^[0-9a-fA-F-]{36}$" });
const pin = t.String({ pattern: "^[0-9]{6}$" });
function roomToken(headers: Record<string, string | undefined>): string {
  const token = headers["x-room-token"] ?? "";
  if (!tokenPattern.test(token)) throw new RoomError(404, "Room not found");
  return token;
}
function memberToken(headers: Record<string, string | undefined>): string {
  const token = headers["x-member-token"] ?? "";
  if (!tokenPattern.test(token))
    throw new RoomError(401, "Choose your name first");
  return token;
}
function responseError(error: unknown, set: { status?: number | string }) {
  if (error instanceof RoomError) {
    set.status = error.status;
    const code =
      error.status === 404
        ? "NOT_FOUND"
        : error.status === 401
          ? "UNAUTHORIZED"
          : error.status === 403
            ? "FORBIDDEN"
            : error.status === 429
              ? "RATE_LIMITED"
              : "ROOM_ERROR";
    return { error: { code, message: error.message } };
  }
  set.status = 503;
  return {
    error: { code: "SERVICE_UNAVAILABLE", message: "Please try again" },
  };
}
const roomSecurity = [{ RoomToken: [] }];
const memberSecurity = [{ RoomToken: [], MemberToken: [] }];
export function createRoomRoutes(service: RoomService) {
  return new Elysia({ name: "rooms" })
    .post(
      "/v1/rooms",
      async ({ body, set }) => {
        try {
          return { data: await service.create(body.name, body.participants) };
        } catch (error) {
          return responseError(error, set);
        }
      },
      {
        body: t.Object({
          name: t.String({ maxLength: 80 }),
          participants: t.Array(t.String({ minLength: 1, maxLength: 40 }), {
            minItems: 2,
            maxItems: 20,
          }),
        }),
        detail: { summary: "Create a shared expense room" },
      },
    )
    .get(
      "/v1/rooms/current",
      async ({ headers, set }) => {
        try {
          return {
            data: await service.read(
              roomToken(headers),
              headers["x-member-token"],
            ),
          };
        } catch (error) {
          return responseError(error, set);
        }
      },
      {
        detail: {
          summary: "Get the latest room and net transfers",
          security: roomSecurity,
        },
      },
    )
    .post(
      "/v1/rooms/current/identity/select",
      async ({ headers, body, set }) => {
        try {
          return {
            data: await service.selectMember(
              roomToken(headers),
              body.participantId,
              body.pin,
            ),
          };
        } catch (error) {
          return responseError(error, set);
        }
      },
      {
        body: t.Object({ participantId: id, pin }),
        detail: {
          summary: "Claim or unlock a member name with a PIN",
          security: roomSecurity,
        },
      },
    )
    .post(
      "/v1/rooms/current/identity/recover",
      async ({ headers, body, set }) => {
        try {
          return {
            data: await service.recoverMember(
              roomToken(headers),
              body.participantId,
              body.recoveryCode,
              body.newPin,
            ),
          };
        } catch (error) {
          return responseError(error, set);
        }
      },
      {
        body: t.Object({
          participantId: id,
          recoveryCode: t.String({ pattern: "^[0-9a-f]{32}$" }),
          newPin: pin,
        }),
        detail: {
          summary: "Reset a member PIN with the one-time recovery code",
          security: roomSecurity,
        },
      },
    )
    .post(
      "/v1/rooms/current/participants",
      async ({ headers, body, set }) => {
        try {
          return {
            data: await service.addParticipant(
              roomToken(headers),
              body.name,
              body.pin,
            ),
          };
        } catch (error) {
          return responseError(error, set);
        }
      },
      {
        body: t.Object({
          name: t.String({ minLength: 1, maxLength: 40 }),
          pin,
        }),
        detail: {
          summary: "Add and claim a new member",
          security: roomSecurity,
        },
      },
    )
    .post(
      "/v1/rooms/current/expenses",
      async ({ headers, body, set }) => {
        try {
          return {
            data: await service.addExpense(
              roomToken(headers),
              memberToken(headers),
              body.amount,
              body.description,
            ),
          };
        } catch (error) {
          return responseError(error, set);
        }
      },
      {
        body: t.Object({
          amount: t.String({ pattern: "^\\d{1,8}(?:\\.\\d{1,2})?$" }),
          description: t.String({ maxLength: 120 }),
        }),
        detail: {
          summary: "Add an expense paid by the selected member",
          security: memberSecurity,
        },
      },
    )
    .patch(
      "/v1/rooms/current/expenses/:expenseId",
      async ({ headers, params, body, set }) => {
        try {
          return {
            data: await service.updateExpense(
              roomToken(headers),
              memberToken(headers),
              params.expenseId,
              body.amount,
              body.description,
            ),
          };
        } catch (error) {
          return responseError(error, set);
        }
      },
      {
        params: t.Object({ expenseId: id }),
        body: t.Object({
          amount: t.String({ pattern: "^\\d{1,8}(?:\\.\\d{1,2})?$" }),
          description: t.String({ maxLength: 120 }),
        }),
        detail: {
          summary: "Update an expense amount and description (payer only)",
          security: memberSecurity,
        },
      },
    )
    .delete(
      "/v1/rooms/current/expenses/:expenseId",
      async ({ headers, params, set }) => {
        try {
          return {
            data: await service.deleteExpense(
              roomToken(headers),
              memberToken(headers),
              params.expenseId,
            ),
          };
        } catch (error) {
          return responseError(error, set);
        }
      },
      {
        params: t.Object({ expenseId: id }),
        detail: {
          summary: "Delete an expense and its split (payer only)",
          security: memberSecurity,
        },
      },
    )
    .patch(
      "/v1/rooms/current/expenses/:expenseId/participants",
      async ({ headers, params, body, set }) => {
        try {
          return {
            data: await service.setExpenseMembers(
              roomToken(headers),
              memberToken(headers),
              params.expenseId,
              body.participantIds,
            ),
          };
        } catch (error) {
          return responseError(error, set);
        }
      },
      {
        params: t.Object({ expenseId: id }),
        body: t.Object({
          participantIds: t.Array(id, { minItems: 1, maxItems: 20 }),
        }),
        detail: {
          summary: "Set the expense split members (payer only)",
          security: memberSecurity,
        },
      },
    )
    .post(
      "/v1/rooms/current/expenses/:expenseId/proof/upload-intent",
      async ({ headers, params, body, set }) => {
        try {
          return {
            data: await service.createProofUpload(
              roomToken(headers),
              memberToken(headers),
              params.expenseId,
              body.mimeType,
              body.sizeBytes,
            ),
          };
        } catch (error) {
          return responseError(error, set);
        }
      },
      {
        params: t.Object({ expenseId: id }),
        body: t.Object({
          mimeType: t.String(),
          sizeBytes: t.Integer({ minimum: 1, maximum: 5_000_000 }),
        }),
        detail: {
          summary: "Create a signed proof upload (payer only)",
          security: memberSecurity,
        },
      },
    )
    .post(
      "/v1/rooms/current/expenses/:expenseId/proof/complete",
      async ({ headers, params, body, set }) => {
        try {
          return {
            data: await service.completeProofUpload(
              roomToken(headers),
              memberToken(headers),
              params.expenseId,
              body.path,
            ),
          };
        } catch (error) {
          return responseError(error, set);
        }
      },
      {
        params: t.Object({ expenseId: id }),
        body: t.Object({ path: t.String({ minLength: 1, maxLength: 200 }) }),
        detail: {
          summary: "Verify and attach an uploaded proof (payer only)",
          security: memberSecurity,
        },
      },
    )
    .get(
      "/v1/rooms/current/expenses/:expenseId/proof",
      async ({ headers, params, set }) => {
        try {
          return {
            data: await service.proofUrl(roomToken(headers), params.expenseId),
          };
        } catch (error) {
          return responseError(error, set);
        }
      },
      {
        params: t.Object({ expenseId: id }),
        detail: {
          summary: "Get a short-lived proof viewing URL",
          security: roomSecurity,
        },
      },
    );
}
