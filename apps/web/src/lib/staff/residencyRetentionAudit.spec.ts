/**
 * 在留資格の削除の記録（`residencyRetentionAudit.ts`）。
 *
 * ここが守るのは 3 つ（P8-11 の完了条件）。
 *   1. **監査ログに在留資格の中身が入らない**（引数に存在しないこと）
 *   2. **消した相手が分からない**（`staffProfileId` を受け取らない）
 *   3. 操作者はバッチ（**人の ID を借りない** / DECISIONS #164）
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { RESIDENCY_DELETION_TARGET } from "./residencyRetentionAudit.js";

const SOURCE = readFileSync(join(import.meta.dirname, "residencyRetentionAudit.ts"), "utf8");

/** 注記を除いた本文。**コメントの語で検査を通さない。** */
const CODE = SOURCE.split("\n")
  .filter((line) => {
    const trimmed = line.trimStart();
    return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
  })
  .join("\n");

describe("在留資格の削除の記録", () => {
  it("対象は「保存期間の満了」1 件。**個人を指す ID を持たない**", () => {
    expect(RESIDENCY_DELETION_TARGET).toBe("residencyRetention");
    expect(CODE).not.toContain("targetId");
  });

  it("**在留資格の値を受け取る引数が無い**（型で守る）", () => {
    for (const forbidden of [
      "expiresOn",
      "statusType",
      "statusLabel",
      "displayName",
      "residencyId",
      "cardNumber",
      "resignedOn",
      // **消した相手が残らない。** 残ると監査ログが「誰が在留資格を
      // 持っていたか」の一覧になる（P8-11 の禁止事項）。
      "staffProfileId",
    ]) {
      expect(CODE, forbidden).not.toContain(forbidden);
    }
  });

  it("受け取るのは件数だけ", () => {
    expect(CODE).toContain("input: { deleted: number }");
    expect(CODE).toContain("after: { deleted: input.deleted }");
    // `before` は無い。消える前の値を監査ログへ写さない。
    expect(CODE).not.toContain("before");
  });

  it("操作者はバッチ（**人の ID を借りない**）", () => {
    expect(CODE).toContain("actorId: systemActorId(ctx.orgShortId)");
  });

  it("**畳まない**（走った回数がそのまま残る）", () => {
    // 閲覧と違い、削除は日次バッチで元々 1 日 1 件。畳むと 2 度目が残らない。
    expect(CODE).not.toContain("recordAuditDaily");
  });
});
