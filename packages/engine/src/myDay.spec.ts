import { describe, expect, it } from "vitest";

import {
  buildMyDay,
  filterMyDay,
  lastWorkedPropertyId,
  type MyDayProperty,
  type MyDayTask,
  type RouteLeg,
} from "./myDay.js";
import type { TaskStatusValue } from "./taskStatus.js";

const TOKYO: MyDayProperty = { propertyId: "p_tokyo", code: "HTLA", name: "サンプルホテル東京" };
const YOKOHAMA: MyDayProperty = { propertyId: "p_yoko", code: "BHYK", name: "ビジネスH横浜" };
const OSAKA: MyDayProperty = { propertyId: "p_osaka", code: "INOS", name: "サンプルイン大阪" };

function task(
  taskId: string,
  propertyId: string,
  status: TaskStatusValue = "ASSIGNED",
  roomNumber = "301",
): MyDayTask {
  return { taskId, propertyId, status, priority: 50, roomNumber };
}

function leg(overrides: Partial<RouteLeg> & Pick<RouteLeg, "sequence" | "propertyId">): RouteLeg {
  return { plannedStartAt: null, plannedEndAt: null, travelMinutes: null, ...overrides };
}

describe("buildMyDay: グループ化（§19.3）", () => {
  it("施設ごとに 1 グループにまとめる", () => {
    const day = buildMyDay(
      [task("t1", "p_tokyo"), task("t2", "p_yoko"), task("t3", "p_tokyo", "ASSIGNED", "302")],
      [TOKYO, YOKOHAMA],
      [],
    );
    expect(day.propertyCount).toBe(2);
    expect(day.totalTasks).toBe(3);
    expect(day.groups.map((group) => group.taskCount)).toEqual([2, 1]);
  });

  it("グループ内の並びは §9.2 の順序（作業中が先頭）", () => {
    const day = buildMyDay(
      [
        task("todo", "p_tokyo", "ASSIGNED", "301"),
        task("running", "p_tokyo", "IN_PROGRESS", "999"),
      ],
      [TOKYO],
      [],
    );
    expect(day.groups[0]?.tasks.map((t) => t.taskId)).toEqual(["running", "todo"]);
  });

  it("取消済みは一覧に出さない", () => {
    const day = buildMyDay(
      [task("t1", "p_tokyo"), task("dead", "p_tokyo", "CANCELLED", "302")],
      [TOKYO],
      [],
    );
    expect(day.totalTasks).toBe(1);
  });

  it("取消しか無い施設はグループごと消える", () => {
    const day = buildMyDay(
      [task("t1", "p_tokyo"), task("dead", "p_yoko", "CANCELLED")],
      [TOKYO, YOKOHAMA],
      [],
    );
    expect(day.propertyCount).toBe(1);
  });

  it("施設マスタに無い施設のグループは落とす", () => {
    const day = buildMyDay([task("t1", "p_ghost")], [TOKYO], []);
    expect(day.groups).toEqual([]);
    expect(day.totalTasks).toBe(0);
  });

  it("タスクが 0 件でも落ちない", () => {
    const day = buildMyDay([], [TOKYO], []);
    expect(day).toEqual({
      propertyCount: 0,
      totalTasks: 0,
      summary: { todo: 0, inProgress: 0, rework: 0, blocked: 0, done: 0 },
      groups: [],
    });
  });
});

describe("buildMyDay: 訪問順（§19.5 MUST — dailyRoute 未登録でも動く）", () => {
  it("dailyRoute があればその順", () => {
    const day = buildMyDay(
      [task("t1", "p_tokyo"), task("t2", "p_yoko")],
      [TOKYO, YOKOHAMA],
      [leg({ sequence: 1, propertyId: "p_yoko" }), leg({ sequence: 2, propertyId: "p_tokyo" })],
    );
    expect(day.groups.map((group) => group.property.propertyId)).toEqual(["p_yoko", "p_tokyo"]);
  });

  it("dailyRoute が無ければ施設名の昇順", () => {
    const day = buildMyDay([task("t1", "p_yoko"), task("t2", "p_tokyo")], [TOKYO, YOKOHAMA], []);
    // 「サンプルホテル東京」<「ビジネスH横浜」
    expect(day.groups.map((group) => group.property.name)).toEqual([
      "サンプルホテル東京",
      "ビジネスH横浜",
    ]);
  });

  it("一部だけ登録されていれば、登録ぶんが先で残りは名前順", () => {
    const day = buildMyDay(
      [task("t1", "p_tokyo"), task("t2", "p_yoko"), task("t3", "p_osaka")],
      [TOKYO, YOKOHAMA, OSAKA],
      [leg({ sequence: 1, propertyId: "p_yoko" })],
    );
    expect(day.groups.map((group) => group.property.propertyId)).toEqual([
      "p_yoko",
      "p_osaka",
      "p_tokyo",
    ]);
  });

  it("sequence は一覧内の連番（route の番号をそのまま出さない）", () => {
    const day = buildMyDay(
      [task("t1", "p_tokyo")],
      [TOKYO, YOKOHAMA],
      [leg({ sequence: 1, propertyId: "p_yoko" }), leg({ sequence: 2, propertyId: "p_tokyo" })],
    );
    // 横浜にはタスクが無い。東京だけが残り、番号は 1 になる。
    expect(day.groups[0]?.sequence).toBe(1);
  });

  it("予定時刻を載せる", () => {
    const day = buildMyDay(
      [task("t1", "p_tokyo")],
      [TOKYO],
      [leg({ sequence: 1, propertyId: "p_tokyo", plannedStartAt: "09:00", plannedEndAt: "13:00" })],
    );
    expect(day.groups[0]?.plannedStartAt).toBe("09:00");
    expect(day.groups[0]?.plannedEndAt).toBe("13:00");
  });
});

