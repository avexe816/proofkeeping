/**
 * 抑制（P4-03 / PK-SPEC-P4 §4.1）。
 *
 * ルール: .claude/rules/testing.md §3（正例・負例を各 5 件以上）
 *
 * §10.3 の受け入れ基準がそのまま並んでいる。
 * **抑制は握りつぶしではない**（§4.3）。理由が返ることを固定する。
 */

import { describe, expect, it } from "vitest";

import {
  NEW_PROPERTY_SUPPRESSION_DAYS,
  availableSourcesOf,
  suppressionReasonOf,
  type SuppressionInputs,
} from "./suppression.js";
import type {
  AccessLogFact,
  OccupancyFact,
  PropertyFact,
  ReconciliationSource,
  RoomFact,
  Rule,
  RuleSetting,
} from "./types.js";

const PROPERTY: PropertyFact = {
  id: "o7k2m9__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
  occupancyLinked: true,
  daysSinceOperationStart: 400,
};

const ROOM: RoomFact = {
  id: "o7k2m9__room_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
  number: "302",
  roomTypeId: "o7k2m9__rtyp_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
  saleStatus: "ON_SALE",
};

const OCCUPANCY: OccupancyFact = {
  isOccupied: false,
  guestCount: 0,
  reservationRef: null,
  checkInAt: null,
  checkOutAt: null,
  isStayover: false,
  nightsTotal: null,
  nightIndex: null,
  isComplimentary: false,
  isHouseUse: false,
};

const ACCESS_LOG: AccessLogFact = {
  purpose: "MAINTENANCE",
  enteredAt: Date.parse("2026-09-09T10:00:00+09:00"),
  exitedAt: null,
};

/** A + B を要るルール（R001 相当）。**実体ではない。** */
const RULE: Rule = {
  code: "TEST",
  version: "1.0",
  title: "テスト用",
  requires: ["occupancy", "observation"],
  evaluate: () => null,
};

const ALL_SOURCES: ReconciliationSource[] = ["occupancy", "observation", "signal"];

function inputs(overrides: Partial<SuppressionInputs> = {}): SuppressionInputs {
  return {
    property: PROPERTY,
    room: ROOM,
    occupancy: OCCUPANCY,
    accessLogs: [],
    availableSources: ALL_SOURCES,
    setting: undefined,
    ...overrides,
  };
}

const ENABLED: RuleSetting = { isEnabled: true, severityOverride: null, thresholds: {} };

describe("suppressionReasonOf — 抑制する（正例 / §4.1）", () => {
  it("ruleConfig で無効なら抑制する", () => {
    expect(suppressionReasonOf(RULE, inputs({ setting: { ...ENABLED, isEnabled: false } }))).toBe(
      "RULE_DISABLED",
    );
  });

  it("要る系統が欠けていれば抑制する（§1.2）", () => {
    // 「A のみ」＝ 観察が無い → A + B のルールは動かない。
    expect(suppressionReasonOf(RULE, inputs({ availableSources: ["occupancy"] }))).toBe(
      "SOURCE_UNAVAILABLE",
    );
  });

  it("施設が稼働記録の連携を持たなければ、A 系統を要るルールを抑制する", () => {
    expect(
      suppressionReasonOf(RULE, inputs({ property: { ...PROPERTY, occupancyLinked: false } })),
    ).toBe("OCCUPANCY_NOT_LINKED");
  });

  it("運用開始から 30 日以内はベースラインを要るルールを抑制する", () => {
    const rule: Rule = { ...RULE, requiresBaseline: true };
    expect(
      suppressionReasonOf(
        rule,
        inputs({
          property: { ...PROPERTY, daysSinceOperationStart: NEW_PROPERTY_SUPPRESSION_DAYS - 1 },
        }),
      ),
    ).toBe("OPERATION_TOO_NEW");
  });

  it("客室が MAINTENANCE なら抑制する（§10.3）", () => {
    expect(suppressionReasonOf(RULE, inputs({ room: { ...ROOM, saleStatus: "MAINTENANCE" } }))).toBe(
      "ROOM_NOT_ON_SALE",
    );
  });

  it("客室が OUT_OF_ORDER なら抑制する", () => {
    expect(
      suppressionReasonOf(RULE, inputs({ room: { ...ROOM, saleStatus: "OUT_OF_ORDER" } })),
    ).toBe("ROOM_NOT_ON_SALE");
  });

  it("自社利用なら抑制する", () => {
    expect(
      suppressionReasonOf(RULE, inputs({ occupancy: { ...OCCUPANCY, isHouseUse: true } })),
    ).toBe("HOUSE_USE_OR_COMPLIMENTARY");
  });

  it("招待・無償なら抑制する", () => {
    expect(
      suppressionReasonOf(RULE, inputs({ occupancy: { ...OCCUPANCY, isComplimentary: true } })),
    ).toBe("HOUSE_USE_OR_COMPLIMENTARY");
  });

  it("正当な入室が登録済みなら抑制する（§10.3）", () => {
    expect(suppressionReasonOf(RULE, inputs({ accessLogs: [ACCESS_LOG] }))).toBe(
      "ACCESS_LOG_REGISTERED",
    );
  });
});

