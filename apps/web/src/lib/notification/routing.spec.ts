/**
 * 通知の宛先とチャネル（P6-09 / PK-SPEC-P6 §5.1〜§5.3）。
 *
 * ルール: .claude/rules/testing.md §3（正例・負例を最低 5 件ずつ）
 *
 * 完了条件（`docs/tasks/P6-09.md`）:
 *   - 10 イベントが定義されている
 *   - **`CLEANER` に `task.rework_assigned` 以外が届かない**
 *   - 静音時間が機能する
 */

import { NOTIFICATION_EVENT_CODES, type NotificationEventCode } from "@pk/db";
import { describe, expect, it } from "vitest";

import {
  CLEANER_ALLOWED_EVENT,
  NOTIFICATION_EVENTS,
  audienceOf,
  canReceive,
  findNotificationEvent,
} from "./events.js";
import {
  DEFAULT_QUIET_HOURS_FROM,
  DEFAULT_QUIET_HOURS_TO,
  isQuietHours,
  outboundChannelsOf,
  parseClock,
  resolveChannels,
  type ChannelResolution,
} from "./routing.js";

/** 既定の引数。各テストが必要な分だけ崩す。 */
function resolution(overrides: Partial<ChannelResolution> = {}): ChannelResolution {
  return {
    eventCode: "issue.critical",
    audience: "PROPERTY_MANAGER",
    preference: null,
    localTime: "14:00",
    pushAvailable: true,
    ...overrides,
  };
}

describe("NOTIFICATION_EVENTS — 14 イベントが定義されている", () => {
  it("14 件ある（§5.1 の 10 件 + P7 の 2 件 + P8 の 2 件）", () => {
    // **11 件目は §5.1 の表に無い**（DECISIONS #163 / OPEN_QUESTIONS #097）。
    // PK-SPEC-P7 §4.5 MUST が通知を要求しているのに、§5.1 が P7 を
    // 織り込んでいないため。仕様の版上げで §5.1 へ入れること。
    expect(NOTIFICATION_EVENTS).toHaveLength(14);
  });

  it("`packages/db` の語彙と 1 対 1 で対応する", () => {
    const defined = NOTIFICATION_EVENTS.map((event) => event.code).sort();
    expect(defined).toEqual([...NOTIFICATION_EVENT_CODES].sort());
  });

  it("既定チャネルが 1 つ以上ある", () => {
    for (const event of NOTIFICATION_EVENTS) {
      expect(event.defaultChannels.length, event.code).toBeGreaterThan(0);
    }
  });

  it("対象が 1 つ以上ある", () => {
    for (const event of NOTIFICATION_EVENTS) {
      expect(event.audience.length, event.code).toBeGreaterThan(0);
    }
  });

  it("**静音時間を無視するのは `issue.critical` だけ**（§5.3）", () => {
    const ignoring = NOTIFICATION_EVENTS.filter((event) => event.ignoresQuietHours);
    expect(ignoring.map((event) => event.code)).toEqual(["issue.critical"]);
  });

  it("**`INSPECTOR` はどのイベントの対象でもない**（§5.1 の表に無い）", () => {
    for (const event of NOTIFICATION_EVENTS) {
      expect(event.audience, event.code).not.toContain("INSPECTOR");
    }
  });

  it("知らないコードは `undefined`", () => {
    expect(findNotificationEvent("task.completed")).toBeUndefined();
  });
});

describe("canReceive — `CLEANER` の境界（§5.1 MUST / security.md §1）", () => {
  it("`task.rework_assigned` は受け取る", () => {
    expect(canReceive("CLEANER", "task.rework_assigned")).toBe(true);
  });

  it("**それ以外は 1 つも受け取らない**", () => {
    const others = NOTIFICATION_EVENT_CODES.filter((code) => code !== CLEANER_ALLOWED_EVENT);
    expect(others).toHaveLength(13);
    for (const code of others) {
      expect(canReceive("CLEANER", code), code).toBe(false);
    }
  });

  it("`resolveChannels()` でも 1 つも通らない", () => {
    const others = NOTIFICATION_EVENT_CODES.filter((code) => code !== CLEANER_ALLOWED_EVENT);
    for (const code of others) {
      expect(
        resolveChannels(resolution({ eventCode: code, audience: "CLEANER" })),
        code,
      ).toEqual([]);
    }
  });

  it("**設定でチャネルを足しても通らない**（表を上書きできない）", () => {
    expect(
      resolveChannels(
        resolution({
          eventCode: "finding.high",
          audience: "CLEANER",
          preference: { channels: ["EMAIL", "PUSH"], quietHoursFrom: null, quietHoursTo: null },
        }),
      ),
    ).toEqual([]);
  });

  it("清掃スタッフ向けの唯一のイベントは `IN_APP` 既定（外へ送らない）", () => {
    const channels = resolveChannels(
      resolution({ eventCode: "task.rework_assigned", audience: "CLEANER" }),
    );
    expect(channels).toEqual(["IN_APP"]);
    expect(outboundChannelsOf(channels)).toEqual([]);
  });
});

