/**
 * 監査ログの書き込み（P0-11）。
 *
 * ルール: .claude/rules/security.md §6
 * 契約:  docs/PK-IMPL-CONTRACT.md §2.9（INV-30: 削除できない実装とする）
 *
 * 組織条件の強制注入と越境 ID は `repositories.spec.ts` が全関数について
 * 見ている。ここは `recordAudit()` 固有の約束だけを見る。
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { generateId } from "../id.js";
import { getTenantDb } from "../router.js";
import { MASKED } from "../mask.js";
import {
  createFakeD1,
  createFakeEnv,
  TEST_NOW,
  TEST_ORG,
  tenantContext,
} from "../test-support/fake-d1.js";

import {
  AUDIT_ACTIONS,
  recordAudit,
  RESIDENCY_DELETION_TARGET,
  residencyDeletionAuditStatement,
} from "./audit.js";

const ACTOR = generateId(TEST_ORG.orgShortId, "mem");
const TARGET = generateId(TEST_ORG.orgShortId, "room");

/** 実在の認証情報から作った値ではない。形だけを再現している。 */
const HASH = "pbkdf2$sha256$5000$c2FsdA$aGFzaA";

describe("recordAudit", () => {
  it("INSERT を 1 件だけ発行する", async () => {
    const fake = createFakeD1();
    await recordAudit(createFakeEnv(fake), tenantContext(), {
      actorId: ACTOR,
      action: "property.created",
      targetType: "property",
    });

    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0]?.sql.startsWith("insert into \"audit_log\"")).toBe(true);
  });

  it("actorRole は ctx.role、at は ctx.now から入る", async () => {
    // リクエストの値を監査ログへ持ち込まない（PK-SPEC-P0 §19.5）。
    const fake = createFakeD1();
    await recordAudit(createFakeEnv(fake), tenantContext({ role: "PROPERTY_MANAGER" }), {
      actorId: ACTOR,
      action: "property.updated",
      targetType: "property",
    });

    const params = fake.queries[0]?.params ?? [];
    expect(params).toContain("PROPERTY_MANAGER");
    expect(params).toContain(TEST_NOW.getTime());
  });

  it("id は自組織の orgShortId と audit 接頭辞を持つ", async () => {
    const fake = createFakeD1();
    await recordAudit(createFakeEnv(fake), tenantContext(), {
      actorId: ACTOR,
      action: "export.data",
      targetType: "organization",
    });

    const id = fake.queries[0]?.params[0];
    expect(typeof id === "string" && id.startsWith(`${TEST_ORG.orgShortId}__audit_`)).toBe(true);
  });

  it("before / after のパスワードハッシュがマスクされる", async () => {
    // `user` の行をそのまま渡してよい形にしてある（security.md §6）。
    const fake = createFakeD1();
    await recordAudit(createFakeEnv(fake), tenantContext(), {
      actorId: ACTOR,
      action: "user.pinReset",
      targetType: "user",
      targetId: TARGET,
      before: { staffNumber: "S-0001", pinHash: HASH },
      after: { staffNumber: "S-0001", pinHash: HASH },
    });

    const serialized = JSON.stringify(fake.queries[0]?.params ?? []);
    expect(serialized).not.toContain("pbkdf2");
    expect(serialized).toContain(MASKED);
  });

  it("理由必須の操作は reason が無ければ落ちる", async () => {
    const fake = createFakeD1();
    await expect(
      recordAudit(createFakeEnv(fake), tenantContext(), {
        actorId: ACTOR,
        action: "room.statusOverridden",
        targetType: "room",
        targetId: TARGET,
      }),
    ).rejects.toThrow("AUDIT_REASON_REQUIRED");
    // 落ちたときに半端な行を書かない。
    expect(fake.queries).toEqual([]);
  });

  it("空白だけの reason も理由とみなさない", async () => {
    const fake = createFakeD1();
    await expect(
      recordAudit(createFakeEnv(fake), tenantContext(), {
        actorId: ACTOR,
        action: "observation.amended",
        targetType: "observation",
        reason: "   ",
      }),
    ).rejects.toThrow("AUDIT_REASON_REQUIRED");
  });

  it("理由必須の操作も reason があれば書ける", async () => {
    const fake = createFakeD1();
    await recordAudit(createFakeEnv(fake), tenantContext(), {
      actorId: ACTOR,
      action: "room.statusOverridden",
      targetType: "room",
      targetId: TARGET,
      reason: "客室清掃の順序を現場判断で入れ替えたため",
    });
    expect(fake.queries).toHaveLength(1);
  });

  it("理由不要の操作は reason 無しで書ける", async () => {
    const fake = createFakeD1();
    await recordAudit(createFakeEnv(fake), tenantContext(), {
      actorId: ACTOR,
      action: "auth.loginFailed",
      targetType: "user",
    });
    expect(fake.queries).toHaveLength(1);
  });
});

