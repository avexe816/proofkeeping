/**
 * 施設選択画面（P1-22 / PK-SPEC-P1 §19.4）。
 *
 * ルール: .claude/rules/testing.md §3（純粋関数はルールごとに正例・負例）
 *
 * ── 見ているもの ────────────────────────────────────────
 *   閾値の判定（4 施設以上で挟む / 組織設定で 2〜10）
 *   当日と翌日の切り分け（翌日は `startable: false`）
 *   「現在ここ」の 3 段（時間帯の中 → 次に始まる → 未着手が最多）
 *   サマリー 3 項目（施設 / 総室数 / 再清掃）
 */

import { describe, expect, it } from "vitest";

import { buildMyDay, type MyDayProperty, type MyDayTask } from "./myDay.js";
import { buildPropertyPicker, needsPropertyPicker } from "./propertyPicker.js";
import type { TaskStatusValue } from "./taskStatus.js";

const TOKYO: MyDayProperty = { propertyId: "p_tokyo", code: "HTLA", name: "サンプルホテル東京" };
const YOKOHAMA: MyDayProperty = { propertyId: "p_yoko", code: "BHYK", name: "ビジネスH横浜" };
const OSAKA: MyDayProperty = { propertyId: "p_osaka", code: "INOS", name: "サンプルイン大阪" };
const KYOTO: MyDayProperty = { propertyId: "p_kyoto", code: "RYKY", name: "サンプル旅館京都" };

const TODAY = "2026-08-10";
const TOMORROW = "2026-08-11";

function task(
  taskId: string,
  propertyId: string,
  status: TaskStatusValue = "ASSIGNED",
  roomNumber = "301",
): MyDayTask {
  return { taskId, propertyId, status, priority: 50, roomNumber };
}

/** 訪問順の 1 行。時間帯を入れないぶんは `null`。 */
function leg(
  sequence: number,
  propertyId: string,
  plannedStartAt: string | null = null,
  plannedEndAt: string | null = null,
) {
  return { sequence, propertyId, plannedStartAt, plannedEndAt, travelMinutes: null };
}

function day(
  businessDate: string,
  tasks: MyDayTask[],
  properties: MyDayProperty[],
  route: ReturnType<typeof leg>[] = [],
) {
  return { businessDate, groups: buildMyDay(tasks, properties, route).groups };
}

const EMPTY = { businessDate: TOMORROW, groups: [] };

describe("needsPropertyPicker — 閾値（§19.4 / 正例）", () => {
  it("既定の 4 で、4 施設なら挟む", () => {
    expect(needsPropertyPicker(4, 4)).toBe(true);
  });

  it("既定の 4 で、5 施設なら挟む", () => {
    expect(needsPropertyPicker(5, 4)).toBe(true);
  });

  it("設定を 2 にすれば 2 施設で挟む", () => {
    expect(needsPropertyPicker(2, 2)).toBe(true);
  });

  it("設定を 10 にすれば 10 施設で挟む", () => {
    expect(needsPropertyPicker(10, 10)).toBe(true);
  });

  it("設定を 3 にすれば 3 施設で挟む", () => {
    expect(needsPropertyPicker(3, 3)).toBe(true);
  });
});

describe("needsPropertyPicker — 閾値（負例）", () => {
  it("既定の 4 で、3 施設なら挟まない（§19.3 のグループ表示で足りる）", () => {
    expect(needsPropertyPicker(3, 4)).toBe(false);
  });

  it("1 施設なら挟まない", () => {
    expect(needsPropertyPicker(1, 4)).toBe(false);
  });

  it("担当が 0 件でも挟まない", () => {
    expect(needsPropertyPicker(0, 4)).toBe(false);
  });

  it("設定を 10 にすれば 9 施設でも挟まない", () => {
    expect(needsPropertyPicker(9, 10)).toBe(false);
  });

  it("設定を 2 にしても 1 施設なら挟まない", () => {
    expect(needsPropertyPicker(1, 2)).toBe(false);
  });
});

