/**
 * 検査待ちの並び順（P2-05 / PK-SPEC-P2 §5.2・§5.3・§11.2）。
 *
 * ルール: .claude/rules/testing.md §3（正例・負例を最低 5 件ずつ）
 */

import { describe, expect, it } from "vitest";

import {
  INSPECTION_URGENT_CHECKIN_MINUTES,
  compareInspectionQueue,
  sortInspectionQueue,
  summarizeInspectionQueue,
  waitStateOf,
  type WaitingInspection,
} from "./inspectionQueue.js";

const NOW = Date.parse("2026-09-10T05:00:00.000Z");
const SLA = 20;

/** 分をミリ秒差に直す。**正が過去、負が未来。** */
function minutesAgo(minutes: number): number {
  return NOW - minutes * 60_000;
}

function entry(
  roomNumber: string,
  overrides: Partial<WaitingInspection> = {},
): WaitingInspection {
  return {
    taskId: `task_${roomNumber}`,
    roomNumber,
    completedAtMs: minutesAgo(5),
    checkInAtMs: null,
    completedRounds: 0,
    ...overrides,
  };
}

/** 並びを客室番号だけで取り出す。 */
function orderOf(entries: readonly WaitingInspection[]): string[] {
  return sortInspectionQueue(entries, NOW, SLA).map((row) => row.roomNumber);
}

describe("waitStateOf", () => {
  // ── 正例（NORMAL のまま）──────────────────────────────
  it("完了直後は NORMAL", () => {
    const state = waitStateOf(entry("101", { completedAtMs: minutesAgo(1) }), NOW, SLA);
    expect(state.tone).toBe("NORMAL");
    expect(state.waitedMinutes).toBe(1);
  });

  it("SLA ちょうどは超過にしない（「超えて」未着手 / §5.2）", () => {
    const state = waitStateOf(entry("102", { completedAtMs: minutesAgo(SLA) }), NOW, SLA);
    expect(state.isOverSla).toBe(false);
    expect(state.tone).toBe("NORMAL");
  });

  it("完了時刻が無ければ待ち時間 0", () => {
    const state = waitStateOf(entry("103", { completedAtMs: null }), NOW, SLA);
    expect(state.waitedMinutes).toBe(0);
    expect(state.isOverSla).toBe(false);
  });

  it("チェックインが 30 分より先なら緊急ではない", () => {
    const checkInAtMs = NOW + (INSPECTION_URGENT_CHECKIN_MINUTES + 1) * 60_000;
    expect(waitStateOf(entry("104", { checkInAtMs }), NOW, SLA).tone).toBe("NORMAL");
  });

  it("SLA が 0 以下の設定では超過にしない（印が意味を失う）", () => {
    const state = waitStateOf(entry("105", { completedAtMs: minutesAgo(600) }), NOW, 0);
    expect(state.isOverSla).toBe(false);
  });

  it("初回の検査は再検査ではない", () => {
    expect(waitStateOf(entry("106"), NOW, SLA).isRecheck).toBe(false);
  });

  // ── 負例（印が付く）──────────────────────────────────
  it("SLA を超えたら OVER_SLA（§5.2）", () => {
    const state = waitStateOf(entry("201", { completedAtMs: minutesAgo(SLA + 1) }), NOW, SLA);
    expect(state.isOverSla).toBe(true);
    expect(state.tone).toBe("OVER_SLA");
  });

  it("チェックインまで 30 分未満なら URGENT（§5.3）", () => {
    const checkInAtMs = NOW + 18 * 60_000;
    const state = waitStateOf(entry("202", { checkInAtMs }), NOW, SLA);
    expect(state.tone).toBe("URGENT");
    expect(state.minutesToCheckIn).toBe(18);
  });

  it("チェックイン時刻を過ぎていても URGENT のまま", () => {
    // 客が既に着いている部屋を「期限切れだから後回し」にしない。
    const state = waitStateOf(entry("203", { checkInAtMs: NOW - 10 * 60_000 }), NOW, SLA);
    expect(state.tone).toBe("URGENT");
    expect(state.minutesToCheckIn).toBe(-10);
  });

  it("緊急と SLA 超過が重なったら URGENT が勝つ", () => {
    const state = waitStateOf(
      entry("204", { completedAtMs: minutesAgo(90), checkInAtMs: NOW + 5 * 60_000 }),
      NOW,
      SLA,
    );
    expect(state.tone).toBe("URGENT");
    // **超過している事実は消えない。** 印の色が違うだけ。
    expect(state.isOverSla).toBe(true);
  });

  it("差戻しから戻ってきたら再検査", () => {
    expect(waitStateOf(entry("205", { completedRounds: 1 }), NOW, SLA).isRecheck).toBe(true);
  });

  it("**待ち時間の長さだけでは URGENT にしない**（ui-writing.md §3）", () => {
    // 3 時間待っていても、締切が無ければオレンジまで。
    const state = waitStateOf(entry("206", { completedAtMs: minutesAgo(180) }), NOW, SLA);
    expect(state.tone).toBe("OVER_SLA");
  });
});

