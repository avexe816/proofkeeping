/**
 * 日報コンシューマのテスト（PK-SPEC-P2 §9）。
 *
 * task:  docs/tasks/P2-14.md
 * ルール: .claude/rules/testing.md §4（冪等: 3 回実行しても結果が変わらない）
 *
 * ── 何をテストしているか ────────────────────────────────
 * `generateDailyReport()` を丸ごと動かすには、D1 の代役へ
 * 「日報 → 施設 → タスク → 客室 → スタッフ → 忘れ物 → 検査 → 差戻し →
 * 不具合」の行を**実行順どおりに積む**ことになる。順序に依存したテストは
 * 実装の読み取り順を変えただけで壊れ、**壊れたことが「壊れた」を
 * 意味しない**（`evidenceExport.spec.ts` と同じ判断）。
 *
 * そこで冪等性は**結果が決まる 4 か所**で押さえる。
 *   ① R2 のキー … 施設・業務日・文書番号・版から決まる
 *   ② 版 … 「最新版 + 1」。最新版が無ければ 1
 *   ③ メッセージの検証 … 壊れたメッセージを ack して落とす
 *   ④ payload … 同じ入力・同じ `requestedAtMs` から同じハッシュ
 * ①②が揃えば「自動生成を 3 回処理しても R2 と DB の状態が同じ」が
 * 成り立つ（自動生成は既存の日報があれば何もしない）。
 */

import { buildDailyReportPayload, canonicalJson, dailyReportPayloadToCanonical } from "@pk/engine";
import { describe, expect, it } from "vitest";

import {
  dailyReportFileName,
  dailyReportKey,
  isOwnDailyReportKey,
  nextRevision,
  DAILY_REPORT_PREFIX,
} from "../lib/report/dailyReportKey.js";
import { bytesToBase64 } from "../lib/report/font.js";

import { isDailyReportMessage, type DailyReportMessage } from "./dailyReport.js";

const MESSAGE: DailyReportMessage = {
  kind: "DAILY_REPORT",
  organizationId: "org_test_alpha",
  orgShortId: "a1b2c3",
  propertyId: "a1b2c3__prop_01JBXQ3ZK8N4P2VYR6",
  businessDate: "2026-09-10",
  mode: "AUTO",
  requestedById: null,
  requestedAtMs: Date.UTC(2026, 8, 10, 20, 10, 0),
};

const KEY_INPUT = {
  organizationId: MESSAGE.organizationId,
  propertyId: MESSAGE.propertyId,
  businessDate: MESSAGE.businessDate,
  documentNo: "RPT-2026-0042",
  revision: 1,
};

describe("dailyReportKey", () => {
  it("§9.5 の形（年月は業務日から取る）", () => {
    expect(dailyReportKey(KEY_INPUT)).toBe(
      `${DAILY_REPORT_PREFIX}${MESSAGE.organizationId}/${MESSAGE.propertyId}` +
        `/daily-reports/2026/09/RPT-2026-0042-r1.pdf`,
    );
  });

  it("同じ版は何度呼んでも同じキー（＝上書き / 冪等）", () => {
    const keys = [1, 2, 3].map(() => dailyReportKey(KEY_INPUT));
    expect(new Set(keys).size).toBe(1);
  });

  it("版が違えばキーも違う（旧版を上書きしない / §9.3）", () => {
    expect(dailyReportKey(KEY_INPUT)).not.toBe(
      dailyReportKey({ ...KEY_INPUT, revision: 2 }),
    );
  });

  it("組織が違えばキーも違う", () => {
    expect(dailyReportKey(KEY_INPUT)).not.toBe(
      dailyReportKey({ ...KEY_INPUT, organizationId: "org_other" }),
    );
  });

  it("シャード番号を含まない（architecture.md §1）", () => {
    expect(dailyReportKey(KEY_INPUT)).not.toMatch(/shard/i);
  });

  it("受け取る側のファイル名に版が入る", () => {
    expect(dailyReportFileName("RPT-2026-0042", 2)).toBe("RPT-2026-0042-r2.pdf");
  });

  it.each([
    ["自組織のキー", `${DAILY_REPORT_PREFIX}org_test_alpha/x/y.pdf`, true],
    ["別組織のキー", `${DAILY_REPORT_PREFIX}org_other/x/y.pdf`, false],
    ["組織名の前方一致だけでは通さない", `${DAILY_REPORT_PREFIX}org_test_alpha2/x.pdf`, false],
    ["接頭辞が違う", `seals/org_test_alpha/x.pdf`, false],
    ["フォントは対象外", `fonts/pk-jp-regular.ttf`, false],
  ])("%s", (_label, key, expected) => {
    expect(isOwnDailyReportKey(key, "org_test_alpha")).toBe(expected);
  });
});

