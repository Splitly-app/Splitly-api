import { describe, expect, test } from "bun:test";
import { createApp } from "./application";
import { readConfig } from "./config";
import { createRoomService, type RoomRecord } from "./modules/rooms/service";

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

test("room routes require a link token and return net transfers", async () => {
  const room: RoomRecord = {
    id: "room-1",
    name: "ทริป",
    updatedAt: "2026-10-19T00:00:00Z",
    viewerParticipantId: null,
    participants: [
      { id: "a", name: "เอ", position: 1, claimed: false },
      { id: "b", name: "บี", position: 2, claimed: false },
    ],
    expenses: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        payerId: "a",
        amountCents: 10000,
        description: null,
        createdAt: "2026-10-19T00:00:00Z",
        eligibleParticipantIds: ["a", "b"],
        participantIds: ["a", "b"],
        hasProof: false,
      },
    ],
  };
  const token = "a".repeat(64);
  const memberSession = "b".repeat(64);
  let usedMemberSession = "";
  let updatedAmount = 0;
  let deletedExpenseId = "";
  let removedProofPath = "";
  const app = createApp({
    allowedOrigins: ["http://localhost:3003"],
    resolveUser: async () => null,
    version: "test",
    rooms: createRoomService(
      {
        create: async () => ({ token, room }),
        read: async (value) => (value === token ? room : null),
        selectMember: async () => null,
        recoverMember: async () => null,
        addParticipant: async () => ({
          room,
          session: { participantId: "a", memberToken: token },
        }),
        addExpense: async (_token, suppliedMemberSession) => {
          usedMemberSession = suppliedMemberSession;
          return room;
        },
        updateExpense: async (_token, _session, _expenseId, amountCents) => {
          updatedAmount = amountCents;
          return {
            ...room,
            expenses: [{ ...room.expenses[0], amountCents }],
          };
        },
        deleteExpense: async (_token, _session, expenseId) => {
          deletedExpenseId = expenseId;
          return {
            room: { ...room, expenses: [] },
            proofPath: "room/proof.jpg",
          };
        },
        setExpenseMembers: async () => room,
        proofTarget: async () => null,
        setProof: async () => null,
        proofInfo: async () => null,
      },
      {
        createUpload: async () => ({ token: "upload" }),
        inspect: async () => null,
        createReadUrl: async () => "https://example.test/proof",
        remove: async (path) => {
          removedProofPath = path;
        },
      },
    ),
  });
  const missing = await app.handle(
    new Request("http://localhost/v1/rooms/current"),
  );
  expect(missing.status).toBe(404);
  const valid = await app.handle(
    new Request("http://localhost/v1/rooms/current", {
      headers: { "x-room-token": token },
    }),
  );
  expect(valid.status).toBe(200);
  expect((await valid.json()).data.transfers).toEqual([
    { fromId: "b", toId: "a", amountCents: 5000 },
  ]);
  const withoutMember = await app.handle(
    new Request("http://localhost/v1/rooms/current/expenses", {
      method: "POST",
      headers: { "x-room-token": token, "content-type": "application/json" },
      body: JSON.stringify({ amount: "10.00", description: "" }),
    }),
  );
  expect(withoutMember.status).toBe(401);
  const withMember = await app.handle(
    new Request("http://localhost/v1/rooms/current/expenses", {
      method: "POST",
      headers: {
        "x-room-token": token,
        "x-member-token": memberSession,
        "content-type": "application/json",
      },
      body: JSON.stringify({ amount: "10.00", description: "" }),
    }),
  );
  expect(withMember.status).toBe(200);
  expect(usedMemberSession).toBe(memberSession);
  const edit = await app.handle(
    new Request(
      "http://localhost/v1/rooms/current/expenses/11111111-1111-4111-8111-111111111111",
      {
        method: "PATCH",
        headers: {
          "x-room-token": token,
          "x-member-token": memberSession,
          "content-type": "application/json",
        },
        body: JSON.stringify({ amount: "75.25", description: "อาหาร" }),
      },
    ),
  );
  expect(edit.status).toBe(200);
  expect(updatedAmount).toBe(7525);
  expect((await edit.json()).data.totalCents).toBe(7525);
  const members = await app.handle(
    new Request(
      "http://localhost/v1/rooms/current/expenses/11111111-1111-4111-8111-111111111111/participants",
      {
        method: "PATCH",
        headers: {
          "x-room-token": token,
          "x-member-token": memberSession,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          participantIds: ["22222222-2222-4222-8222-222222222222"],
        }),
      },
    ),
  );
  expect(members.status).toBe(200);
  const deleteWithoutMember = await app.handle(
    new Request(
      "http://localhost/v1/rooms/current/expenses/11111111-1111-4111-8111-111111111111",
      {
        method: "DELETE",
        headers: { "x-room-token": token },
      },
    ),
  );
  expect(deleteWithoutMember.status).toBe(401);
  const remove = await app.handle(
    new Request(
      "http://localhost/v1/rooms/current/expenses/11111111-1111-4111-8111-111111111111",
      {
        method: "DELETE",
        headers: { "x-room-token": token, "x-member-token": memberSession },
      },
    ),
  );
  expect(remove.status).toBe(200);
  expect(deletedExpenseId).toBe("11111111-1111-4111-8111-111111111111");
  expect(removedProofPath).toBe("room/proof.jpg");
  expect((await remove.json()).data.totalCents).toBe(0);
  const malformed = await app.handle(
    new Request("http://localhost/v1/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "trip", participants: ["only-one"] }),
    }),
  );
  expect(malformed.status).toBe(422);
});
