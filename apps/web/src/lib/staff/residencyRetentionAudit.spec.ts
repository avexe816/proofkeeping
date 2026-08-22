/**
 * 削除バッチが「走ったが 0 件だった」ことの記録（`residencyRetentionAudit.ts`）。
 *
 * **消えた回の記録はここを通らない**（hotfix 2026-08-22 / DECISIONS #268）。
 * あちらは `deleteResidencyRecords()` が DELETE と同じ `batch()` の中で書く。
 *
 * ここが守るのは 4 つ（P8-11 の完了条件）。
 *   1. **件数の引数を持たない**（非 0 の記録をここから作れない）
 *   2. 保存される値は必ず `{"deleted": 0}`
 *   3. **監査ログに在留資格の中身が入らない**（引数に存在しないこと）
 *   4. 操作者はバッチ（**人の ID を借りない** / DECISIONS #164）
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Env, TenantContext } from "@pk/db";
import { createFakeD1, createFakeEnv, TEST_ORG, type FakeD1 } from "@pk/db/test-support";
import { describe, expect, it } from "vitest";

import {
  recordEmptyResidencyRetentionRun,
  RESIDENCY_DELETION_TARGET,
} from "./residencyRetentionAudit.js";

const SOURCE = readFileSync(join(import.meta.dirname, "residencyRetentionAudit.ts"), "utf8");

/** 注記を除いた本文。**コメントの語で検査を通さない。** */
const CODE = SOURCE.split("\n")
  .filter((line) => {
    const trimmed = line.trimStart();
    return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
  })
  .join("\n");

const CTX: TenantContext = {
  organizationId: TEST_ORG.organizationId,
  orgShortId: TEST_ORG.orgShortId,
  role: "ORG_ADMIN",
  allowedPropertyIds: [],
  now: new Date("2026-08-19T22:00:00.000Z"),
};

function envOf(fake: FakeD1): Env {
  return createFakeEnv(fake);
}

describe("0 件の回の記録", () => {
  it("対象は「保存期間の満了」1 件。**個人を指す ID を持たない**", () => {
    expect(RESIDENCY_DELETION_TARGET).toBe("residencyRetention");
    expect(CODE).not.toContain("targetId");
  });

  it("**件数の引数を持たない**（非 0 の記録をここから作れない）", () => {
    // 引数は `env` と `ctx` の 2 つだけ。**`deleted` を受け取る口が無い。**
    expect(CODE).toContain("recordEmptyResidencyRetentionRun(\n  env: Env,\n  ctx: TenantContext,\n)");
    expect(CODE).not.toContain("deleted: number");
    expect(CODE).not.toContain("input.deleted");
    expect(recordEmptyResidencyRetentionRun).toHaveLength(2);
  });

  it("**書く値は `{ deleted: 0 }` に固定**（リテラル）", () => {
    expect(CODE).toContain("after: { deleted: 0 }");
    // `before` は無い。消える前の値を監査ログへ写さない。
    expect(CODE).not.toContain("before");
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
      // 消した相手が残ると、監査ログが「誰が在留資格を持っていたか」の
      // 一覧になる（P8-11 の禁止事項）。
      "staffProfileId",
    ]) {
      expect(CODE, forbidden).not.toContain(forbidden);
    }
  });

  it("**対象種別は 1 か所で決める**（`@pk/db` から取る）", () => {
    // 同じ文字列を 2 か所に書くと、片方だけ直したときに監査ログが割れる。
    expect(CODE).toContain("RESIDENCY_DELETION_TARGET");
    expect(CODE).not.toContain('= "residencyRetention"');
  });

  it("**畳まない**（走った回数がそのまま残る）", () => {
    expect(CODE).not.toContain("recordAuditDaily");
  });

  it("実際に書かれるのは `{\"deleted\":0}` と system actor だけ", async () => {
    const fake = createFakeD1();

    await recordEmptyResidencyRetentionRun(envOf(fake), CTX);

    const [insert] = fake.queries;
    expect(insert?.sql.startsWith("insert into")).toBe(true);
    expect(insert?.params).toContain("residency.deleted");
    expect(insert?.params).toContain(RESIDENCY_DELETION_TARGET);
    expect(insert?.params).toContain('{"deleted":0}');
    expect(insert?.params).toContain(`${TEST_ORG.orgShortId}__sys_00000000000000000000000000`);
    // **非 0 の件数はどこにも現れない。**
    expect(JSON.stringify(insert?.params)).not.toContain('"deleted":1');
  });
});