describe("buildMyDay: 移動ブロック（§19.3）", () => {
  it("次のグループがあるときだけ移動時間を載せる", () => {
    const day = buildMyDay(
      [task("t1", "p_tokyo"), task("t2", "p_yoko")],
      [TOKYO, YOKOHAMA],
      [
        leg({ sequence: 1, propertyId: "p_tokyo", travelMinutes: 25 }),
        leg({ sequence: 2, propertyId: "p_yoko", travelMinutes: 40 }),
      ],
    );
    expect(day.groups[0]?.travelMinutesToNext).toBe(25);
    // 最後の施設に「移動 40 分」を出さない（帰り道の指示に読める）。
    expect(day.groups[1]?.travelMinutesToNext).toBeNull();
  });

  it("移動時間が未設定なら null（『移動』だけを画面が出す）", () => {
    const day = buildMyDay(
      [task("t1", "p_tokyo"), task("t2", "p_yoko")],
      [TOKYO, YOKOHAMA],
      [leg({ sequence: 1, propertyId: "p_tokyo" }), leg({ sequence: 2, propertyId: "p_yoko" })],
    );
    expect(day.groups[0]?.travelMinutesToNext).toBeNull();
  });

  it("dailyRoute 未登録なら移動時間はどこにも出ない", () => {
    const day = buildMyDay([task("t1", "p_tokyo"), task("t2", "p_yoko")], [TOKYO, YOKOHAMA], []);
    expect(day.groups.map((group) => group.travelMinutesToNext)).toEqual([null, null]);
  });
});

describe("buildMyDay: 自動折りたたみ（§19.3）", () => {
  it("全件完了なら allDone", () => {
    const day = buildMyDay(
      [task("t1", "p_tokyo", "COMPLETED"), task("t2", "p_tokyo", "AWAITING_INSPECTION", "302")],
      [TOKYO],
      [],
    );
    expect(day.groups[0]?.allDone).toBe(true);
  });

  it("1 件でも残っていれば allDone にしない", () => {
    const day = buildMyDay(
      [task("t1", "p_tokyo", "COMPLETED"), task("t2", "p_tokyo", "ASSIGNED", "302")],
      [TOKYO],
      [],
    );
    expect(day.groups[0]?.allDone).toBe(false);
  });

  it("入室不可が残っていれば allDone にしない", () => {
    const day = buildMyDay(
      [task("t1", "p_tokyo", "COMPLETED"), task("t2", "p_tokyo", "BLOCKED", "302")],
      [TOKYO],
      [],
    );
    expect(day.groups[0]?.allDone).toBe(false);
  });
});

describe("buildMyDay: 5 段カウンタ", () => {
  it("状態ごとに数える", () => {
    const day = buildMyDay(
      [
        task("a", "p_tokyo", "ASSIGNED", "301"),
        task("b", "p_tokyo", "IN_PROGRESS", "302"),
        task("c", "p_yoko", "REWORK", "401"),
        task("d", "p_yoko", "BLOCKED", "402"),
        task("e", "p_yoko", "COMPLETED", "403"),
      ],
      [TOKYO, YOKOHAMA],
      [],
    );
    expect(day.summary).toEqual({ todo: 1, inProgress: 1, rework: 1, blocked: 1, done: 1 });
  });

  it("PAUSED は作業中に数える", () => {
    const day = buildMyDay([task("a", "p_tokyo", "PAUSED")], [TOKYO], []);
    expect(day.summary.inProgress).toBe(1);
  });

  it("合計は totalTasks と一致する", () => {
    const day = buildMyDay(
      [
        task("a", "p_tokyo", "ASSIGNED", "301"),
        task("b", "p_tokyo", "COMPLETED", "302"),
        task("c", "p_tokyo", "CANCELLED", "303"),
      ],
      [TOKYO],
      [],
    );
    const { todo, inProgress, rework, blocked, done } = day.summary;
    const total = todo + inProgress + rework + blocked + done;
    expect(total).toBe(day.totalTasks);
  });
});