describe("buildPropertyPicker — 当日と翌日（§19.4）", () => {
  it("当日のグループを訪問順のまま並べる", () => {
    const picker = buildPropertyPicker(
      day(TODAY, [task("t1", "p_tokyo"), task("t2", "p_yoko")], [TOKYO, YOKOHAMA]),
      EMPTY,
      "09:00",
    );
    expect(picker.entries.map((entry) => entry.propertyId)).toEqual(["p_tokyo", "p_yoko"]);
  });

  it("当日は開始できる", () => {
    const picker = buildPropertyPicker(day(TODAY, [task("t1", "p_tokyo")], [TOKYO]), EMPTY, "09:00");
    expect(picker.entries[0]?.startable).toBe(true);
  });

  it("翌日は表示のみ（開始できない）", () => {
    const picker = buildPropertyPicker(
      day(TODAY, [task("t1", "p_tokyo")], [TOKYO]),
      day(TOMORROW, [task("t9", "p_kyoto")], [KYOTO]),
      "09:00",
    );
    const kyoto = picker.entries.find((entry) => entry.propertyId === "p_kyoto");
    expect(kyoto?.startable).toBe(false);
    expect(kyoto?.isToday).toBe(false);
  });

  it("翌日ぶんは当日の後ろに並ぶ", () => {
    const picker = buildPropertyPicker(
      day(TODAY, [task("t1", "p_yoko")], [YOKOHAMA]),
      day(TOMORROW, [task("t9", "p_kyoto")], [KYOTO]),
      "09:00",
    );
    expect(picker.entries.map((entry) => entry.propertyId)).toEqual(["p_yoko", "p_kyoto"]);
  });

  it("翌日は「現在ここ」にならない", () => {
    const picker = buildPropertyPicker(
      { businessDate: TODAY, groups: [] },
      day(TOMORROW, [task("t9", "p_kyoto")], [KYOTO]),
      "09:00",
    );
    expect(picker.entries.every((entry) => !entry.isCurrent)).toBe(true);
    expect(picker.defaultPropertyId).toBeNull();
  });

  it("当日のタスクが無ければ、翌日ぶんだけが並ぶ", () => {
    const picker = buildPropertyPicker(
      { businessDate: TODAY, groups: [] },
      day(TOMORROW, [task("t9", "p_kyoto")], [KYOTO]),
      "09:00",
    );
    expect(picker.summary.propertyCount).toBe(0);
    expect(picker.entries).toHaveLength(1);
  });
});

describe("buildPropertyPicker — サマリー 3 項目", () => {
  it("施設数は当日ぶんだけを数える", () => {
    const picker = buildPropertyPicker(
      day(TODAY, [task("t1", "p_tokyo"), task("t2", "p_yoko")], [TOKYO, YOKOHAMA]),
      day(TOMORROW, [task("t9", "p_kyoto")], [KYOTO]),
      "09:00",
    );
    expect(picker.summary.propertyCount).toBe(2);
  });

  it("総室数は当日の全施設の合計", () => {
    const picker = buildPropertyPicker(
      day(
        TODAY,
        [task("t1", "p_tokyo"), task("t2", "p_tokyo", "ASSIGNED", "302"), task("t3", "p_yoko")],
        [TOKYO, YOKOHAMA],
      ),
      EMPTY,
      "09:00",
    );
    expect(picker.summary.totalTasks).toBe(3);
  });

  it("再清掃だけを別に数える", () => {
    const picker = buildPropertyPicker(
      day(TODAY, [task("t1", "p_tokyo", "REWORK"), task("t2", "p_tokyo")], [TOKYO]),
      EMPTY,
      "09:00",
    );
    expect(picker.summary.reworkTasks).toBe(1);
    expect(picker.entries[0]?.reworkCount).toBe(1);
  });

  it("翌日の再清掃は当日のサマリーに入らない", () => {
    const picker = buildPropertyPicker(
      day(TODAY, [task("t1", "p_tokyo")], [TOKYO]),
      day(TOMORROW, [task("t9", "p_kyoto", "REWORK")], [KYOTO]),
      "09:00",
    );
    expect(picker.summary.reworkTasks).toBe(0);
  });

  it("未着手の件数を施設ごとに持つ", () => {
    const picker = buildPropertyPicker(
      day(
        TODAY,
        [task("t1", "p_tokyo"), task("t2", "p_tokyo", "IN_PROGRESS", "302")],
        [TOKYO],
      ),
      EMPTY,
      "09:00",
    );
    expect(picker.entries[0]?.todoCount).toBe(1);
    expect(picker.entries[0]?.taskCount).toBe(2);
  });
});

