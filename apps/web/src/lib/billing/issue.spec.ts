/**
 * 請求書の発行（P5-07 / PK-SPEC-P5 §4.1）。
 *
 * ルール: .claude/rules/billing.md §5・§6・§7 / testing.md §4
 *
 * ── 見ているもの ────────────────────────────────────────
 *   支払期限が**発行日から**の日数であること（締め日からではない）
 *   宛先が**スナップショットから**取られること（マスタを引き直さない）
 *   宛先が読めないときに黙って成功しないこと
 *
 * DB を伴う経路（`issueInvoice()` の ①〜⑦）は
 * `routes/api/v1/invoices.spec.ts` が代役 D1 越しに見る。
 */

import { describe, expect, it } from "vitest";

import { readDeliveryAddress } from "./deliver.js";
import { dueDateOf } from "./issue.js";

describe("dueDateOf", () => {
  it("発行日から支払サイトの日数を足す", () => {
    expect(dueDateOf("2026-10-01", 30)).toBe("2026-10-31");
  });

  it("月をまたぐ", () => {
    expect(dueDateOf("2026-10-15", 30)).toBe("2026-11-14");
  });

  it("年をまたぐ", () => {
    expect(dueDateOf("2026-12-20", 30)).toBe("2027-01-19");
  });

  it("閏年の 2 月を越える", () => {
    expect(dueDateOf("2028-02-20", 10)).toBe("2028-03-01");
  });

  it("0 日なら当日", () => {
    expect(dueDateOf("2026-10-01", 0)).toBe("2026-10-01");
  });

  it("同じ入力なら同じ結果（冪等）", () => {
    expect(dueDateOf("2026-10-01", 30)).toBe(dueDateOf("2026-10-01", 30));
  });
});

describe("readDeliveryAddress", () => {
  it("スナップショットから請求先と CC を読む", () => {
    expect(
      readDeliveryAddress({
        billingEmail: "keiri@example.co.jp",
        ccEmails: ["manager@example.co.jp"],
      }),
    ).toEqual({ toEmail: "keiri@example.co.jp", ccEmails: ["manager@example.co.jp"] });
  });

  it("CC が無くても読める", () => {
    expect(readDeliveryAddress({ billingEmail: "keiri@example.co.jp" })).toEqual({
      toEmail: "keiri@example.co.jp",
      ccEmails: [],
    });
  });

  it("CC の中の文字列でない要素を落とす", () => {
    const address = readDeliveryAddress({
      billingEmail: "keiri@example.co.jp",
      ccEmails: ["a@example.co.jp", 42, null],
    });
    expect(address?.ccEmails).toEqual(["a@example.co.jp"]);
  });

  // ── 負例。**黙って成功にしない。** ───────────────────────
  it("請求先が無ければ `null`", () => {
    expect(readDeliveryAddress({})).toBeNull();
  });

  it("請求先が空文字なら `null`", () => {
    expect(readDeliveryAddress({ billingEmail: "" })).toBeNull();
  });

  it("請求先が文字列でなければ `null`", () => {
    expect(readDeliveryAddress({ billingEmail: 42 })).toBeNull();
  });

  it("CC が配列でなければ空にする（宛先そのものは生かす）", () => {
    expect(readDeliveryAddress({ billingEmail: "a@example.co.jp", ccEmails: "b@example.co.jp" })).toEqual(
      { toEmail: "a@example.co.jp", ccEmails: [] },
    );
  });
});