describe("canReceive — 表に無い相手へ送らない", () => {
  it("`VENDOR_ADMIN` は差異の通知を受け取らない", () => {
    expect(canReceive("VENDOR_ADMIN", "finding.high")).toBe(false);
  });

  it("`AUDITOR` は請求の通知を受け取らない", () => {
    expect(canReceive("AUDITOR", "invoice.sent")).toBe(false);
  });

  it("`PROPERTY_MANAGER` は連携の失敗を受け取らない（対象は `ORG_ADMIN`）", () => {
    expect(canReceive("PROPERTY_MANAGER", "integration.error")).toBe(false);
  });

  it("**`OWNER` は在留資格の通知を受け取らない**（INV-08 / P8-02）", () => {
    // 「オーナー・プラットフォーム運営に公開しない」。写真の保持期限
    // （`photo.retention_due`）は OWNER にも届くが、こちらは届かない。
    expect(canReceive("OWNER", "residency.expiry_due")).toBe(false);
    expect(canReceive("PROPERTY_MANAGER", "residency.expiry_due")).toBe(false);
    expect(canReceive("VENDOR_ADMIN", "residency.expiry_due")).toBe(false);
    expect(canReceive("ORG_ADMIN", "residency.expiry_due")).toBe(true);
  });

  it("**取引先はロールではない**（`period.review_requested`）", () => {
    expect(audienceOf("period.review_requested")).toEqual(["COUNTERPARTY"]);
    expect(canReceive("ORG_ADMIN", "period.review_requested")).toBe(false);
    expect(canReceive("COUNTERPARTY", "period.review_requested")).toBe(true);
  });

  it("知らないコードは誰も受け取らない", () => {
    expect(canReceive("OWNER", "task.completed")).toBe(false);
    expect(resolveChannels(resolution({ eventCode: "task.completed", audience: "OWNER" }))).toEqual(
      [],
    );
  });
});

describe("parseClock", () => {
  it("`00:00` は 0 分", () => {
    expect(parseClock("00:00")).toBe(0);
  });

  it("`22:00` は 1320 分", () => {
    expect(parseClock("22:00")).toBe(22 * 60);
  });

  it("`23:59` は 1439 分", () => {
    expect(parseClock("23:59")).toBe(1439);
  });

  it.each(["24:00", "7:00", "22:60", "", "2200", "aa:bb"])("`%s` は読めない", (value) => {
    expect(parseClock(value)).toBeNull();
  });
});

describe("isQuietHours — 正例（静音時間）", () => {
  it("22:00 ちょうどは静音（`from` を含む）", () => {
    expect(isQuietHours("22:00")).toBe(true);
  });

  it("深夜 02:00 は静音（日をまたぐ）", () => {
    expect(isQuietHours("02:00")).toBe(true);
  });

  it("06:59 は静音", () => {
    expect(isQuietHours("06:59")).toBe(true);
  });

  it("またがない設定（09:00-17:00）も扱える", () => {
    expect(isQuietHours("12:00", "09:00", "17:00")).toBe(true);
  });

  it("**時刻が読めなければ静音扱い**（送らない側へ倒す）", () => {
    expect(isQuietHours("なんだこれ")).toBe(true);
  });

  it("**設定が壊れていたら既定で見る**（一日中送ってよいにしない）", () => {
    expect(isQuietHours("23:00", "こわれた", "だめ")).toBe(true);
    expect(isQuietHours("12:00", "こわれた", "だめ")).toBe(false);
  });
});

describe("isQuietHours — 負例（静音時間ではない）", () => {
  it("07:00 ちょうどは静音ではない（`to` を含まない）", () => {
    expect(isQuietHours("07:00")).toBe(false);
  });

  it("正午は静音ではない", () => {
    expect(isQuietHours("12:00")).toBe(false);
  });

  it("21:59 は静音ではない", () => {
    expect(isQuietHours("21:59")).toBe(false);
  });

  it("幅ゼロの設定は静音時間なし", () => {
    expect(isQuietHours("03:00", "22:00", "22:00")).toBe(false);
  });

  it("既定は 22:00-07:00", () => {
    expect(DEFAULT_QUIET_HOURS_FROM).toBe("22:00");
    expect(DEFAULT_QUIET_HOURS_TO).toBe("07:00");
  });
});

