/**
 * 在留資格の閲覧の記録（`residencyAudit.ts`）。
 *
 * ここが守るのは 2 つ。
 *   1. **監査ログに在留資格の中身が入らない**（引数に存在しないこと）
 *   2. **1 日 1 件に畳む**（`recordAuditDaily()` を使うこと）
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { RESIDENCY_VIEW_TARGET } from "./residencyAudit.js";

const SOURCE = readFileSync(join(import.meta.dirname, "residencyAudit.ts"), "utf8");

/** 注記を除いた本文。**コメントの語で検査を通さない。** */
const CODE = SOURCE.split("\n")
  .filter((line) => {
    const trimmed = line.trimStart();
    return (
      !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*")
    );
  })
  .join("\n");

describe("在留資格の閲覧の記録", () => {
  it("対象は「一覧」1 件。**個人を指す ID を持たない**", () => {
    expect(RESIDENCY_VIEW_TARGET).toBe("residencyList");
    expect(CODE).not.toContain("targetId");
  });

  it("**1 日 1 件に畳む**（`recordAudit()` を直に呼ばない）", () => {
    expect(CODE).toContain("recordAuditDaily(");
    // 畳まない口を使うと、画面を開くたびに 1 行増える。
    expect(CODE).not.toMatch(/\brecordAudit\(/);
  });

  it("**在留資格の値を受け取る引数が無い**（型で守る）", () => {
    for (const forbidden of [
      "expiresOn",
      "statusType",
      "statusLabel",
      "displayName",
      "residencyId",
      "cardNumber",
      "before",
      "after",
    ]) {
      expect(CODE, forbidden).not.toContain(forbidden);
    }
  });

  it("受け取るのは操作者と業務日だけ", () => {
    expect(CODE).toContain("input: { actorId: string; businessDate: string }");
  });
});
