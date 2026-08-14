/**
 * 権限マトリクス（P0-10）。
 *
 * 完了条件「7 ロール × 全アクションのマトリクスが実装されている」を、
 * **全 77 セルの走査**と、security.md §1 の境界を機械的に見る**不変条件**の
 * 二段で固定する。前者は「今どうなっているか」、後者は「今後どう壊れては
 * いけないか」を見ている。片方だけでは足りない。
 */

import { NotFoundError, ROLES, type Role, type TenantContext } from "@pk/db";
import { describe, expect, it } from "vitest";

import {
  ORGANIZATION_TARGET,
  PERMISSION_ACTION_LIST,
  PERMISSION_MATRIX,
  assertPermission,
  can,
  isOrgWideRole,
  isWriteAction,
  propertyTarget,
  resolveScope,
  type PermissionAction,
  type PermissionScope,
} from "./permission.js";

const NOW = new Date("2026-08-12T09:00:00.000Z");

function ctxOf(role: Role, allowedPropertyIds: readonly string[] = []): TenantContext {
  return {
    organizationId: "org_test_alpha",
    orgShortId: "a1b2c3",
    role,
    allowedPropertyIds,
    now: NOW,
  };
}

// ────────────────────────────────────────────────────────────
// 全セルの走査
// ────────────────────────────────────────────────────────────

/**
 * 期待値の独立した転記。`O` = ORG / `A` = ASSIGNED / `-` = DENY。
 *
 * 列の順は `ROLES` と同じ:
 *   OWNER / ORG_ADMIN / PROPERTY_MANAGER / INSPECTOR / CLEANER / VENDOR_ADMIN / AUDITOR
 *
 * **実装の表をそのまま複製せず、圧縮した別表記で書いてある。** 同じ構造を
 * 二度書くと、コピー間違いが両方に入って検査にならない。
 */