describe("AUDIT_ACTIONS", () => {
  it("理由必須の操作が宣言どおり", () => {
    // security.md §6 の 2 操作（客室ステータスの手動上書き・観察記録の事後修正）に
    // 加え、PK-SPEC-P1 §5.3 が理由を必須とする入室不可（P1-05）。
    // P2-04 が 1 つ足した: 清掃担当者本人による検査（PK-SPEC-P2 §4.2 の例外）。
    // security.md §1 が「緊急時の例外は理由必須＋監査ログ」と書いている。
    // P2-07 が 1 つ足した: 差戻しの免除（同 §4.7 が「理由必須」と明記）。
    // P2-16 が 1 つ足した: 残存タスクの緊急上書き（同 §13.3）。
    // P5-09 が 1 つ足した: 帳票の訂正（PK-SPEC-P5 §5.2 の 2 が
    // 「訂正理由を入力（必須）」と明記）。
    const required = Object.entries(AUDIT_ACTIONS)
      .filter(([, meta]) => meta.requiresReason)
      .map(([action]) => action);
    expect(required.sort()).toEqual([
      "document.corrected",
      "inspection.emergencyOverride",
      "inspection.selfApproved",
      "observation.amended",
      "rework.waived",
      "room.statusOverridden",
      "task.blocked",
    ]);
  });

  it("action は `対象.操作` の形で揃っている", () => {
    // 5 年残る永続データ。表記が割れると行動ごとに数えられなくなる。
    for (const action of Object.keys(AUDIT_ACTIONS)) {
      expect(action, action).toMatch(/^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$/);
    }
  });

  it("ログイン成功の action を持たない", () => {
    // security.md §6 の列挙は「ログイン失敗（5 回目のみ）」だけ。
    // 成功を毎回記録すると、監査ログがログインで埋まって読めなくなる。
    expect(Object.keys(AUDIT_ACTIONS)).not.toContain("auth.loginSucceeded");
  });
});

describe("INV-30: 監査ログを消せない", () => {
  /** リポジトリの実ソース（spec とコメント行を除く）。 */
  function repositorySources(): { file: string; code: string }[] {
    const directory = dirname(fileURLToPath(import.meta.url));
    return readdirSync(directory)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".spec.ts"))
      .map((file) => ({
        file,
        code: readFileSync(join(directory, file), "utf8")
          .split("\n")
          .filter((line) => {
            const trimmed = line.trimStart();
            return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
          })
          .join("\n"),
      }));
  }

  /**
   * `audit.ts` が公開してよい関数。**この並びが増えるのは根拠のあるときだけ。**
   *
   * テストの中で 2 度使うので定数にしてある（上のテストは「意図した一覧か」を、
   * 下のテストは「実装が一覧と一致するか」を見る）。
   */
  // P7-20 で listAuditLogsForViewer を追加。権限は決めてある:
  // 画面の loader が `finding.read`（監査領域の既存の境界）で門を張り、
  // CLEANER / INSPECTOR は 404、施設スコープは担当施設のみ、読み取り専用。
  const EXPECTED_FUNCTIONS = [
    "recordAudit",
    // 閲覧の記録を 1 日 1 件に畳む口（INV-08 v2 / DECISIONS #261）。
    // **書き込みの口が 2 つになった。** 削除・更新ではないので INV-30 は保つ。
    "recordAuditDaily",
    // **実行しないまま返す 1 文**（P8-11 hotfix / 2026-08-22 / DECISIONS #271）。
    // 物理削除と監査ログを同じ `batch()` へ束ねるために要る。
    // 書き込みの口が 3 つになったが、**削除・更新ではないので INV-30 は保つ**。
    // `auditLog` を触るのがこのファイルだけ、という境界も保つ
    // （呼び出し側は `db.insert(auditLog)` と書かない）。
    // **汎用の口にしない。** P8-11 専用で、呼び出し側が渡せるのは
    // 件数を数える式だけ（操作種別・対象種別・操作者はここで固定）。
    "residencyDeletionAuditStatement",
    "listAuditLogs",
    "listAuditLogsForViewer",
  ];

  it("auditLog に対する update / delete がリポジトリに存在しない", () => {
    // INV-30 / PK-IMPL-CONTRACT §11.4。訂正は新レコードの追加で行う。
    for (const { file, code } of repositorySources()) {
      expect(code, file).not.toMatch(/\.update\(\s*auditLog/);
      expect(code, file).not.toMatch(/\.delete\(\s*auditLog/);
    }
  });

  it("audit.ts が公開するのは書き込み 2 つと絞り込み付きの読み取りだけ", () => {
    // **削除・更新の関数をここへ足さないこと**（INV-30）。
    //
    // P4-12 が `listAuditLogs()` を足した。R010（客室ステータスの手動上書き
    // 頻発 / PK-SPEC-P4 §3.8）と R014（稼働記録の事後変更 / §3.10）の根拠は
    // 監査ログにしか無い。**期間と操作種別が必須**なので「全部読む」呼び出しは
    // 書けない（`AuditLogFilter`）。
    //
    // ここは名前の一覧を固定するだけ。**汎用の閲覧・検索・エクスポートを
    // 足すときは、この一覧に載せる前に権限（誰が監査ログを読めるか）を
    // 決めること。**
    expect(EXPECTED_FUNCTIONS).toEqual([
      "recordAudit",
      "recordAuditDaily",
      "residencyDeletionAuditStatement",
      "listAuditLogs",
      "listAuditLogsForViewer",
    ]);
  });

  it("公開している関数が上の一覧と一致する", async () => {
    const module: Record<string, unknown> = await import("./audit.js");
    const functions = Object.entries(module)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name);
    expect(functions).toEqual(EXPECTED_FUNCTIONS);
  });
});

