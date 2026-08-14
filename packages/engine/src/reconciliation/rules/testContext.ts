/**
 * ルールのテストが使う `RuleContext` の組み立て。**テスト専用。**
 *
 * task: docs/tasks/P4-11.md / docs/tasks/P4-12.md
 *
 * ── なぜ spec ごとに書かないのか ────────────────────────
 * P4-04 の 2 本（R001 / R006）は各 spec が自前の `context()` を持っていた。
 * ルールが 10 本になると同じ 30 行が 10 か所に散る。**`RuleContext` に
 * 欄が 1 つ増えるたび 10 か所を直す**ことになり、直し漏れた spec が
 * 型エラーで落ちる形になる（実際 P4-11 で 3 か所を直した）。
 *
 * ── `index.ts` から公開しない ───────────────────────────
 * ここは engine の公開 API ではない。`packages/db/src/test-support/` と
 * 同じ扱いで、**本番の呼び出し側がこの形に依存しないようにする。**
 *
 * ── 純粋であること ──────────────────────────────────────
 * `purity.spec.ts` はこのファイルも走査する（`rules/` 配下の非 spec）。
 * `Date.now()` を書かない。時刻はすべて定数。
 */

import type {
  ObservationFact,
  OccupancyFact,
  RuleContext,
  SignalFact,
  TaskFact,
} from "../types.js";

/** テストの「いま」。**2026-09-10 05:10 JST**（日締め 05:00 の直後）。 */
export const TEST_NOW = new Date("2026-09-09T20:10:00.000Z");

/** テストの業務日。 */
export const TEST_BUSINESS_DATE = "2026-09-09";

const ORG = "o7k2m9";

export const TEST_PROPERTY_ID = `${ORG}__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
export const TEST_ROOM_ID = `${ORG}__room_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
export const TEST_ROOM_TYPE_ID = `${ORG}__rtyp_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
export const TEST_MEMBERSHIP_ID = `${ORG}__mem_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;

/** 稼働記録。**既定は「稼働している 2 名」**（空室は各テストが上書きする）。 */
export function occupancyFact(overrides: Partial<OccupancyFact> = {}): OccupancyFact {
  return {
    isOccupied: true,
    guestCount: 2,
    reservationRef: "RSV-8891",
    source: "CSV_IMPORT",
    importedAt: Date.parse("2026-09-10T02:14:00+09:00"),
    checkInAt: null,
    checkOutAt: null,
    isStayover: false,
    nightsTotal: null,
    nightIndex: null,
    isComplimentary: false,
    isHouseUse: false,
    ...overrides,
  };
}

/** 観察記録。**既定は「使われた形跡がある」。** */
export function observationFact(overrides: Partial<ObservationFact> = {}): ObservationFact {
  return {
    skipped: false,
    bedsUsed: 1,
    trashLevel: "NORMAL",
    bathTowelUsed: 2,
    faceTowelUsed: 2,
    handTowelUsed: 0,
    bathMatUsed: 1,
    slippersUsed: 0,
    cupsUsed: 0,
    extraFutonUsed: 0,
    amenitiesUsed: {},
    usedDefaults: false,
    recordedAt: Date.parse("2026-09-09T10:22:00+09:00"),
    recordedById: TEST_MEMBERSHIP_ID,
    ...overrides,
  };
}

/** 物理シグナル。**`localHour` は呼び出し側が決める**（engine は時差を解けない）。 */
export function signalFact(overrides: Partial<SignalFact> = {}): SignalFact {
  return {
    signalType: "DOOR_UNLOCK",
    occurredAt: Date.parse("2026-09-09T22:00:00+09:00"),
    actorType: "GUEST_KEY",
    localHour: 22,
    ...overrides,
  };
}

/**
 * 清掃タスク。**既定は「10:00 に始めて 10:40 に終えたアウト清掃」。**
 *
 * §4.4 の除外窓（前後 10 分）は `startedAt` / `completedAt` から決まる。
 * 既定を `null` にすると、窓のテストが毎回両方を渡すことになる。
 */
export function taskFact(overrides: Partial<TaskFact> = {}): TaskFact {
  return {
    taskType: "CHECKOUT",
    isCompleted: true,
    startedAt: Date.parse("2026-09-09T10:00:00+09:00"),
    completedAt: Date.parse("2026-09-09T10:40:00+09:00"),
    actualMinutes: 40,
    photoCount: 3,
    ...overrides,
  };
}

/**
 * ルールに渡す文脈。**既定は「何も差異が出ない」状態にしない。**
 *
 * 既定を「無害」に寄せると、各テストが「何を足したら差異が出るか」ではなく
 * 「何を足せば動くか」を書くことになる。ここは**ごく普通の稼働している
 * 客室**で、各ルールの正例はそこから必要な分だけを崩す。
 */
export function ruleContext(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    now: TEST_NOW,
    businessDate: TEST_BUSINESS_DATE,
    property: {
      id: TEST_PROPERTY_ID,
      occupancyLinked: true,
      daysSinceOperationStart: 400,
    },
    room: {
      id: TEST_ROOM_ID,
      number: "302",
      roomTypeId: TEST_ROOM_TYPE_ID,
      saleStatus: "ON_SALE",
    },
    occupancy: occupancyFact(),
    observation: observationFact(),
    task: null,
    signals: [],
    accessLogs: [],
    baselines: [],
    previousObservation: null,
    previousOccupancy: null,
    occupancyBetweenCheckOutAndToday: null,
    checkOutBusinessDate: null,
    statusOverrides: [],
    occupancyRevokedAfterCleaning: null,
    thresholds: {},
    ...overrides,
  };
}