const EXPECTED: Record<PermissionAction, string> = {
  "organization.read": "OOOOOOO",
  "organization.write": "OO-----",
  "taxProfile.read": "OO----O",
  "taxProfile.write": "OO-----",
  "user.read": "OOOOOOO",
  "user.write": "OOA----",
  "property.read": "OOAAAAO",
  "property.write": "OOA----",
  "finding.read": "OOA--AO",
  // P4-05。手動再実行（PK-SPEC-P4 §6.4）は OWNER / ORG_ADMIN だけ。
  "reconciliation.run": "OO-----",
  // P4-07。状態の変更（同 §6.4）も OWNER / ORG_ADMIN だけ。
  // **読めるが閉じられない**（`finding.read` は施設責任者に `A`）。
  "finding.write": "OO-----",
  // P4-10。入室記録は登録すると差異が抑制される（同 §4.1）。
  // **現場ロールと受託側には与えない**（DECISIONS #115）。
  "roomAccess.read": "OOA---O",
  "roomAccess.write": "OOA----",
  // P4-13。ルール設定（同 §6.4）は OWNER / ORG_ADMIN だけ。
  // **閲覧も施設責任者に開かない**（閾値は判定の内側の値）。
  "ruleConfig.read": "OO----O",
  "ruleConfig.write": "OO-----",
  "lostItem.readStorage": "OOAA-AO",
  "billing.read": "OOA---O",
  // P1。清掃タスク（PK-SPEC-P1 §5.3）と設定画面（同 §10.1）。
  "task.read": "OOAAAAO",
  "task.write": "OOA-AA-",
  "task.manage": "OOA--A-",
  "checklistTemplate.read": "OO----O",
  "checklistTemplate.write": "OO-----",
  "standardTime.read": "OO----O",
  "standardTime.write": "OO-----",
  "roomPlan.read": "OOA---O",
  "roomPlan.write": "OOA----",
  "occupancy.read": "OOA---O",
  "occupancy.write": "OOA----",
  // P1-16。客室ステータスの手動上書きは「施設責任者」（§11.2）。
  "room.statusOverride": "OOA----",
  // P1-17。**全ロールが自分の記録を見られる**（security.md §5 MUST）。
  "task.readOwn": "OOOOOOO",
  // P2-04。検査は `INSPECTOR` / `PROPERTY_MANAGER` 以上（PK-SPEC-P2 §5.1）。
  // **`CLEANER` は読み書きとも DENY。** 差戻しの内容を見せる M-12（P2-07）は
  // 「自分のタスクの差戻し項目だけ」という別の絞りを持つ。
  "inspection.read": "OOAA--O",
  "inspection.write": "OOAA---",
  // P2-07。差戻し（PK-SPEC-P2 §4.6・§4.7）。
  // **`CLEANER` を許す唯一の検査系アクションが `rework.read` / `rework.write`。**
  // 「自分の差戻しか」は `assertReworkVisible()` が別に絞る。
  // 免除は §4.7 の「PROPERTY_MANAGER 以上」で、`VENDOR_ADMIN` に広げない。
  "rework.read": "OOAAAAO",
  "rework.write": "OOA-AA-",
  "rework.waive": "OOA----",
  // P2-16。残存タスクの緊急上書き（§13.3）は「施設責任者」。
  // **`INSPECTOR` は DENY。** 検査担当が「検査せずに閉じる」を選べると、
  // §13.1 で廃止した一括承認と同じことが 1 件ずつできてしまう。
  "inspection.emergencyOverride": "OOA----",
  // P2-10。証跡 ZIP の持ち出し（§6.5）。**閲覧は `task.read` のまま。**
  // `AUDITOR` の `-` は security.md §1「書き込み操作を一切できない」に
  // 沿った既定（OPEN_QUESTIONS #048）。
  "evidence.export": "OOA----",
  // P2-11 / P2-12。忘れ物（§7.4）と設備不具合（§8）。
  // **`CLEANER` は登録と閲覧まで。** 状態の更新は運営側。
  "lostItem.read": "OOAAAAO",
  "lostItem.write": "OOAAAA-",
  "lostItem.manage": "OOAA---",
  "issue.read": "OOAAAAO",
  "issue.write": "OOAAAA-",
  "issue.manage": "OOA----",
  // P2-14。日報（§9.1・§9.3）。**現場ロール（`INSPECTOR` / `CLEANER`）は DENY。**
  // 明細に全室ぶんの担当者名と所要時間が並ぶため（security.md §5）。
  // 提出する側（`VENDOR_ADMIN`）は読めるが、版を増やすのは施設側の判断。
  "dailyReport.read": "OOA--AO",
  "dailyReport.generate": "OOA----",
  // P3。観察記録（PK-SPEC-P3 §2.2・§6.1）。現場が入力し、現場が読む。
  "observation.read": "OOAAAAO",
  "observation.write": "OOAAAA-",
  // §2.2 MUST「事後修正は PROPERTY_MANAGER 以上のみ」。
  "observation.amend": "OOA----",
  "observationConfig.read": "OOA---O",
  // §6.1 の担当ロールは ORG_ADMIN。施設責任者は読むだけ。
  "observationConfig.write": "OO-----",
  // P3-09〜P3-12。ベースラインと入力品質（同 §5.5・§6.1・§6.3）。
  // **現場ロール（INSPECTOR / CLEANER）は到達しない。**
  "baseline.read": "OOA---O",
  "baseline.override": "OO-----",
  "dataQuality.read": "OOA---O",
};

const SYMBOL_TO_SCOPE: Record<string, PermissionScope> = {
  O: "ORG",
  A: "ASSIGNED",
  "-": "DENY",
};