describe("filterMyDay: 全施設をまたぐ（§19.3 MUST）", () => {
  const day = buildMyDay(
    [
      task("a", "p_tokyo", "ASSIGNED", "301"),
      task("b", "p_tokyo", "COMPLETED", "302"),
      task("c", "p_yoko", "COMPLETED", "401"),
    ],
    [TOKYO, YOKOHAMA],
    [leg({ sequence: 1, propertyId: "p_tokyo", travelMinutes: 25 })],
  );

  it("ALL は素通し（同じ参照を返してよい）", () => {
    expect(filterMyDay(day, "ALL")).toEqual(day);
  });

  it("TODO は未着手だけを残す", () => {
    const filtered = filterMyDay(day, "TODO");
    expect(filtered.groups.flatMap((group) => group.tasks).map((t) => t.taskId)).toEqual(["a"]);
  });

  it("DONE は完了だけを残す（施設をまたぐ）", () => {
    const filtered = filterMyDay(day, "DONE");
    expect(filtered.groups.flatMap((group) => group.tasks).map((t) => t.taskId).sort()).toEqual([
      "b",
      "c",
    ]);
  });

  it("空になったグループを落とす", () => {
    const filtered = filterMyDay(day, "TODO");
    expect(filtered.propertyCount).toBe(1);
    expect(filtered.groups[0]?.property.propertyId).toBe("p_tokyo");
  });

  it("summary は絞る前のまま（ボタンの件数が押して変わらない）", () => {
    expect(filterMyDay(day, "TODO").summary).toEqual(day.summary);
  });

  it("totalTasks は絞ったあとの実数", () => {
    expect(filterMyDay(day, "TODO").totalTasks).toBe(1);
  });

  it("絞った結果として最後になったグループの移動時間を落とす", () => {
    const filtered = filterMyDay(day, "TODO");
    expect(filtered.groups[0]?.travelMinutesToNext).toBeNull();
  });

  it("入室不可は未着手にも完了にも入らない", () => {
    const blocked = buildMyDay([task("x", "p_tokyo", "BLOCKED")], [TOKYO], []);
    expect(filterMyDay(blocked, "TODO").totalTasks).toBe(0);
    expect(filterMyDay(blocked, "DONE").totalTasks).toBe(0);
  });

  it("入力を書き換えない", () => {
    const before = JSON.stringify(day);
    filterMyDay(day, "DONE");
    expect(JSON.stringify(day)).toBe(before);
  });
});

describe("lastWorkedPropertyId — 施設が変わる開始の判断（§19.8 / P1-23）", () => {
  const started = (propertyId: string, startedAt: number | null) => ({ propertyId, startedAt });

  it("開始時刻が最も新しいタスクの施設を返す", () => {
    expect(
      lastWorkedPropertyId([
        started("p_tokyo", 1_000),
        started("p_yoko", 3_000),
        started("p_osaka", 2_000),
      ]),
    ).toBe("p_yoko");
  });

  it("1 件も始まっていなければ null（当日の初回は確認を出さない）", () => {
    expect(lastWorkedPropertyId([started("p_tokyo", null), started("p_yoko", null)])).toBeNull();
  });

  it("空でも落ちない", () => {
    expect(lastWorkedPropertyId([])).toBeNull();
  });

  it("同じ施設に戻ってきた場合、直前は別施設のまま（確認が出る）", () => {
    // A館 → B館 → いま A館 のタスクを開始しようとしている。
    expect(
      lastWorkedPropertyId([started("p_tokyo", 1_000), started("p_yoko", 2_000)]),
    ).toBe("p_yoko");
  });

  it("未着手が混ざっていても開始済みだけを見る", () => {
    expect(
      lastWorkedPropertyId([started("p_yoko", null), started("p_tokyo", 500)]),
    ).toBe("p_tokyo");
  });

  it("同じ施設の連続作業では施設が変わらない（確認が出ない）", () => {
    expect(
      lastWorkedPropertyId([started("p_yoko", 1_000), started("p_yoko", 2_000)]),
    ).toBe("p_yoko");
  });

  it("入力を書き換えない", () => {
    const tasks = [started("p_tokyo", 1_000), started("p_yoko", 2_000)];
    const before = JSON.stringify(tasks);
    lastWorkedPropertyId(tasks);
    expect(JSON.stringify(tasks)).toBe(before);
  });
});
