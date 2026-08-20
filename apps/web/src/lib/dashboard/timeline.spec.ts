/**
 * 本日の動きの組み立ての検査。
 *
 * ルール: security.md §5（個人を出さない）/ testing.md §3
 */

import { describe, expect, it } from "vitest";

import { buildTimeline, TIMELINE_EVENTS, type TimelineLogInput } from "./timeline.js";

const NAMES = new Map([["p1", "サンプルホテル東京"]]);

function log(overrides: Partial<TimelineLogInput> & { id: string }): TimelineLogInput {
  return {
    id: overrides.id,
    at: overrides.at ?? new Date("2026-08-11T01:48:00+09:00"),
    action: overrides.action ?? "task.completed",
    propertyId: overrides.propertyId === undefined ? "p1" : overrides.propertyId,
  };
}

describe("buildTimeline — 載せる操作", () => {
  it("現場の操作を文言と色つきで返す", () => {
    const rows = buildTimeline([log({ id: "a", action: "task.reworkAssigned" })], NAMES, 10);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("dashboard.org.event.reworkAssigned");
    expect(rows[0]?.tone).toBe("warn");
    expect(rows[0]?.propertyName).toBe("サンプルホテル東京");
  });

  it("表に無い操作は載せない（設定変更が現場の画面へ漏れない）", () => {
    const rows = buildTimeline(
      [
        log({ id: "a", action: "taxProfile.updated" }),
        log({ id: "b", action: "payRule.created" }),
        log({ id: "c", action: "task.completed" }),
      ],
      NAMES,
      10,
    );

    expect(rows.map((row) => row.id)).toEqual(["c"]);
  });

  it("入室不可は青（急かす色にしない / 契約 §11.2）", () => {
    expect(TIMELINE_EVENTS["task.blocked"]?.tone).toBe("info");
    expect(TIMELINE_EVENTS["room.statusOverridden"]?.tone).toBe("info");
  });

  it("完了は緑、差異の確認は赤", () => {
    expect(TIMELINE_EVENTS["task.completed"]?.tone).toBe("ok");
    expect(TIMELINE_EVENTS["finding.statusChanged"]?.tone).toBe("danger");
  });
});

describe("buildTimeline — 件数と施設名", () => {
  it("limit で打ち切る", () => {
    const logs = [1, 2, 3, 4, 5].map((n) => log({ id: `a${String(n)}` }));
    expect(buildTimeline(logs, NAMES, 3)).toHaveLength(3);
  });

  it("組織全体の操作は施設名が null", () => {
    const rows = buildTimeline([log({ id: "a", propertyId: null })], NAMES, 10);
    expect(rows[0]?.propertyName).toBeNull();
  });

  it("名前を引けない施設 ID は null（ID を画面に出さない）", () => {
    const rows = buildTimeline([log({ id: "a", propertyId: "unknown" })], NAMES, 10);
    expect(rows[0]?.propertyName).toBeNull();
  });

  it("人の識別子を持たない（security.md §5）", () => {
    const rows = buildTimeline([log({ id: "a" })], NAMES, 10);
    expect(Object.keys(rows[0] ?? {})).toEqual(["id", "at", "label", "tone", "propertyName"]);
  });
});
