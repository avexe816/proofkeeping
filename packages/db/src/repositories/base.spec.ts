/**
 * `withTenantScope()` / `scopeToProperties()` の単体テスト。
 *
 * task: docs/tasks/P0-07.md
 * ルール: .claude/rules/testing.md
 *
 * 発行される SQL を D1 の代役で捕まえて検証する。SQL の文字列そのものを
 * 期待値に固定するのではなく、**「organizationId 条件が必ずある」
 * 「担当外が取れない」という不変条件**を見る。
 */

import { describe, expect, it } from "vitest";

import {
  createFakeD1,
  createFakeEnv,
  TEST_ORG,
  tenantContext,
} from "../test-support/fake-d1.js";
import { ROLES, type Role } from "../schema/user.js";

import { isOrgWideRole } from "./base.js";
import { listBillingPeriods } from "./invoice.js";
import { listProperties } from "./property.js";
import { listRooms } from "./room.js";

/** 組織条件（テーブル修飾つき）。 */
const ORG_CONDITION = /"[a-z_]+"\."organization_id" = \?/;

/** 施設スコープの絞り込み。`in (?, ?)` の形。 */
const PROPERTY_IN = /"[a-z_]+"\."(?:id|property_id)" in \(/;

async function runListRooms(role: Role, allowedPropertyIds: readonly string[]) {
  const fake = createFakeD1();
  await listRooms(createFakeEnv(fake), tenantContext({ role, allowedPropertyIds }));
  const query = fake.queries[0];
  if (query === undefined) throw new Error("クエリが発行されていない");
  return query;
}

describe("scopeToProperties: ロール別の絞り込み", () => {
  it("組織全体ロールは施設で絞られない", async () => {
    for (const role of ["OWNER", "ORG_ADMIN", "AUDITOR"] satisfies Role[]) {
      const query = await runListRooms(role, []);
      expect(query.sql).toMatch(ORG_CONDITION);
      expect(query.sql).not.toMatch(PROPERTY_IN);
      // 担当施設が空でも 0 件条件にならない（組織全体が見えるロールのため）。
      expect(query.sql).not.toContain("1 = 0");
    }
  });

  it("施設スコープロールは allowedPropertyIds で絞られる", async () => {
    for (const role of [
      "PROPERTY_MANAGER",
      "INSPECTOR",
      "CLEANER",
      "VENDOR_ADMIN",
    ] satisfies Role[]) {
      const query = await runListRooms(role, ["prop_a", "prop_b"]);
      expect(query.sql).toMatch(ORG_CONDITION);
      expect(query.sql).toMatch(PROPERTY_IN);
      expect(query.params).toEqual([TEST_ORG.organizationId, "prop_a", "prop_b"]);
    }
  });

  it("担当施設が空の施設スコープロールは 0 件になる（全件ではない）", async () => {
    // ここが逆に振れると、割当前のユーザーに全施設が見える。
    for (const role of [
      "PROPERTY_MANAGER",
      "INSPECTOR",
      "CLEANER",
      "VENDOR_ADMIN",
    ] satisfies Role[]) {
      const query = await runListRooms(role, []);
      expect(query.sql).toContain("1 = 0");
      expect(query.sql).not.toMatch(PROPERTY_IN);
    }
  });

  it("施設一覧は property.id で絞る（他の表は property_id）", async () => {
    const fake = createFakeD1();
    await listProperties(
      createFakeEnv(fake),
      tenantContext({ role: "CLEANER", allowedPropertyIds: ["prop_a"] }),
    );
    const query = fake.queries[0];
    expect(query?.sql).toContain('"property"."id" in (');
    expect(query?.params).toEqual([TEST_ORG.organizationId, "prop_a"]);
  });
});

describe("ロール網羅", () => {
  it("ROLES の全ロールが組織全体か施設スコープのどちらかに分類される", () => {
    // ROLES が増えたときに分類漏れが起きないことの回帰テスト。
    for (const role of ROLES) {
      expect(typeof isOrgWideRole(role)).toBe("boolean");
    }
  });

  it("組織全体ロールは 3 つだけ（security.md §1）", () => {
    expect(ROLES.filter(isOrgWideRole)).toEqual(["OWNER", "ORG_ADMIN", "AUDITOR"]);
  });

  it("ORG_WIDE_ROLES に無いロールは必ず施設で絞られる（既定は制限側）", async () => {
    // 新しいロールを ROLES に足して ORG_WIDE_ROLES への追記を忘れても、
    // 「見えすぎる」方向には壊れないことを固定する。
    for (const role of ROLES.filter((r) => !isOrgWideRole(r))) {
      const query = await runListRooms(role, ["prop_a"]);
      expect(query.sql).toMatch(PROPERTY_IN);
    }
  });
});

describe("scopeToCounterparty: 発注元ロールの取引先絞り（P5-16）", () => {
  const COUNTERPARTY_EQ = /"billing_period"\."counterparty_id" = \?/;

  it("CLIENT_VIEWER は自分の取引先で絞られる", async () => {
    const fake = createFakeD1();
    await listBillingPeriods(
      createFakeEnv(fake),
      tenantContext({ role: "CLIENT_VIEWER", counterpartyId: "cp_a" }),
    );
    const query = fake.queries[0];
    expect(query?.sql).toMatch(ORG_CONDITION);
    expect(query?.sql).toMatch(COUNTERPARTY_EQ);
    expect(query?.params).toEqual([TEST_ORG.organizationId, "cp_a", 200]);
  });

  it("取引先が未設定の CLIENT_VIEWER は 0 件になる（全件ではない）", async () => {
    // 設定漏れのアカウントが全取引先の請求を読める形で壊れないこと。
    const fake = createFakeD1();
    await listBillingPeriods(
      createFakeEnv(fake),
      tenantContext({ role: "CLIENT_VIEWER", counterpartyId: null }),
    );
    expect(fake.queries[0]?.sql).toContain("1 = 0");
  });

  it("他ロールは取引先で絞られない", async () => {
    // 絞りの根拠は role が持つ。誤って counterpartyId が残っていても効かせない。
    const fake = createFakeD1();
    await listBillingPeriods(
      createFakeEnv(fake),
      tenantContext({ role: "ORG_ADMIN", counterpartyId: "cp_a" }),
    );
    const query = fake.queries[0];
    expect(query?.sql).not.toMatch(COUNTERPARTY_EQ);
    expect(query?.params).toEqual([TEST_ORG.organizationId, 200]);
  });

  it("フィルタの counterpartyId は取引先スコープの代わりにならない", async () => {
    // CLIENT_VIEWER が他取引先の ID をフィルタで渡しても、強制絞りは外れない。
    const fake = createFakeD1();
    await listBillingPeriods(
      createFakeEnv(fake),
      tenantContext({ role: "CLIENT_VIEWER", counterpartyId: "cp_a" }),
      { counterpartyId: "cp_other" },
    );
    const query = fake.queries[0];
    expect(query?.sql).toMatch(COUNTERPARTY_EQ);
    expect(query?.params).toEqual([TEST_ORG.organizationId, "cp_a", "cp_other", 200]);
  });
});

describe("withTenantScope: 個別条件との合成", () => {
  it("フィルタ未指定でも組織条件は消えない", async () => {
    const fake = createFakeD1();
    await listRooms(createFakeEnv(fake), tenantContext());
    expect(fake.queries[0]?.sql).toMatch(ORG_CONDITION);
  });

  it("個別条件は組織条件と AND される", async () => {
    const fake = createFakeD1();
    await listRooms(createFakeEnv(fake), tenantContext(), {
      propertyId: "prop_a",
      isSellable: true,
      isActive: true,
    });
    const query = fake.queries[0];
    expect(query?.sql).toMatch(ORG_CONDITION);
    expect(query?.params).toEqual([TEST_ORG.organizationId, "prop_a", 1, 1]);
  });

  it("担当外の施設 ID をフィルタで渡しても組織条件と施設スコープは外れない", async () => {
    // フィルタの propertyId は施設スコープの代わりにならない。
    const fake = createFakeD1();
    await listRooms(
      createFakeEnv(fake),
      tenantContext({ role: "CLEANER", allowedPropertyIds: ["prop_a"] }),
      { propertyId: "prop_zzz" },
    );
    const query = fake.queries[0];
    expect(query?.sql).toMatch(ORG_CONDITION);
    expect(query?.sql).toMatch(PROPERTY_IN);
    expect(query?.params).toEqual([TEST_ORG.organizationId, "prop_a", "prop_zzz"]);
  });
});
