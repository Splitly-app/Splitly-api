import { describe, expect, test } from "bun:test";
import { type RoomRecord, summarizeRoom, toCents } from "./service";

const room: RoomRecord = {
  id: "room",
  name: "ทริป",
  updatedAt: "2026-10-19T00:00:00Z",
  viewerParticipantId: null,
  participants: [
    { id: "a", name: "เอ", position: 1, claimed: true },
    { id: "b", name: "บี", position: 2, claimed: true },
  ],
  expenses: [
    {
      id: "e1",
      payerId: "a",
      amountCents: 12000,
      description: "มื้อแรก",
      createdAt: "2026-10-19T00:00:00Z",
      eligibleParticipantIds: ["a", "b"],
      participantIds: ["a", "b"],
      hasProof: false,
    },
    {
      id: "e2",
      payerId: "b",
      amountCents: 4000,
      description: "มื้อสอง",
      createdAt: "2026-10-19T00:01:00Z",
      eligibleParticipantIds: ["a", "b"],
      participantIds: ["a", "b"],
      hasProof: false,
    },
  ],
};

describe("settlement", () => {
  test("nets reciprocal expenses into one transfer", () => {
    const summary = summarizeRoom(room);
    expect(summary.totalCents).toBe(16000);
    expect(summary.participants.map((person) => person.balanceCents)).toEqual([
      4000, -4000,
    ]);
    expect(summary.transfers).toEqual([
      { fromId: "b", toId: "a", amountCents: 4000 },
    ]);
  });

  test("assigns an odd satang deterministically", () => {
    const summary = summarizeRoom({
      ...room,
      expenses: [{ ...room.expenses[0], amountCents: 101 }],
    });
    expect(summary.participants.map((person) => person.shareCents)).toEqual([
      51, 50,
    ]);
    expect(summary.transfers).toEqual([
      { fromId: "b", toId: "a", amountCents: 50 },
    ]);
  });

  test("only selected members split an expense, even when payer is excluded", () => {
    const summary = summarizeRoom({
      ...room,
      expenses: [
        { ...room.expenses[0], amountCents: 101, participantIds: ["b"] },
      ],
    });
    expect(summary.participants.map((person) => person.shareCents)).toEqual([
      0, 101,
    ]);
    expect(summary.transfers).toEqual([
      { fromId: "b", toId: "a", amountCents: 101 },
    ]);
  });

  test("later members do not change older expenses", () => {
    const summary = summarizeRoom({
      ...room,
      participants: [
        ...room.participants,
        { id: "c", name: "ซี", position: 3, claimed: true },
      ],
      expenses: [{ ...room.expenses[0], amountCents: 101 }],
    });
    expect(summary.participants.map((person) => person.shareCents)).toEqual([
      51, 50, 0,
    ]);
  });

  test("assigns each expense's remaining satang to its payer first", () => {
    const summary = summarizeRoom({
      ...room,
      expenses: [
        { ...room.expenses[0], amountCents: 1 },
        { ...room.expenses[1], amountCents: 1 },
      ],
    });
    expect(summary.participants.map((person) => person.shareCents)).toEqual([
      1, 1,
    ]);
    expect(summary.transfers).toEqual([]);
  });

  test("matches the six-person sheet with bilateral netting and shows every counterparty", () => {
    const ids = ["gai", "tae", "ton", "pooy", "net", "on"];
    const people = ids.map((id, index) => ({
      id,
      name: id,
      position: index + 1,
      claimed: true,
    }));
    const expense = (
      id: string,
      amountCents: number,
      payerId: string,
      participantIds: string[],
    ) => ({
      id,
      amountCents,
      payerId,
      participantIds,
      eligibleParticipantIds: ids,
      description: null,
      createdAt: "2026-10-20T00:00:00Z",
      hasProof: false,
    });
    const summary = summarizeRoom({
      ...room,
      participants: people,
      expenses: [
        expense("meal", 38000, "tae", ids),
        expense("outbound", 20300, "ton", ["gai", "tae", "ton"]),
        expense("return", 16800, "ton", ["gai", "tae", "ton"]),
        expense("beer", 13600, "pooy", ["gai", "tae", "ton", "pooy", "on"]),
        expense("chicken", 7000, "pooy", ids),
      ],
    });
    expect(summary.totalCents).toBe(95700);
    expect(summary.participants.map((person) => person.balanceCents)).toEqual([
      -22587, 15414, 14513, 10380, -7500, -10220,
    ]);
    expect(
      summary.participants.reduce(
        (sum, person) => sum + person.balanceCents,
        0,
      ),
    ).toBe(0);
    expect(summary.transfers).toHaveLength(10);
    expect(
      summary.transfers.filter((transfer) => transfer.fromId === "gai"),
    ).toEqual([
      { fromId: "gai", toId: "tae", amountCents: 6333 },
      { fromId: "gai", toId: "ton", amountCents: 12367 },
      { fromId: "gai", toId: "pooy", amountCents: 3887 },
    ]);
    expect(summary.transfers).toContainEqual({
      fromId: "tae",
      toId: "ton",
      amountCents: 6032,
    });
    expect(summary.transfers).toContainEqual({
      fromId: "pooy",
      toId: "tae",
      amountCents: 2447,
    });
    for (const person of summary.participants) {
      const incoming = summary.transfers
        .filter((transfer) => transfer.toId === person.id)
        .reduce((sum, transfer) => sum + transfer.amountCents, 0);
      const outgoing = summary.transfers
        .filter((transfer) => transfer.fromId === person.id)
        .reduce((sum, transfer) => sum + transfer.amountCents, 0);
      expect(incoming - outgoing).toBe(person.balanceCents);
    }
  });

  test("rejects invalid currency strings", () => {
    expect(toCents("12.30")).toBe(1230);
    expect(() => toCents("0")).toThrow();
    expect(() => toCents("1.234")).toThrow();
    expect(() => toCents("1e3")).toThrow();
  });
});