describe("residencyDeletionAuditStatement（P8-11 / DECISIONS #271）", () => {
  /** この関数の本文だけを取り出す（コメントの語で検査を通さない）。 */
  const BODY = (() => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "audit.ts"),
      "utf8",
    );
    const start = source.indexOf("export function residencyDeletionAuditStatement(");
    return source
      .slice(start)
      .split("\n")
      .filter((line) => {
        const trimmed = line.trimStart();
        return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
      })
      .join("\n");
  })();

  it("**受け取るのは db・ctx・数える式の 3 つだけ**", () => {
    // 汎用の口にすると、別の `action` に `{deleted: N}` を書いたり、
    // 人の ID を操作者に使ったりできてしまう。
    expect(residencyDeletionAuditStatement).toHaveLength(3);
    expect(BODY).toContain("count: SQL,");
  });

  it("**操作種別を呼び出し側から指定できない**（`residency.deleted` に固定）", () => {
    expect(BODY).toContain('action: "residency.deleted"');
    expect(BODY).not.toContain("action: input");
    expect(BODY).not.toContain("action: AuditAction");
  });

  it("**対象種別を呼び出し側から指定できない**（`residencyRetention` に固定）", () => {
    expect(RESIDENCY_DELETION_TARGET).toBe("residencyRetention");
    expect(BODY).toContain("targetType: RESIDENCY_DELETION_TARGET");
    expect(BODY).not.toContain("targetType: input");
    expect(BODY).not.toContain("targetType: string");
  });

  it("**操作者を呼び出し側から指定できない**（system actor に固定）", () => {
    expect(BODY).toContain("actorId: systemActorId(ctx.orgShortId)");
    expect(BODY).not.toContain("actorId: input");
    expect(BODY).not.toContain("actorId: string");
  });

  it("**載るのは DB が数えた件数だけ**（値も対象 ID も理由も残さない）", () => {
    expect(BODY).toContain("json_object('deleted', ${count})");
    expect(BODY).toContain("targetId: null");
    expect(BODY).toContain("before: null");
    expect(BODY).toContain("reason: null");
    expect(BODY).toContain("ip: null");
  });

  it("実際に発行される INSERT が上の形になっている", async () => {
    const fake = createFakeD1();
    const ctx = tenantContext();
    const db = await getTenantDb(createFakeEnv(fake), ctx);

    await residencyDeletionAuditStatement(db, ctx, sql`(select 0)`);

    const [insert] = fake.queries;
    expect(insert?.sql.startsWith("insert into")).toBe(true);
    // 件数は副問い合わせ。**リテラルの JSON を束縛していない。**
    expect(insert?.sql).toContain("json_object('deleted'");
    expect(insert?.params).toContain("residency.deleted");
    expect(insert?.params).toContain(RESIDENCY_DELETION_TARGET);
    expect(insert?.params).toContain(`${TEST_ORG.orgShortId}__sys_00000000000000000000000000`);
    expect(insert?.params).toContain(TEST_ORG.organizationId);
    expect(JSON.stringify(insert?.params)).not.toContain('"deleted"');
  });
});
