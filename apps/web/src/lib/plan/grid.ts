/**
 * W-05 当日の客室状況入力の表の組み立て。**純粋関数。**
 *
 * task: docs/tasks/P1-04.md
 * 仕様: docs/PK-SPEC-P1.md §3.4 / §10.3
 *
 * ── 清掃専用の場所を客室と混ぜない ──────────────────────
 * `isSellable = false`（パントリー・備品庫）は別のセクションに置く
 * （PK-SPEC-P0 §24.3）。アウト清掃もチェックインも立たないため、
 * **入力欄そのものを出さない。**
 *
 * ── 入力元を隠さない ────────────────────────────────────
 * CSV で入った行と手で入れた行を画面で区別できるようにする。前日夜の CSV を
 * 当日の朝に手で直す運用（§3.4）で、どちらが最後に効いたかが読めないと、
 * 直したつもりの行が CSV のままだと気づけない。
 */

import type { RoomPlanInput } from "@pk/db";

/** 人数の範囲。0 は「不明・未入力」ではなく「0 名」。 */
export const GUEST_COUNT_MIN = 0;
export const GUEST_COUNT_MAX = 9;

/** 表の 1 行。 */
export interface PlanRow {
  roomId: string;
  roomNumber: string;
  /** 客室タイプ名。マスタに紐づいていなければ `null`。 */
  roomTypeName: string | null;
  hasCheckout: boolean;
  hasCheckin: boolean;
  isStayover: boolean;
  guestCount: number;
  declineClean: boolean;
  /** 入力元。まだ 1 度も入力されていなければ `null`。 */
  source: "MANUAL" | "CSV" | null;
}

/** `buildPlanGrid()` の結果。 */
export interface PlanGrid {
  /** 売れる客室。入力欄を出す。 */
  rooms: readonly PlanRow[];
  /** 清掃専用の場所。**入力欄を出さない**（部屋番号だけを並べる）。 */
  nonSellable: readonly { roomId: string; roomNumber: string }[];
  /** 売れる客室のうち、まだ 1 度も入力されていない件数。 */
  unfilled: number;
}

/** `buildPlanGrid()` の入力。 */
export interface PlanGridInput {
  rooms: readonly {
    id: string;
    roomNumber: string;
    roomTypeId: string | null;
    isSellable: boolean;
  }[];
  roomTypes: readonly { id: string; name: string }[];
  plans: readonly {
    roomId: string;
    hasCheckout: boolean;
    hasCheckin: boolean;
    isStayover: boolean;
    guestCount: number;
    declineClean: boolean;
    source: "MANUAL" | "CSV";
  }[];
}

/**
 * 客室一覧と入力済みの計画を突き合わせる。
 *
 * 行の順序は `rooms` の順序（呼び出し側が `sortOrder` で並べる）。
 * 入力の無い客室も**必ず 1 行出す。** 出さないと「入力できる場所が無い」
 * ことになり、§3.4 の手段 2（画面での一括入力）が成立しない。
 */
export function buildPlanGrid(input: PlanGridInput): PlanGrid {
  const typeName = new Map(input.roomTypes.map((type) => [type.id, type.name]));
  const planByRoom = new Map(input.plans.map((plan) => [plan.roomId, plan]));

  const rooms: PlanRow[] = [];
  const nonSellable: { roomId: string; roomNumber: string }[] = [];
  let unfilled = 0;

  for (const room of input.rooms) {
    if (!room.isSellable) {
      nonSellable.push({ roomId: room.id, roomNumber: room.roomNumber });
      continue;
    }

    const plan = planByRoom.get(room.id);
    if (plan === undefined) unfilled += 1;

    rooms.push({
      roomId: room.id,
      roomNumber: room.roomNumber,
      roomTypeName: room.roomTypeId === null ? null : (typeName.get(room.roomTypeId) ?? null),
      hasCheckout: plan?.hasCheckout ?? false,
      hasCheckin: plan?.hasCheckin ?? false,
      isStayover: plan?.isStayover ?? false,
      guestCount: plan?.guestCount ?? 0,
      declineClean: plan?.declineClean ?? false,
      source: plan?.source ?? null,
    });
  }

  return { rooms, nonSellable, unfilled };
}

/** フォームの input 名。`roomId` に `__` が入るので区切りは `--`。 */
export function planFieldName(
  roomId: string,
  field: "checkout" | "checkin" | "stayover" | "guests" | "decline",
): string {
  return `plan--${roomId}--${field}`;
}

/** `toPlanInputs()` の結果。**拒否した行を黙って捨てない。** */
export interface ParsedPlanForm {
  entries: RoomPlanInput[];
  /** 人数が範囲外だった客室の部屋番号。画面が出す。 */
  rejectedRoomNumbers: string[];
}

/**
 * フォームの値を `upsertRoomPlans()` の入力へ写す。
 *
 * @param read 名前で値を読む関数。チェックボックスは未チェックだと
 *   そもそも送られてこないため、`null` を偽として扱う。
 *
 * **全行を返す。** 変更のあった行だけを選ぶことはしない。この画面は
 * 「今日の状況の一覧」を丸ごと確定させるもので、チェックを外した行を
 * 「送られていない」と解釈すると、外したはずのチェックが戻ってしまう。
 */
export function toPlanInputs(
  rows: readonly PlanRow[],
  read: (name: string) => string | null,
): ParsedPlanForm {
  const entries: RoomPlanInput[] = [];
  const rejectedRoomNumbers: string[] = [];

  for (const row of rows) {
    const guests = parseGuestCount(read(planFieldName(row.roomId, "guests")));
    if (guests === null) {
      rejectedRoomNumbers.push(row.roomNumber);
      continue;
    }
    entries.push({
      roomId: row.roomId,
      hasCheckout: read(planFieldName(row.roomId, "checkout")) !== null,
      hasCheckin: read(planFieldName(row.roomId, "checkin")) !== null,
      isStayover: read(planFieldName(row.roomId, "stayover")) !== null,
      guestCount: guests,
      declineClean: read(planFieldName(row.roomId, "decline")) !== null,
    });
  }

  return { entries, rejectedRoomNumbers };
}

/**
 * 人数を読む。
 *
 * **CSV 取込（`parseCount()`）と扱いを分けてある。** あちらは 100 行の中の
 * 1 つの書式違いで取込全体を諦めさせないために 0 へ丸めるが、画面の入力は
 * 目の前に人が居る。黙って 0 にすると、直したつもりの値が消える。
 *
 * @returns 範囲外・非数なら `null`。空欄は 0（未入力＝0 名）。
 */
function parseGuestCount(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return 0;
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(value)) return null;
  if (value < GUEST_COUNT_MIN || value > GUEST_COUNT_MAX) return null;
  return value;
}
