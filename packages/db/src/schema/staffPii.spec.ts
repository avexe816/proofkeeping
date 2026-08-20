/**
 * 従業員の個人情報のうち、**持たないと決めたもの**が列に無いこと
 * （PK-SPEC-P8 §1.3 MUST / docs/PK-SPEC-PAY.md §1.1 MUST / security.md §3）。
 *
 * task: docs/tasks/P8-01.md
 *
 * ── 宿泊者側（guestPii.spec.ts）との違い ────────────────
 * あちらは「宿泊者の情報を**一切**持たない」。こちらは違う。
 * **従業員の情報は持つ**（表示名・スタッフ番号・言語・在籍年数は
 * 業務に要る）。持たないと決めたのは**本籍・住所・生年月日・
 * マイナンバー・口座情報**の 5 つで、ここが見るのはその 5 つだけ。
 *
 * ── なぜ列名で見るのか ──────────────────────────────────
 * 「保存していない」はデータを見ないと言えないが、**列が無ければ
 * 保存しようがない。** 台帳に列を足す task がここに引っ掛かる形にして、
 * 引っ掛かったら「従業員のものではない」と `ALLOWED` へ理由付きで
 * 足させる。**理由を書かずに語彙から消さないこと。**
 *
 * ── 生年月日・国籍は guestPii 側が既に見ている ───────────
 * `birth` / `nationality` は `GUEST_PII_MARKERS` に入っており、
 * **宿泊者・従業員のどちらであっても落ちる。** ここで重ねない。
 */

import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import * as schema from "./index.js";

/**
 * 従業員について持たないと決めた属性の列名の断片。**小文字で部分一致。**
 *
 * 住所・本籍・マイナンバー・口座・給与の控除。
 */
const STAFF_PII_MARKERS = [
  "address",
  "postal",
  "zip",
  "prefecture",
  "domicile",
  "my_number",
  "mynumber",
  "individual_number",
  "bank_",
  "account_number",
  "accountnumber",
  "branch_code",
  "insurance",
  "withholding",
  "deduction",
] as const;

/**
 * 語彙に当たるが従業員の個人情報ではない列と、**その理由。**
 *
 * ここへ足すときは、**その列が誰の何なのか**を一文で書くこと。
 */
const ALLOWED: Readonly<Record<string, string>> = {
  // 事業者・施設・取引先の**所在地**。従業員の住所ではない。
  // 適格請求書の 6 要件（billing.md §1）と施設マスタに要る。
  "organizationTaxProfile.postal_code": "発行事業者の所在地。適格請求書の要件（billing.md §1）",
  "organizationTaxProfile.address": "発行事業者の所在地。適格請求書の要件（同上）",
  "property.postal_code": "施設の郵便番号。清掃現場の場所であって個人の住所ではない",
  "property.address": "施設の所在地。清掃現場の場所であって個人の住所ではない",
  "counterparty.postal_code": "取引先（法人）の郵便番号。請求書の送付先",
  "counterparty.address1": "取引先（法人）の所在地。請求書の送付先",
  "counterparty.address2": "取引先（法人）の所在地の 2 行目。請求書の送付先",
};

interface Column {
  table: string;
  column: string;
}

function allColumns(): Column[] {
  const out: Column[] = [];
  for (const [name, value] of Object.entries(schema)) {
    if (typeof value !== "object" || Array.isArray(value)) continue;
    let config;
    try {
      config = getTableConfig(value as Parameters<typeof getTableConfig>[0]);
    } catch {
      continue;
    }
    for (const column of config.columns) out.push({ table: name, column: column.name });
  }
  return out;
}

describe("従業員の個人情報のうち持たないと決めたもの", () => {
  const columns = allColumns();

  it("表を走査できている（**空振りしていない**）", () => {
    expect(columns.length).toBeGreaterThan(300);
  });

  it.each(STAFF_PII_MARKERS)("`%s` を含む列が 1 つも無い", (marker) => {
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

  it("**例外は所在地の 7 つだけ**（増えたら §1.3 MUST に照らすこと）", () => {
    // 事業者・施設・取引先の所在地。**個人の住所の例外は 1 つも無い。**
    expect(Object.keys(ALLOWED)).toHaveLength(7);
    for (const key of Object.keys(ALLOWED)) {
      expect(key.startsWith("staffPayProfile.") || key.startsWith("residencyRecord.")).toBe(false);
    }
  });

  it("台帳（`staff_pay_profile`）が持つ列は業務に要るものだけ", () => {
    const config = getTableConfig(schema.staffPayProfile);
    const names = config.columns.map((column) => column.name).sort();
    // **並びを固定して、足された列がここで見えるようにする。**
    expect(names).toEqual([
      "created_at",
      "employment_type",
      "hired_on",
      "id",
      "invoice_registration_no",
      "is_active",
      "languages",
      "membership_id",
      "note",
      "organization_id",
      "resigned_on",
      "skills",
      "updated_at",
      "work_status",
    ]);
  });

  it("在留資格（`residency_record`）が番号を持たない", () => {
    const config = getTableConfig(schema.residencyRecord);
    const names = config.columns.map((column) => column.name);
    // 在留カード番号・パスポート番号を入れられる列を作らない
    // （期限の管理に要るのは種別と日付だけ / security.md §3）。
    for (const forbidden of ["number", "card", "passport", "residence_no"]) {
      expect(
        names.filter((name) => name.includes(forbidden)),
        forbidden,
      ).toEqual([]);
    }
  });
});