describe("suppressionReasonOf — 抑制しない（負例）", () => {
  it("条件が 1 つも当たらなければ null", () => {
    expect(suppressionReasonOf(RULE, inputs())).toBeNull();
  });

  it("設定が有効なら抑制しない", () => {
    expect(suppressionReasonOf(RULE, inputs({ setting: ENABLED }))).toBeNull();
  });

  it("系統が余分にあっても抑制しない", () => {
    const rule: Rule = { ...RULE, requires: ["observation"] };
    expect(suppressionReasonOf(rule, inputs({ availableSources: ALL_SOURCES }))).toBeNull();
  });

  it("A 系統を要らないルールは、連携が無くても動く（§1.2 の「B のみ」）", () => {
    // R006 がこれ。**連携の欠落を見つけるルールが連携の有無で消えては困る。**
    const rule: Rule = { ...RULE, requires: ["observation"] };
    expect(
      suppressionReasonOf(
        rule,
        inputs({
          property: { ...PROPERTY, occupancyLinked: false },
          availableSources: ["observation"],
        }),
      ),
    ).toBeNull();
  });

  it("ベースラインを要らないルールは、運用が浅くても抑制しない", () => {
    expect(
      suppressionReasonOf(
        RULE,
        inputs({ property: { ...PROPERTY, daysSinceOperationStart: 1 } }),
      ),
    ).toBeNull();
  });

  it("運用開始からちょうど 30 日なら抑制しない", () => {
    const rule: Rule = { ...RULE, requiresBaseline: true };
    expect(
      suppressionReasonOf(
        rule,
        inputs({
          property: { ...PROPERTY, daysSinceOperationStart: NEW_PROPERTY_SUPPRESSION_DAYS },
        }),
      ),
    ).toBeNull();
  });

  it("運用日数が分からなければ抑制しない（推測しない）", () => {
    const rule: Rule = { ...RULE, requiresBaseline: true };
    expect(
      suppressionReasonOf(
        rule,
        inputs({ property: { ...PROPERTY, daysSinceOperationStart: null } }),
      ),
    ).toBeNull();
  });

  it("販売中の客室は抑制しない", () => {
    expect(suppressionReasonOf(RULE, inputs({ room: { ...ROOM, saleStatus: "ON_SALE" } }))).toBeNull();
  });

  it("稼働記録が無くても、それだけでは抑制しない", () => {
    // **「稼働記録が無い」は R006 が見る事実そのもの。** 抑制の理由ではない。
    const rule: Rule = { ...RULE, requires: ["observation"] };
    expect(
      suppressionReasonOf(rule, inputs({ occupancy: null, availableSources: ["observation"] })),
    ).toBeNull();
  });
});

describe("suppressionReasonOf — 理由の優先順", () => {
  it("無効な設定が、客室の状態より先に返る", () => {
    expect(
      suppressionReasonOf(
        RULE,
        inputs({
          setting: { ...ENABLED, isEnabled: false },
          room: { ...ROOM, saleStatus: "MAINTENANCE" },
          accessLogs: [ACCESS_LOG],
        }),
      ),
    ).toBe("RULE_DISABLED");
  });

  it("系統の欠落が、入室記録より先に返る", () => {
    expect(
      suppressionReasonOf(
        RULE,
        inputs({ availableSources: ["occupancy"], accessLogs: [ACCESS_LOG] }),
      ),
    ).toBe("SOURCE_UNAVAILABLE");
  });
});

describe("availableSourcesOf", () => {
  it("3 系統そろえば 3 つ返す", () => {
    expect(
      availableSourcesOf({ occupancy: OCCUPANCY, observation: {}, signals: [{}] }),
    ).toEqual(["occupancy", "observation", "signal"]);
  });

  it("稼働記録が無ければ occupancy を含まない", () => {
    expect(availableSourcesOf({ occupancy: null, observation: {}, signals: [] })).toEqual([
      "observation",
    ]);
  });

  it("シグナルが 0 件なら signal を含まない", () => {
    expect(
      availableSourcesOf({ occupancy: OCCUPANCY, observation: {}, signals: [] }),
    ).toEqual(["occupancy", "observation"]);
  });

  it("観察をスキップしていても観察系統はある扱い", () => {
    // 「今回は記録しない」は現場が選べる正当な操作（PK-SPEC-P3 §1.3）。
    // **系統の欠落ではない。**
    expect(
      availableSourcesOf({ occupancy: null, observation: { skipped: true }, signals: [] }),
    ).toEqual(["observation"]);
  });

  it("何も無ければ空", () => {
    expect(availableSourcesOf({ occupancy: null, observation: null, signals: [] })).toEqual([]);
  });
});