describe("版（§9.3）", () => {
  it.each([
    ["最新版が無ければ 1", undefined, 1],
    ["1 の次は 2", 1, 2],
    ["2 の次は 3", 2, 3],
    ["9 の次は 10", 9, 10],
    ["欠番を作らない", 42, 43],
  ])("%s", (_label, latest, expected) => {
    expect(nextRevision(latest)).toBe(expected);
  });
});

describe("isDailyReportMessage", () => {
  it("正しいメッセージを通す", () => {
    expect(isDailyReportMessage(MESSAGE)).toBe(true);
  });

  it("手動生成（requestedById あり）も通す", () => {
    expect(
      isDailyReportMessage({ ...MESSAGE, mode: "MANUAL", requestedById: "a1b2c3__mem_x" }),
    ).toBe(true);
  });

  it.each([
    ["null", null],
    ["文字列", "DAILY_REPORT"],
    ["kind 違い", { ...MESSAGE, kind: "EVIDENCE_ZIP" }],
    ["mode 違い", { ...MESSAGE, mode: "SCHEDULED" }],
    ["businessDate が無い", { ...MESSAGE, businessDate: undefined }],
    ["requestedAtMs が文字列", { ...MESSAGE, requestedAtMs: "0" }],
    ["requestedById が数値", { ...MESSAGE, requestedById: 1 }],
    ["orgShortId が無い", { ...MESSAGE, orgShortId: undefined }],
  ])("%s は通さない", (_label, value) => {
    expect(isDailyReportMessage(value)).toBe(false);
  });
});

describe("冪等: 同じメッセージから同じ payload ができる", () => {
  function payloadFor(revision: number) {
    return buildDailyReportPayload({
      documentNo: "RPT-2026-0042",
      revision,
      businessDate: MESSAGE.businessDate,
      // **メッセージが持つ時刻を使う。** `new Date()` にすると再送で変わる。
      generatedAtMs: MESSAGE.requestedAtMs,
      property: { code: "HTLA", name: "テスト施設", timezone: "Asia/Tokyo" },
      tasks: [
        {
          taskId: "t1",
          roomNumber: "302",
          taskType: "CHECKOUT",
          status: "COMPLETED",
          assigneeName: "田中",
          startedAtMs: Date.UTC(2026, 8, 10, 4, 30, 0),
          completedAtMs: Date.UTC(2026, 8, 10, 5, 2, 0),
          actualMinutes: 32,
          blockedReason: null,
        },
      ],
      inspections: [],
      reworks: [],
      findings: [],
    });
  }

  it("3 回組んでも同じ正規化 JSON（＝同じ payloadSha256）", () => {
    const hashes = [1, 2, 3].map(() =>
      canonicalJson(dailyReportPayloadToCanonical(payloadFor(1))),
    );
    expect(new Set(hashes).size).toBe(1);
  });

  it("版が変われば payload も変わる（別の文書になる）", () => {
    expect(canonicalJson(dailyReportPayloadToCanonical(payloadFor(1)))).not.toBe(
      canonicalJson(dailyReportPayloadToCanonical(payloadFor(2))),
    );
  });
});

describe("フォントの base64", () => {
  it("空でも落ちない", () => {
    expect(bytesToBase64(new Uint8Array())).toBe("");
  });

  it("既知の値", () => {
    expect(bytesToBase64(new TextEncoder().encode("hello"))).toBe("aGVsbG8=");
  });

  it("塊の境界（0x8000 超）でも壊れない", () => {
    const bytes = new Uint8Array(0x8000 + 17).fill(65);
    expect(bytesToBase64(bytes)).toBe(btoa("A".repeat(0x8000 + 17)));
  });
});