describe("sortInspectionQueue — §11.2 の 4 段", () => {
  it("緊急 → SLA 超過 → 再検査 → 完了の古い順", () => {
    const order = orderOf([
      entry("401", { completedAtMs: minutesAgo(2) }), // 何も無い
      entry("305", { completedAtMs: minutesAgo(24) }), // SLA 超過
      entry("302", { checkInAtMs: NOW + 18 * 60_000 }), // 緊急
      entry("210", { completedRounds: 1, completedAtMs: minutesAgo(3) }), // 再検査
    ]);
    expect(order).toEqual(["302", "305", "210", "401"]);
  });

  it("**段を跨いだ入れ替えをしない**（SLA を大きく超えても緊急より下）", () => {
    const order = orderOf([
      entry("305", { completedAtMs: minutesAgo(400) }), // 大幅に超過
      entry("302", { checkInAtMs: NOW + 29 * 60_000 }), // ぎりぎり緊急
    ]);
    expect(order).toEqual(["302", "305"]);
  });

  it("緊急どうしはチェックインが近い順", () => {
    const order = orderOf([
      entry("302", { checkInAtMs: NOW + 25 * 60_000 }),
      entry("303", { checkInAtMs: NOW + 5 * 60_000 }),
      entry("304", { checkInAtMs: NOW + 15 * 60_000 }),
    ]);
    expect(order).toEqual(["303", "304", "302"]);
  });

  it("同じ束の中は完了時刻の古い順", () => {
    const order = orderOf([
      entry("401", { completedAtMs: minutesAgo(2) }),
      entry("402", { completedAtMs: minutesAgo(9) }),
      entry("403", { completedAtMs: minutesAgo(5) }),
    ]);
    expect(order).toEqual(["402", "403", "401"]);
  });

  it("完了時刻が無い件は束の最後", () => {
    const order = orderOf([
      entry("401", { completedAtMs: null }),
      entry("402", { completedAtMs: minutesAgo(1) }),
    ]);
    expect(order).toEqual(["402", "401"]);
  });

  it("完了時刻まで同じなら客室番号で安定させる（30 秒更新で行が飛ばない）", () => {
    const same = minutesAgo(4);
    const order = orderOf([
      entry("402", { completedAtMs: same }),
      entry("401", { completedAtMs: same }),
    ]);
    expect(order).toEqual(["401", "402"]);
  });

  it("入力の配列を書き換えない", () => {
    const input = [entry("402"), entry("401", { checkInAtMs: NOW + 5 * 60_000 })];
    const before = input.map((row) => row.roomNumber);
    sortInspectionQueue(input, NOW, SLA);
    expect(input.map((row) => row.roomNumber)).toEqual(before);
  });

  it("空でも落ちない", () => {
    expect(sortInspectionQueue([], NOW, SLA)).toEqual([]);
  });
});

