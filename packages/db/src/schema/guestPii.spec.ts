/**
 * 宿泊者の個人情報が全テーブルに存在しないこと
 * （PK-SPEC-P7 §6.2 MUST / security.md §3 / P7-13）。
 *
 * task: docs/tasks/P7-13.md
 *
 * ── なぜ packages/db の中に居るのか ──────────────────────
 *  は  の依存で、ルートからは解決できない。
 *  と同じ場所に置く。
 *
 * ── §6.2 MUST ──────────────────────────────────────────
 * 「ProofKeeping は宿泊者の氏名・連絡先・パスポート情報を一切保存しない。
 * **この方針を GA 時点で改めて全テーブルについて検証する。**」
 *
 * ── 列名の語彙で見る ────────────────────────────────────
 * 「保存していないこと」は本来データを見ないと言えないが、**列が無ければ
 * 保存しようがない。** schema を走査して、宿泊者の属性を入れられる名前の
 * 列が 1 つも無いことを確かめる。
 *
 * ── 既定は「疑わしい名前を落とす」側 ────────────────────
 * 語彙に載っていない名前は通る（`archivePolicy.ts` とは逆向き）。
 * ここは**列を足す側が語彙に引っ掛かる**設計で、引っ掛かったときに
 * 「宿泊者のものではない」と示すには `ALLOWED` へ理由付きで足す。
 * **理由を書かずに語彙から消さないこと。**
 */

import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import * as schema from "./index.js";

/**
 * 宿泊者の属性を入れられる列名の断片（security.md §3）。
 *
 * 氏名・連絡先・住所・パスポート・カード。**小文字で部分一致。**
 */
const GUEST_PII_MARKERS = [
  "guest",
  "passport",
  "credit",
  "card_number",
  "cardnumber",
  "firstname",
  "lastname",
  "fullname",
  "given_name",
  "family_name",
  "birth",
  "nationality",
] as const;

/**
 * 語彙に当たるが宿泊者の個人情報ではない列と、**その理由。**
 *
 * ここへ足すときは、**その列が誰の何なのか**を一文で書くこと。
 * 「たぶん大丈夫」で消さない。§6.2 MUST は GA 時点での再検証を求めている。
 */
const ALLOWED: Readonly<Record<string, string>> = {
  // security.md §3:「稼働照合には**人数**と予約参照番号のみで足りる」。
  // 人数は個人を特定しない。氏名・連絡先とは別物。
  "dailyRoomPlan.guest_count": "宿泊人数。個人を特定しない（security.md §3 が明示的に許す）",
  "occupancySnapshot.guest_count": "宿泊人数。個人を特定しない（同上）",
  "consumptionBaseline.guest_count": "宿泊人数。消耗量の基準に使う（同上）",
  "baselineExclusionLog.guest_count": "宿泊人数。除外の理由に残す（同上）",
  // 赤伝（billing.md §2「訂正は赤伝（マイナス伝票）＋再発行」）。
  // クレジットカードとは無関係。
  "invoice.credit_note_for_id": "赤伝が訂正する元の請求書 ID（billing.md §2）",
  "invoice.is_credit_note": "赤伝かどうか（billing.md §2）",
};

interface Column {
  table: string;
  column: string;
}

function allColumns(): Column[] {
  const out: Column[] = [];
  for (const [name, value] of Object.entries(schema)) {
    // 語彙の配列（`SUBSCRIPTION_PLANS` など）を飛ばす。
    // **`value === null` は書かない。** schema の export に null は無く、
    // 型の上で到達しない条件を書くと lint が落ちる。
    if (typeof value !== "object" || Array.isArray(value)) continue;
    let config;
    try {
      config = getTableConfig(value as Parameters<typeof getTableConfig>[0]);
    } catch {
      // 表ではないエクスポート（語彙の配列など）は飛ばす。
      continue;
    }
    for (const column of config.columns) out.push({ table: name, column: column.name });
  }
  return out;
}

describe("§6.2 MUST 宿泊者の個人情報を保存しない", () => {
  const columns = allColumns();

  it("表を走査できている（**空振りしていない**）", () => {
    // ここが 0 になると、下のテストが素通りする。
    expect(columns.length).toBeGreaterThan(300);
  });

  it.each(GUEST_PII_MARKERS)("`%s` を含む列が 1 つも無い", (marker) => {
    const hits = columns
      .filter(({ column }) => column.toLowerCase().includes(marker))
      .filter(({ table, column }) => ALLOWED[`${table}.${column}`] === undefined)
      .map(({ table, column }) => `${table}.${column}`);

    expect(hits).toEqual([]);
  });

  it("**例外に理由が書いてある**（理由の無い例外を作らせない）", () => {
    for (const [key, reason] of Object.entries(ALLOWED)) {
      expect(reason.length, key).toBeGreaterThan(10);
    }
  });

  it("**例外が増えていない**（増えたら §6.2 MUST に照らすこと）", () => {
    // 人数（個人を特定しない）と赤伝（カードと無関係）の 6 つだけ。
    // **氏名・連絡先・住所・パスポート・カード番号の例外は 1 つも無い。**
    expect(Object.keys(ALLOWED).sort()).toEqual([
      "baselineExclusionLog.guest_count",
      "consumptionBaseline.guest_count",
      "dailyRoomPlan.guest_count",
      "invoice.credit_note_for_id",
      "invoice.is_credit_note",
      "occupancySnapshot.guest_count",
    ]);
  });

  it("**例外はすべて「人数」か「赤伝」**（氏名・連絡先の例外を作らせない）", () => {
    for (const [key, reason] of Object.entries(ALLOWED)) {
      const benign = reason.includes("人数") || reason.includes("赤伝");
      expect(benign, `${key}: ${reason}`).toBe(true);
    }
  });

  it("忘れ物にも所有者の連絡先を持たない（security.md §3）", () => {
    // 「忘れ物の所有者情報も保存しない。連絡は PMS 側で行い、
    // `ownerContactedAt` のみ記録。」
    const lostItem = columns.filter(({ table }) => table === "lostItem").map((c) => c.column);
    expect(lostItem).toContain("owner_contacted_at");
    for (const column of lostItem) {
      expect(column, `lostItem.${column}`).not.toMatch(/owner_(name|email|phone|tel|address)/);
    }
  });

  it("写真に EXIF GPS を持たない（security.md §4 / INV-11）", () => {
    for (const { table, column } of columns) {
      expect(column.toLowerCase(), `${table}.${column}`).not.toMatch(
        /latitude|longitude|(^|_)gps(_|$)|geo_/,
      );
    }
  });
});