describe("マトリクスの全セル", () => {
  it("7 ロール × 全アクションが期待どおり", () => {
    // toEqual に 1 度で載せる。個別 it にすると、落ちたとき何セル壊れたかが読めない。
    const actual: Record<string, string> = {};
    for (const action of PERMISSION_ACTION_LIST) {
      actual[action] = ROLES.map((role) => {
        const scope = resolveScope(role, action);
        return Object.keys(SYMBOL_TO_SCOPE).find((s) => SYMBOL_TO_SCOPE[s] === scope) ?? "?";
      }).join("");
    }
    expect(actual).toEqual(EXPECTED);
  });

  it("期待値の表の桁数が ROLES と一致する", () => {
    // EXPECTED の書き間違い（桁落ち）を上のテストより先に落とす。
    for (const action of PERMISSION_ACTION_LIST) {
      expect(EXPECTED[action]).toHaveLength(ROLES.length);
    }
  });

  it("全アクション × 全ロールのセルが存在する", () => {
    // 型でも保証されるが、実行時にも見る。Record の穴は
    // `as` を挟んだ改変で型検査をすり抜けうる。
    for (const action of PERMISSION_ACTION_LIST) {
      for (const role of ROLES) {
        expect(["DENY", "ORG", "ASSIGNED"]).toContain(PERMISSION_MATRIX[action][role]);
      }
    }
  });

  it("アクションのレジストリと表のキーが一致する", () => {
    expect(Object.keys(PERMISSION_MATRIX).sort()).toEqual([...PERMISSION_ACTION_LIST].sort());
  });
});

// ────────────────────────────────────────────────────────────
// 不変条件（security.md §1「絶対に守る境界」）
// ────────────────────────────────────────────────────────────