/**
 * 施設をまたぐ一覧（P7-18）。**施設ごとに SLA が違う配列を 1 本に並べる。**
 *
 * `sortInspectionQueue()` は SLA を全件へ掛けるのでこの用途に使えない。
 * `waitStateOf()` を施設ごとの SLA で通してから比較関数で並べる。
 */
describe("compareInspectionQueue — 施設をまたぐ並び", () => {
  it("施設ごとの SLA で束が決まる", () => {
    // どちらも完了から 30 分。**A（目安 20 分）だけが超過。**
    const a = waitStateOf(entry("101", { completedAtMs: minutesAgo(30) }), NOW, 20);
    const b = waitStateOf(entry("201", { completedAtMs: minutesAgo(30) }), NOW, 90);
    expect(a.isOverSla).toBe(true);
    expect(b.isOverSla).toBe(false);
    expect([b, a].sort(compareInspectionQueue).map((row) => row.roomNumber)).toEqual(["101", "201"]);
  });

  it("超過していない古い件より、超過した新しい件が先", () => {
    const older = waitStateOf(entry("201", { completedAtMs: minutesAgo(60) }), NOW, 90);
    const newerOver = waitStateOf(entry("101", { completedAtMs: minutesAgo(30) }), NOW, 20);
    expect([older, newerOver].sort(compareInspectionQueue).map((row) => row.roomNumber)).toEqual([
      "101",
      "201",
    ]);
  });

  it("緊急は SLA 超過より先（段を跨いだ入れ替えをしない）", () => {
    const over = waitStateOf(entry("101", { completedAtMs: minutesAgo(60) }), NOW, 20);
    const urgent = waitStateOf(
      entry("201", { completedAtMs: minutesAgo(1), checkInAtMs: NOW + 10 * 60_000 }),
      NOW,
      90,
    );
    expect([over, urgent].sort(compareInspectionQueue).map((row) => row.roomNumber)).toEqual([
      "201",
      "101",
    ]);
  });

  it("同じ束なら完了時刻の古い順", () => {
    const first = waitStateOf(entry("101", { completedAtMs: minutesAgo(10) }), NOW, 90);
    const second = waitStateOf(entry("201", { completedAtMs: minutesAgo(5) }), NOW, 20);
    expect([second, first].sort(compareInspectionQueue).map((row) => row.roomNumber)).toEqual([
      "101",
      "201",
    ]);
  });

  it("同着は客室番号で安定する", () => {
    const a = waitStateOf(entry("102", { completedAtMs: minutesAgo(5) }), NOW, 90);
    const b = waitStateOf(entry("101", { completedAtMs: minutesAgo(5) }), NOW, 20);
    expect([a, b].sort(compareInspectionQueue).map((row) => row.roomNumber)).toEqual(["101", "102"]);
  });

  // ── 決定的な並び（P7-18 レビュー指摘）──────────────────
  // **3 つの場合それぞれで、並びが 1 通りに決まることを固定する。**
  // 入力の順序を変えても同じ結果になること（＝比較関数が全順序を与えること）
  // まで見る。30 秒ごとの自動更新で行が飛ぶのを防ぐのがこの性質。

  /** 施設 × SLA を添えた入力を、その施設の SLA で評価して並べる。 */
  function orderWithSla(
    rows: readonly { room: string; minutesAgo: number; sla: number }[],
  ): string[] {
    return rows
      .map((row) => waitStateOf(entry(row.room, { completedAtMs: minutesAgo(row.minutesAgo) }), NOW, row.sla))
      .sort(compareInspectionQueue)
      .map((row) => row.roomNumber);
  }

  it("SLA が同じ場合は完了時刻の古い順に決まる", () => {
    const rows = [
      { room: "101", minutesAgo: 5, sla: 20 },
      { room: "102", minutesAgo: 40, sla: 20 },
      { room: "103", minutesAgo: 25, sla: 20 },
      { room: "104", minutesAgo: 10, sla: 20 },
    ];
    // 40 分・25 分は超過（束 1、古い順）。10 分・5 分は通常（束 3、古い順）。
    expect(orderWithSla(rows)).toEqual(["102", "103", "104", "101"]);
    // **入力順を変えても同じ。**
    expect(orderWithSla([...rows].reverse())).toEqual(["102", "103", "104", "101"]);
  });

  it("SLA が無い（0）場合は超過が起きず、完了時刻の古い順だけで決まる", () => {
    // `waitStateOf()` は `slaMinutes > 0` のときだけ超過を立てる
    // （0 にすると全件超過になり印が意味を失うため / 同関数の注記）。
    const rows = [
      { room: "201", minutesAgo: 120, sla: 0 },
      { room: "202", minutesAgo: 5, sla: 0 },
      { room: "203", minutesAgo: 60, sla: 0 },
    ];
    const states = rows.map((row) =>
      waitStateOf(entry(row.room, { completedAtMs: minutesAgo(row.minutesAgo) }), NOW, row.sla),
    );
    expect(states.every((state) => !state.isOverSla)).toBe(true);
    expect(states.every((state) => state.tone === "NORMAL")).toBe(true);

    expect(orderWithSla(rows)).toEqual(["201", "203", "202"]);
    expect(orderWithSla([...rows].reverse())).toEqual(["201", "203", "202"]);
  });

  it("複数施設で SLA が異なる場合も 1 通りに決まる", () => {
    // 101 / 102 … 施設 A（SLA 20 分）→ どちらも超過（束 1）
    // 201     … 施設 B（SLA 90 分）→ 60 分待ちだが超過しない（束 3）
    // 301     … 施設 C（SLA 無し）  → 120 分待ちでも超過しない（束 3）
    const rows = [
      { room: "101", minutesAgo: 30, sla: 20 },
      { room: "102", minutesAgo: 25, sla: 20 },
      { room: "201", minutesAgo: 60, sla: 90 },
      { room: "301", minutesAgo: 120, sla: 0 },
    ];
    // **最も長く待っている 301 が先頭に来ない。** 待ち時間ではなく
    // 「自分の施設の目安を超えたか」で束が決まる（§11.2）。
    expect(orderWithSla(rows)).toEqual(["101", "102", "301", "201"]);
    expect(orderWithSla([...rows].reverse())).toEqual(["101", "102", "301", "201"]);
  });

  it("`sortInspectionQueue()` と同じ並びになる（単一 SLA のとき）", () => {
    const entries = [
      entry("302", { checkInAtMs: NOW + 10 * 60_000 }),
      entry("305", { completedAtMs: minutesAgo(30) }),
      entry("210", { completedRounds: 2 }),
      entry("401"),
    ];
    const viaSort = sortInspectionQueue(entries, NOW, SLA).map((row) => row.roomNumber);
    const viaCompare = entries
      .map((row) => waitStateOf(row, NOW, SLA))
      .sort(compareInspectionQueue)
      .map((row) => row.roomNumber);
    expect(viaCompare).toEqual(viaSort);
  });
});

describe("summarizeInspectionQueue", () => {
  it("件数の内訳を返す", () => {
    const rows = sortInspectionQueue(
      [
        entry("302", { checkInAtMs: NOW + 10 * 60_000 }),
        entry("305", { completedAtMs: minutesAgo(30) }),
        entry("210", { completedRounds: 2 }),
        entry("401"),
      ],
      NOW,
      SLA,
    );
    expect(summarizeInspectionQueue(rows)).toEqual({
      total: 4,
      urgent: 1,
      overSla: 1,
      recheck: 1,
    });
  });

  it("空なら全部 0", () => {
    expect(summarizeInspectionQueue([])).toEqual({
      total: 0,
      urgent: 0,
      overSla: 0,
      recheck: 0,
    });
  });
});