describe("buildPropertyPicker — 「現在ここ」（正例）", () => {
  it("時間帯の中にある施設を選ぶ", () => {
    const picker = buildPropertyPicker(
      day(
        TODAY,
        [task("t1", "p_tokyo"), task("t2", "p_yoko")],
        [TOKYO, YOKOHAMA],
        [leg(1, "p_tokyo", "09:00", "13:00"), leg(2, "p_yoko", "13:30", "17:00")],
      ),
      EMPTY,
      "14:00",
    );
    expect(picker.defaultPropertyId).toBe("p_yoko");
  });

  it("開始時刻だけが入っていれば、始まっている施設を選ぶ", () => {
    const picker = buildPropertyPicker(
      day(
        TODAY,
        [task("t1", "p_tokyo")],
        [TOKYO],
        [leg(1, "p_tokyo", "09:00")],
      ),
      EMPTY,
      "11:00",
    );
    expect(picker.defaultPropertyId).toBe("p_tokyo");
  });

  it("どの時間帯にも当てはまらなければ、次に始まる施設を選ぶ", () => {
    const picker = buildPropertyPicker(
      day(
        TODAY,
        [task("t1", "p_tokyo"), task("t2", "p_yoko")],
        [TOKYO, YOKOHAMA],
        [leg(1, "p_tokyo", "09:00", "13:00"), leg(2, "p_yoko", "15:00", "18:00")],
      ),
      EMPTY,
      "14:00",
    );
    expect(picker.defaultPropertyId).toBe("p_yoko");
  });

  it("時間帯が 1 件も無ければ、未着手が最も多い施設を選ぶ", () => {
    const picker = buildPropertyPicker(
      day(
        TODAY,
        [
          task("t1", "p_tokyo"),
          task("t2", "p_yoko"),
          task("t3", "p_yoko", "ASSIGNED", "302"),
        ],
        [TOKYO, YOKOHAMA],
      ),
      EMPTY,
      "09:00",
    );
    expect(picker.defaultPropertyId).toBe("p_yoko");
  });

  it("未着手が同数なら訪問順の先頭（並びを覆さない）", () => {
    const picker = buildPropertyPicker(
      day(TODAY, [task("t1", "p_osaka"), task("t2", "p_tokyo")], [OSAKA, TOKYO]),
      EMPTY,
      "09:00",
    );
    // 名前順（サンプルイン大阪 → サンプルホテル東京）の先頭。
    expect(picker.defaultPropertyId).toBe(picker.entries[0]?.propertyId);
  });

  it("「現在ここ」は当日の 1 件だけ", () => {
    const picker = buildPropertyPicker(
      day(
        TODAY,
        [task("t1", "p_tokyo"), task("t2", "p_yoko")],
        [TOKYO, YOKOHAMA],
        [leg(1, "p_tokyo", "09:00", "13:00"), leg(2, "p_yoko", "13:30", "17:00")],
      ),
      EMPTY,
      "10:00",
    );
    expect(picker.entries.filter((entry) => entry.isCurrent)).toHaveLength(1);
  });
});

describe("buildPropertyPicker — 「現在ここ」（負例）", () => {
  it("当日のタスクが 1 件も無ければ既定は無い", () => {
    const picker = buildPropertyPicker({ businessDate: TODAY, groups: [] }, EMPTY, "09:00");
    expect(picker.defaultPropertyId).toBeNull();
  });

  it("時間帯を過ぎた施設は「次に始まる施設」の候補にしない", () => {
    const picker = buildPropertyPicker(
      day(
        TODAY,
        [task("t1", "p_tokyo"), task("t2", "p_yoko")],
        [TOKYO, YOKOHAMA],
        [leg(1, "p_tokyo", "07:00", "08:00"), leg(2, "p_yoko", "09:00", "12:00")],
      ),
      EMPTY,
      "08:30",
    );
    expect(picker.defaultPropertyId).toBe("p_yoko");
  });

  it("すべての時間帯が過ぎていれば、未着手が最も多い施設へ落ちる", () => {
    const picker = buildPropertyPicker(
      day(
        TODAY,
        [task("t1", "p_tokyo"), task("t2", "p_yoko"), task("t3", "p_yoko", "ASSIGNED", "302")],
        [TOKYO, YOKOHAMA],
        [leg(1, "p_tokyo", "07:00", "08:00"), leg(2, "p_yoko", "08:00", "09:00")],
      ),
      EMPTY,
      "23:00",
    );
    expect(picker.defaultPropertyId).toBe("p_yoko");
  });

  it("完了しかない施設は未着手 0 として扱う", () => {
    const picker = buildPropertyPicker(
      day(
        TODAY,
        [task("t1", "p_tokyo", "COMPLETED"), task("t2", "p_yoko")],
        [TOKYO, YOKOHAMA],
      ),
      EMPTY,
      "09:00",
    );
    expect(picker.defaultPropertyId).toBe("p_yoko");
  });

  it("翌日に時間帯があっても当日の判定に混ざらない", () => {
    const picker = buildPropertyPicker(
      day(TODAY, [task("t1", "p_tokyo")], [TOKYO]),
      day(TOMORROW, [task("t9", "p_kyoto")], [KYOTO], [leg(1, "p_kyoto", "09:00", "12:00")]),
      "10:00",
    );
    expect(picker.defaultPropertyId).toBe("p_tokyo");
  });
});