describe("不変条件", () => {
  it("AUDITOR は書き込みアクションすべてで DENY", () => {
    // security.md §1「AUDITOR は書き込み操作を一切できない」。
    // アクションが増えても自動で効く。
    const writable = PERMISSION_ACTION_LIST.filter(
      (action) => isWriteAction(action) && resolveScope("AUDITOR", action) !== "DENY",
    );
    expect(writable).toEqual([]);
  });

  it("書き込みアクションで ORG を持てるのは組織全体ロールだけ", () => {
    // OPEN_QUESTIONS #016 の回答「読み取りは全施設、書き込みは自施設のみ」を
    // 機械可読にしたもの。施設スコープロールに組織全体の書き込みを与える
    // 変更は、以後どの task が行ってもここで落ちる。
    const violations: string[] = [];
    for (const action of PERMISSION_ACTION_LIST) {
      if (!isWriteAction(action)) continue;
      for (const role of ROLES) {
        if (resolveScope(role, action) === "ORG" && !isOrgWideRole(role)) {
          violations.push(`${action}/${role}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("CLEANER と INSPECTOR は差異レポートに到達できない", () => {
    expect(resolveScope("CLEANER", "finding.read")).toBe("DENY");
    expect(resolveScope("INSPECTOR", "finding.read")).toBe("DENY");
  });

  it("CLEANER は忘れ物の保管場所・返却先を見られない", () => {
    expect(resolveScope("CLEANER", "lostItem.readStorage")).toBe("DENY");
  });

  it("INSPECTOR は請求情報を見られない", () => {
    expect(resolveScope("INSPECTOR", "billing.read")).toBe("DENY");
  });

  it("CLEANER は組織設定を変更できない", () => {
    // P0-10 完了条件。到達できないこと（404）は下の assertPermission で見る。
    expect(resolveScope("CLEANER", "organization.write")).toBe("DENY");
    expect(resolveScope("CLEANER", "taxProfile.read")).toBe("DENY");
  });
});

// ────────────────────────────────────────────────────────────
// ASSIGNED の判定
// ────────────────────────────────────────────────────────────

describe("ASSIGNED の判定", () => {
  const ctx = ctxOf("PROPERTY_MANAGER", ["a1b2c3__prop_A", "a1b2c3__prop_B"]);

  it("担当施設に含まれる資源は許可", () => {
    expect(can(ctx, "property.write", propertyTarget(["a1b2c3__prop_A"]))).toBe(true);
  });

  it("担当施設すべてにまたがる資源も許可", () => {
    expect(can(ctx, "property.write", propertyTarget(["a1b2c3__prop_A", "a1b2c3__prop_B"]))).toBe(
      true,
    );
  });

  it("担当外の施設が 1 つでも混ざれば拒否（交差ではなく部分集合）", () => {
    // A は担当、C は担当外。交差で判定していたら通ってしまう。
    expect(can(ctx, "property.write", propertyTarget(["a1b2c3__prop_A", "a1b2c3__prop_C"]))).toBe(
      false,
    );
  });

  it("担当外だけなら拒否", () => {
    expect(can(ctx, "property.write", propertyTarget(["a1b2c3__prop_C"]))).toBe(false);
  });

  it("施設が 1 つも紐付かない資源は拒否", () => {
    expect(can(ctx, "property.write", propertyTarget([]))).toBe(false);
  });

  it("組織全体の対象を ASSIGNED のセルで通さない", () => {
    // 施設で絞れない資源を、施設スコープの権限で書けてはならない。
    expect(can(ctx, "property.write", ORGANIZATION_TARGET)).toBe(false);
  });

  it("担当施設ゼロなら何も書けない", () => {
    // 空配列は「全施設」ではなく「1 件も見えない」（scopeToProperties と同じ意味）。
    const noProperty = ctxOf("PROPERTY_MANAGER", []);
    expect(can(noProperty, "property.write", propertyTarget(["a1b2c3__prop_A"]))).toBe(false);
  });
});

describe("ORG の判定", () => {
  it("組織全体ロールは施設の対象でも許可", () => {
    const owner = ctxOf("OWNER", []);
    expect(can(owner, "property.write", propertyTarget(["a1b2c3__prop_Z"]))).toBe(true);
  });

  it("施設スコープロールでも読み取りは組織全体（OPEN_QUESTIONS #016）", () => {
    // user / membership は propertyId を持たない。担当施設ゼロでも読める。
    for (const role of ROLES) {
      expect(can(ctxOf(role, []), "user.read", ORGANIZATION_TARGET)).toBe(true);
    }
  });
});

// ────────────────────────────────────────────────────────────
// assertPermission
// ────────────────────────────────────────────────────────────

describe("assertPermission", () => {
  it("許可なら何も投げない", () => {
    expect(() => {
      assertPermission(ctxOf("ORG_ADMIN"), "organization.write", ORGANIZATION_TARGET);
    }).not.toThrow();
  });

  it("拒否は NotFoundError（403 を投げない）", () => {
    expect(() => {
      assertPermission(ctxOf("CLEANER"), "organization.write", ORGANIZATION_TARGET);
    }).toThrow(NotFoundError);
  });

  it("投げるのは @pk/db の NotFoundError そのもの", () => {
    // ここで再定義すると instanceof が外れ、404 のはずが 500 になる
    // （packages/db/src/errors.ts の申し送り）。
    try {
      assertPermission(ctxOf("CLEANER"), "finding.read", propertyTarget(["a1b2c3__prop_A"]));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundError);
      expect((error as NotFoundError).code).toBe("RESOURCE_NOT_FOUND");
    }
  });

  it("担当外施設も同じ NotFoundError（存在を示唆しない）", () => {
    const ctx = ctxOf("PROPERTY_MANAGER", ["a1b2c3__prop_A"]);
    expect(() => {
      assertPermission(ctx, "property.write", propertyTarget(["a1b2c3__prop_C"]));
    }).toThrow(NotFoundError);
  });

  it("can と assertPermission の判定が一致する", () => {
    // 2 つの入口が食い違うと、画面に出ているのに操作できない（逆も）状態になる。
    const targets = [ORGANIZATION_TARGET, propertyTarget(["a1b2c3__prop_A"])];
    for (const action of PERMISSION_ACTION_LIST) {
      for (const role of ROLES) {
        for (const target of targets) {
          const ctx = ctxOf(role, ["a1b2c3__prop_A"]);
          const allowed = can(ctx, action, target);
          let threw = false;
          try {
            assertPermission(ctx, action, target);
          } catch {
            threw = true;
          }
          expect(threw).toBe(!allowed);
        }
      }
    }
  });
});