describe("resolveChannels — 静音時間（§5.3）", () => {
  it("静音時間は PUSH を落とす", () => {
    const channels = resolveChannels(
      resolution({ eventCode: "room.urgent", localTime: "23:30" }),
    );
    expect(channels).toEqual(["IN_APP"]);
  });

  it("**`issue.critical` は静音時間を無視する**（§5.3 の唯一の例外）", () => {
    const channels = resolveChannels(resolution({ localTime: "23:30" }));
    expect(channels).toEqual(["IN_APP", "PUSH", "EMAIL"]);
  });

  it("静音時間でも EMAIL は止めない（§5.3 は PUSH / LINE だけ）", () => {
    const channels = resolveChannels(
      resolution({ eventCode: "finding.high", audience: "OWNER", localTime: "03:00" }),
    );
    expect(channels).toEqual(["EMAIL"]);
  });

  it("**落とした PUSH を `IN_APP` へ振り替える**（知らせないのではない）", () => {
    const channels = resolveChannels(
      resolution({
        eventCode: "room.urgent",
        localTime: "23:30",
        preference: { channels: ["PUSH"], quietHoursFrom: null, quietHoursTo: null },
      }),
    );
    expect(channels).toEqual(["IN_APP"]);
  });

  it("利用者の静音時間が既定より広ければそれに従う", () => {
    const channels = resolveChannels(
      resolution({
        eventCode: "room.urgent",
        localTime: "20:00",
        preference: { channels: ["PUSH"], quietHoursFrom: "19:00", quietHoursTo: "08:00" },
      }),
    );
    expect(channels).toEqual(["IN_APP"]);
  });

  it("日中は PUSH がそのまま残る", () => {
    expect(
      resolveChannels(resolution({ eventCode: "room.urgent", localTime: "10:00" })),
    ).toEqual(["IN_APP", "PUSH"]);
  });
});

describe("resolveChannels — PUSH のフォールバック（§5.2）", () => {
  it("購読が無ければ `IN_APP` へ落とす", () => {
    expect(
      resolveChannels(
        resolution({ eventCode: "room.urgent", pushAvailable: false, localTime: "10:00" }),
      ),
    ).toEqual(["IN_APP"]);
  });

  it("`IN_APP` を 2 つ返さない", () => {
    const channels = resolveChannels(
      resolution({ pushAvailable: false, localTime: "10:00" }),
    );
    expect(channels).toEqual(["IN_APP", "EMAIL"]);
  });

  it("PUSH だけの設定でも `IN_APP` が残る（無音にならない）", () => {
    expect(
      resolveChannels(
        resolution({
          eventCode: "room.urgent",
          pushAvailable: false,
          localTime: "10:00",
          preference: { channels: ["PUSH"], quietHoursFrom: null, quietHoursTo: null },
        }),
      ),
    ).toEqual(["IN_APP"]);
  });
});

describe("resolveChannels — 利用者の設定（§2.5）", () => {
  it("設定が無ければ既定チャネル", () => {
    expect(
      resolveChannels(resolution({ eventCode: "invoice.sent", audience: "ORG_ADMIN" })),
    ).toEqual(["EMAIL"]);
  });

  it("**空配列の設定は「全部止める」**（`null` と区別する）", () => {
    expect(
      resolveChannels(
        resolution({
          eventCode: "invoice.sent",
          audience: "ORG_ADMIN",
          preference: { channels: [], quietHoursFrom: null, quietHoursTo: null },
        }),
      ),
    ).toEqual([]);
  });

  it("既定に無いチャネルを足せる", () => {
    expect(
      resolveChannels(
        resolution({
          eventCode: "invoice.sent",
          audience: "ORG_ADMIN",
          localTime: "10:00",
          preference: { channels: ["EMAIL", "LINE"], quietHoursFrom: null, quietHoursTo: null },
        }),
      ),
    ).toEqual(["EMAIL", "LINE"]);
  });

  it("重複を畳む", () => {
    expect(
      resolveChannels(
        resolution({
          eventCode: "invoice.sent",
          audience: "ORG_ADMIN",
          preference: {
            channels: ["EMAIL", "EMAIL"],
            quietHoursFrom: null,
            quietHoursTo: null,
          },
        }),
      ),
    ).toEqual(["EMAIL"]);
  });
});

describe("outboundChannelsOf", () => {
  it("**`IN_APP` は外へ送らない**（画面が出す）", () => {
    expect(outboundChannelsOf(["IN_APP", "PUSH", "EMAIL"])).toEqual(["PUSH", "EMAIL"]);
  });

  it("`IN_APP` だけなら空", () => {
    expect(outboundChannelsOf(["IN_APP"])).toEqual([]);
  });

  it("空なら空", () => {
    expect(outboundChannelsOf([])).toEqual([]);
  });
});

/** 語彙の型が `NotificationEventCode` であることを型として押さえる。 */
const _codes: readonly NotificationEventCode[] = NOTIFICATION_EVENT_CODES;
void _codes;
