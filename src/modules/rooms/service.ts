export type RoomRecord = {
  id: string;
  name: string;
  updatedAt: string;
  viewerParticipantId: string | null;
  participants: {
    id: string;
    name: string;
    position: number;
    claimed: boolean;
  }[];
  expenses: {
    id: string;
    payerId: string;
    amountCents: number;
    description: string | null;
    createdAt: string;
    eligibleParticipantIds: string[];
    participantIds: string[];
    hasProof: boolean;
  }[];
};
export type MemberSession = {
  participantId: string;
  memberToken: string;
  recoveryCode?: string;
};
export type ProofRecord = { path: string; mimeType: string; sizeBytes: number };
export type RoomRepository = {
  create(
    name: string,
    participants: string[],
  ): Promise<{ token: string; room: RoomRecord }>;
  read(token: string, memberToken?: string): Promise<RoomRecord | null>;
  selectMember(
    token: string,
    participantId: string,
    pin: string,
  ): Promise<MemberSession | null>;
  recoverMember(
    token: string,
    participantId: string,
    code: string,
    pin: string,
  ): Promise<MemberSession | null>;
  addParticipant(
    token: string,
    name: string,
    pin: string,
  ): Promise<{ room: RoomRecord; session: MemberSession } | null>;
  addExpense(
    token: string,
    memberToken: string,
    amountCents: number,
    description: string,
  ): Promise<RoomRecord | null>;
  updateExpense(
    token: string,
    memberToken: string,
    expenseId: string,
    amountCents: number,
    description: string,
  ): Promise<RoomRecord | null>;
  deleteExpense(
    token: string,
    memberToken: string,
    expenseId: string,
  ): Promise<{ room: RoomRecord; proofPath: string | null } | null>;
  setExpenseMembers(
    token: string,
    memberToken: string,
    expenseId: string,
    participantIds: string[],
  ): Promise<RoomRecord | null>;
  proofTarget(
    token: string,
    memberToken: string,
    expenseId: string,
  ): Promise<{ roomId: string } | null>;
  setProof(
    token: string,
    memberToken: string,
    expenseId: string,
    proof: ProofRecord,
  ): Promise<{ previousPath: string | null } | null>;
  proofInfo(token: string, expenseId: string): Promise<ProofRecord | null>;
};
export type ProofStorage = {
  createUpload(path: string): Promise<{ token: string }>;
  inspect(
    path: string,
  ): Promise<{ mimeType: string; sizeBytes: number; signature: string } | null>;
  createReadUrl(path: string): Promise<string>;
  remove(path: string): Promise<void>;
};
export class RoomError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export function toCents(amount: string): number {
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(amount))
    throw new RoomError(422, "Invalid amount");
  const [whole, fraction = ""] = amount.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > 9_999_999_999)
    throw new RoomError(422, "Invalid amount");
  return cents;
}
const proofExtensions: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};
function validatePin(pin: string) {
  if (!/^\d{6}$/.test(pin))
    throw new RoomError(422, "PIN must contain six digits");
}
export function summarizeRoom(room: RoomRecord) {
  const participants = [...room.participants].sort(
    (a, b) => a.position - b.position,
  );
  const ids = new Set(participants.map((person) => person.id));
  const paid = new Map(participants.map((person) => [person.id, 0]));
  const shares = new Map(participants.map((person) => [person.id, 0]));
  const owed = new Map<string, number>();
  let totalCents = 0;
  for (const expense of room.expenses) {
    if (
      !Number.isSafeInteger(expense.amountCents) ||
      expense.amountCents < 1 ||
      !ids.has(expense.payerId)
    ) {
      throw new RoomError(503, "Invalid expense data");
    }
    const selected = expense.participantIds;
    if (
      !selected.length ||
      new Set(selected).size !== selected.length ||
      selected.some(
        (id) => !ids.has(id) || !expense.eligibleParticipantIds.includes(id),
      )
    ) {
      throw new RoomError(503, "Invalid expense participants");
    }
    totalCents += expense.amountCents;
    if (!Number.isSafeInteger(totalCents))
      throw new RoomError(422, "Room total is too large");
    paid.set(
      expense.payerId,
      (paid.get(expense.payerId) ?? 0) + expense.amountCents,
    );
    const ordered = participants.filter((person) =>
      selected.includes(person.id),
    );
    const base = Math.floor(expense.amountCents / ordered.length);
    const remainder = expense.amountCents % ordered.length;
    const payerIndex = ordered.findIndex(
      (person) => person.id === expense.payerId,
    );
    const first = payerIndex < 0 ? 0 : payerIndex;
    for (const [index, person] of ordered.entries()) {
      const distance = (index - first + ordered.length) % ordered.length;
      const share = base + (distance < remainder ? 1 : 0);
      shares.set(person.id, (shares.get(person.id) ?? 0) + share);
      if (person.id !== expense.payerId) {
        const key = `${person.id}:${expense.payerId}`;
        owed.set(key, (owed.get(key) ?? 0) + share);
      }
    }
  }
  const people = participants.map((person) => {
    const paidCents = paid.get(person.id) ?? 0;
    const shareCents = shares.get(person.id) ?? 0;
    return {
      ...person,
      paidCents,
      shareCents,
      balanceCents: paidCents - shareCents,
    };
  });
  const transfers: { fromId: string; toId: string; amountCents: number }[] = [];
  for (let i = 0; i < participants.length; i += 1) {
    for (let j = i + 1; j < participants.length; j += 1) {
      const first = participants[i].id;
      const second = participants[j].id;
      const difference =
        (owed.get(`${first}:${second}`) ?? 0) -
        (owed.get(`${second}:${first}`) ?? 0);
      if (difference > 0)
        transfers.push({
          fromId: first,
          toId: second,
          amountCents: difference,
        });
      if (difference < 0)
        transfers.push({
          fromId: second,
          toId: first,
          amountCents: -difference,
        });
    }
  }
  return { ...room, totalCents, participants: people, transfers };
}
export function createRoomService(
  repository: RoomRepository,
  storage?: ProofStorage,
) {
  return {
    async create(name: string, participantNames: string[]) {
      const participants = participantNames.map((value) => value.trim());
      if (
        participants.length < 2 ||
        participants.length > 20 ||
        participants.some((value) => value.length < 1 || value.length > 40) ||
        new Set(participants.map((value) => value.toLocaleLowerCase())).size !==
          participants.length ||
        name.trim().length > 80
      )
        throw new RoomError(422, "Invalid room or participants");
      const created = await repository.create(name.trim(), participants);
      return { token: created.token, room: summarizeRoom(created.room) };
    },
    async read(token: string, memberToken?: string) {
      const room = await repository.read(token, memberToken);
      if (!room) throw new RoomError(404, "Room not found");
      return summarizeRoom(room);
    },
    async selectMember(token: string, participantId: string, pin: string) {
      validatePin(pin);
      const result = await repository.selectMember(token, participantId, pin);
      if (!result) throw new RoomError(404, "Room or member not found");
      return result;
    },
    async recoverMember(
      token: string,
      participantId: string,
      code: string,
      pin: string,
    ) {
      validatePin(pin);
      if (!/^[0-9a-f]{32}$/.test(code))
        throw new RoomError(422, "Invalid recovery code");
      const result = await repository.recoverMember(
        token,
        participantId,
        code,
        pin,
      );
      if (!result) throw new RoomError(404, "Room or member not found");
      return result;
    },
    async addParticipant(token: string, name: string, pin: string) {
      validatePin(pin);
      const trimmed = name.trim();
      if (trimmed.length < 1 || trimmed.length > 40)
        throw new RoomError(422, "Invalid name");
      const result = await repository.addParticipant(token, trimmed, pin);
      if (!result) throw new RoomError(404, "Room not found");
      return { room: summarizeRoom(result.room), session: result.session };
    },
    async addExpense(
      token: string,
      memberToken: string,
      amount: string,
      description: string,
    ) {
      const trimmed = description.trim();
      if (trimmed.length > 120) throw new RoomError(422, "Invalid description");
      const room = await repository.addExpense(
        token,
        memberToken,
        toCents(amount),
        trimmed,
      );
      if (!room) throw new RoomError(404, "Room not found");
      return summarizeRoom(room);
    },
    async updateExpense(
      token: string,
      memberToken: string,
      expenseId: string,
      amount: string,
      description: string,
    ) {
      const trimmed = description.trim();
      if (trimmed.length > 120) throw new RoomError(422, "Invalid description");
      const room = await repository.updateExpense(
        token,
        memberToken,
        expenseId,
        toCents(amount),
        trimmed,
      );
      if (!room) throw new RoomError(404, "Room or expense not found");
      return summarizeRoom(room);
    },
    async deleteExpense(token: string, memberToken: string, expenseId: string) {
      const deleted = await repository.deleteExpense(
        token,
        memberToken,
        expenseId,
      );
      if (!deleted) throw new RoomError(404, "Room or expense not found");
      if (deleted.proofPath && storage) {
        await storage.remove(deleted.proofPath).catch(() => undefined);
      }
      return summarizeRoom(deleted.room);
    },
    async setExpenseMembers(
      token: string,
      memberToken: string,
      expenseId: string,
      participantIds: string[],
    ) {
      if (
        !participantIds.length ||
        participantIds.length > 20 ||
        new Set(participantIds).size !== participantIds.length
      ) {
        throw new RoomError(422, "Choose at least one unique participant");
      }
      const room = await repository.setExpenseMembers(
        token,
        memberToken,
        expenseId,
        participantIds,
      );
      if (!room) throw new RoomError(404, "Room or expense not found");
      return summarizeRoom(room);
    },
    async createProofUpload(
      token: string,
      memberToken: string,
      expenseId: string,
      mimeType: string,
      sizeBytes: number,
    ) {
      if (!storage) throw new RoomError(503, "Proof storage unavailable");
      if (
        !(mimeType in proofExtensions) ||
        !Number.isInteger(sizeBytes) ||
        sizeBytes < 1 ||
        sizeBytes > 5_000_000
      ) {
        throw new RoomError(422, "Unsupported proof file");
      }
      const target = await repository.proofTarget(
        token,
        memberToken,
        expenseId,
      );
      if (!target) throw new RoomError(404, "Room or expense not found");
      const path = `${target.roomId}/${expenseId}/${crypto.randomUUID()}.${proofExtensions[mimeType]}`;
      const signed = await storage.createUpload(path);
      return { path, uploadToken: signed.token };
    },
    async completeProofUpload(
      token: string,
      memberToken: string,
      expenseId: string,
      path: string,
    ) {
      if (!storage) throw new RoomError(503, "Proof storage unavailable");
      const target = await repository.proofTarget(
        token,
        memberToken,
        expenseId,
      );
      if (!target) throw new RoomError(404, "Room or expense not found");
      const prefix = `${target.roomId}/${expenseId}/`;
      if (
        !path.startsWith(prefix) ||
        !/^[0-9a-f-]{36}\.(jpg|png|webp|pdf)$/.test(path.slice(prefix.length))
      ) {
        throw new RoomError(422, "Invalid proof path");
      }
      const file = await storage.inspect(path);
      if (
        !file ||
        !(file.mimeType in proofExtensions) ||
        file.sizeBytes < 1 ||
        file.sizeBytes > 5_000_000 ||
        file.signature !== file.mimeType ||
        !path.endsWith(`.${proofExtensions[file.mimeType]}`)
      ) {
        throw new RoomError(422, "Unsupported proof file");
      }
      const result = await repository.setProof(token, memberToken, expenseId, {
        path,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
      });
      if (!result) throw new RoomError(404, "Room or expense not found");
      if (result.previousPath && result.previousPath !== path) {
        await storage.remove(result.previousPath).catch(() => undefined);
      }
      return { hasProof: true };
    },
    async proofUrl(token: string, expenseId: string) {
      if (!storage) throw new RoomError(503, "Proof storage unavailable");
      const proof = await repository.proofInfo(token, expenseId);
      if (!proof) throw new RoomError(404, "Proof not found");
      return {
        url: await storage.createReadUrl(proof.path),
        mimeType: proof.mimeType,
      };
    },
  };
}
export type RoomService = ReturnType<typeof createRoomService>;
