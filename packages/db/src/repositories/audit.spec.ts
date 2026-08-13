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

import { describe, expect, it } from "vitest";

import { generateId } from "../id.js";
import { MASKED } from "../mask.js";
import {
  createFakeD1,
  createFakeEnv,
  TEST_NOW,
  TEST_ORG,
  tenantContext,
} from "../test-support/fake-d1.js";

import { AUDIT_ACTIONS, recordAudit } from "./audit.js";

const ACTOR = generateId(TEST_ORG.orgShortId, "mem");
const TARGET = generateId(TEST_ORG.orgShortId, "room");

/** 実在の認証情報から作った値ではない。形だけを再現している。 */
const HASH = "pbkdf2$sha256$210000$c2FsdA$aGFzaA";

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
    const required = Object.entries(AUDIT_ACTIONS)
      .filter(([, meta]) => meta.requiresReason)
      .map(([action]) => action);
    expect(required.sort()).toEqual([
      "inspection.selfApproved",
      "observation.amended",
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

  it("auditLog に対する update / delete がリポジトリに存在しない", () => {
    // INV-30 / PK-IMPL-CONTRACT §11.4。訂正は新レコードの追加で行う。
    for (const { file, code } of repositorySources()) {
      expect(code, file).not.toMatch(/\.update\(\s*auditLog/);
      expect(code, file).not.toMatch(/\.delete\(\s*auditLog/);
    }
  });

  it("audit.ts が公開するのは recordAudit と定数だけ", async () => {
    // 読み取り・検索・エクスポートは P0-11 のスコープ外。
    // 削除・更新の関数をここへ足さないこと。
    const module: Record<string, unknown> = await import("./audit.js");
    const functions = Object.entries(module)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name);
    expect(functions).toEqual(["recordAudit"]);
  });
});
