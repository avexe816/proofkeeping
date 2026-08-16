/**
 * 施設横断の一覧の scope 判定（P7-18 / P7-20 が再利用する）。
 *
 * ルール: .claude/rules/security.md §1
 *
 * **ここが緩むと担当外施設が一覧に載る。** `resolveListScope()` は
 * 「施設を選ばない一覧」に答えを出す唯一の場所なので、7 ロール全部を
 * 走査して固定する。
 */

import { NotFoundError, ROLES, type Role, type TenantContext } from "@pk/db";
import { describe, expect, it } from "vitest";

import { resolveListScope } from "./listScope.js";

const ASSIGNED = "o7k2m9__prop_01JBXQ3ZK8N4P2VYR60000";
const OTHER = "o7k2m9__prop_01JBXQ3ZK8N4P2VYR60001";

function ctxFor(role: Role, allowedPropertyIds: readonly string[] = [ASSIGNED]): TenantContext {
  return {
    organizationId: "org_test_alpha",
    orgShortId: "o7k2m9",
    role,
    // 組織全体ロールは空配列（`tenant.ts` と同じ形）。
    allowedPropertyIds:
      role === "OWNER" || role === "ORG_ADMIN" || role === "AUDITOR" ? [] : allowedPropertyIds,
    now: new Date("2026-08-12T00:00:00.000Z"),
  };
}

/** `inspection.read` が `ORG` のロール（`PERMISSION_MATRIX`）。 */
const ORG_WIDE: readonly Role[] = ["OWNER", "ORG_ADMIN", "AUDITOR"];
/** 同 `ASSIGNED`。 */
const SCOPED: readonly Role[] = ["PROPERTY_MANAGER", "INSPECTOR"];
/** 同 `DENY`。 */
const DENIED: readonly Role[] = ["CLEANER", "VENDOR_ADMIN"];

describe("resolveListScope: 施設を指定しない一覧", () => {
  it.each([...ORG_WIDE])("%s は全施設（propertyIds = null）", (role) => {
    const scope = resolveListScope(ctxFor(role), "inspection.read", null);
    expect(scope.propertyIds).toBeNull();
    expect(scope.selectedPropertyId).toBeNull();
    expect(scope.canSelectAll).toBe(true);
  });

  // **これが `findings.ts` の書き方との違い。** 施設スコープロールが
  // 施設横断の一覧に到達でき、範囲は担当施設に限られる。
  it.each([...SCOPED])("%s は担当施設の集合", (role) => {
    const scope = resolveListScope(ctxFor(role, [ASSIGNED, OTHER]), "inspection.read", null);
    expect(scope.propertyIds).toEqual([ASSIGNED, OTHER]);
    expect(scope.selectedPropertyId).toBeNull();
    // 「全施設」は選べない。**組織全体の権限が無いため。**
    expect(scope.canSelectAll).toBe(false);
  });

  it.each([...DENIED])("%s は 404（403 を返さない / INV-31）", (role) => {
    expect(() => resolveListScope(ctxFor(role), "inspection.read", null)).toThrow(NotFoundError);
  });

  // 担当が 1 件も無い施設スコープロール。**空の一覧を 200 で返さない。**
  it.each([...SCOPED])("%s は担当施設ゼロなら 404", (role) => {
    expect(() => resolveListScope(ctxFor(role, []), "inspection.read", null)).toThrow(NotFoundError);
  });
});

describe("resolveListScope: 施設を指定する一覧", () => {
  it.each([...ORG_WIDE])("%s は任意の施設を指定できる", (role) => {
    const scope = resolveListScope(ctxFor(role), "inspection.read", OTHER);
    expect(scope.propertyIds).toEqual([OTHER]);
    expect(scope.selectedPropertyId).toBe(OTHER);
  });

  it.each([...SCOPED])("%s は担当施設を指定できる", (role) => {
    const scope = resolveListScope(ctxFor(role), "inspection.read", ASSIGNED);
    expect(scope.propertyIds).toEqual([ASSIGNED]);
    expect(scope.selectedPropertyId).toBe(ASSIGNED);
  });

  it.each([...SCOPED])("%s は担当外の施設を指定すると 404", (role) => {
    expect(() => resolveListScope(ctxFor(role), "inspection.read", OTHER)).toThrow(NotFoundError);
  });

  it.each([...DENIED])("%s は施設を指定しても 404", (role) => {
    expect(() => resolveListScope(ctxFor(role), "inspection.read", ASSIGNED)).toThrow(NotFoundError);
  });
});

describe("resolveListScope: 操作ごとに答えが変わる", () => {
  // **ロール名で分岐していないことの確認。** 同じ `INSPECTOR` でも、
  // 操作が変われば結果が変わる（`PERMISSION_MATRIX` が根拠）。
  it("INSPECTOR は finding.read では 404", () => {
    expect(() => resolveListScope(ctxFor("INSPECTOR"), "finding.read", null)).toThrow(NotFoundError);
  });

  it("AUDITOR は task.read で全施設", () => {
    expect(resolveListScope(ctxFor("AUDITOR"), "task.read", null).propertyIds).toBeNull();
  });

  // P7-20 が引き継ぐ形。**同じ関数で監査ログのスコープを解く。**
  it("VENDOR_ADMIN は task.read なら受託施設の集合", () => {
    const scope = resolveListScope(ctxFor("VENDOR_ADMIN", [ASSIGNED]), "task.read", null);
    expect(scope.propertyIds).toEqual([ASSIGNED]);
    expect(scope.canSelectAll).toBe(false);
  });
});

describe("resolveListScope: ロールを網羅している", () => {
  // 3 つの表の和が `ROLES` 全件であること。**ロールが増えたらここが落ちる。**
  it("ORG_WIDE / SCOPED / DENIED で ROLES を尽くす", () => {
    expect([...ORG_WIDE, ...SCOPED, ...DENIED].sort()).toEqual([...ROLES].sort());
  });
});
