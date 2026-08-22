/**
 * 認証境界が見る「有効かどうか」（DECISIONS #263）。
 *
 * 組織条件の強制注入と越境 ID は `repositories.spec.ts` が見ている。
 * ここが固定するのは **2 つの旗の扱い**と、**JOIN 1 回で済んでいること。**
 *
 * ── なぜここまで見るのか ────────────────────────────────
 * 無効化（`setUserActive()`）が立てるのは `user.isActive` で、
 * `membership.isActive` を書き換える経路は製品のどこにも無い
 * （`UPDATE membership` は `updateMembershipRole()` の `role` 1 か所だけ）。
 * それでも毎リクエストの再検査は `membership.isActive` だけを見ていたため、
 * **停止済みのスタッフの発行済みセッションが期限まで通り続けていた。**
 * 直したあと、同じ穴が「片方の旗しか見ない」形で戻らないようにする。
 */

import { describe, expect, it } from "vitest";

import { generateId } from "../id.js";
import { createFakeD1, createFakeEnv, TEST_ORG, tenantContext } from "../test-support/fake-d1.js";

import { findMembershipByUserId } from "./user.js";

const USER = generateId(TEST_ORG.orgShortId, "usr");
const MEMBER = generateId(TEST_ORG.orgShortId, "mem");

/**
 * `findMembershipByUserId()` の select の並び。**列の順序に合わせること。**
 * `raw()` 形式（配列の配列）で返る。
 */
function row(membershipActive: boolean, userActive: boolean): unknown[] {
  return [
    MEMBER,
    USER,
    TEST_ORG.organizationId,
    "CLEANER",
    membershipActive ? 1 : 0,
    userActive ? 1 : 0,
    null,
  ];
}

async function find(membershipActive: boolean, userActive: boolean) {
  const fake = createFakeD1();
  fake.enqueueRows([row(membershipActive, userActive)]);
  const found = await findMembershipByUserId(
    createFakeEnv(fake),
    tenantContext(),
    USER,
  );
  return { found, fake };
}

describe("findMembershipByUserId — 2 つの旗", () => {
  it("両方立っていれば有効", async () => {
    const { found } = await find(true, true);
    expect(found).toMatchObject({ isActive: true, userIsActive: true, isEffectiveActive: true });
  });

  it("**アカウントが停止されていれば無効**（membership=true / user=false）", async () => {
    // これが W-07 / W-12 の「利用を停止する」が作る状態。
    const { found } = await find(true, false);
    expect(found).toMatchObject({ isActive: true, userIsActive: false, isEffectiveActive: false });
  });

  it("所属が無効化されていれば無効（membership=false / user=true）", async () => {
    const { found } = await find(false, true);
    expect(found).toMatchObject({ isActive: false, userIsActive: true, isEffectiveActive: false });
  });

  it("両方落ちていれば無効", async () => {
    const { found } = await find(false, false);
    expect(found?.isEffectiveActive).toBe(false);
  });

  it("行が無ければ `undefined`", async () => {
    const fake = createFakeD1();
    const found = await findMembershipByUserId(createFakeEnv(fake), tenantContext(), USER);
    expect(found).toBeUndefined();
  });

  it("**2 つの旗の意味を上書きしない**（生の値も返す）", async () => {
    // `isActive` を論理積で塗り潰すと、「所属は生きているがアカウントが
    // 止まっている」のか「所属自体が切れている」のかを呼び出し側が
    // 区別できなくなる。業務上の意味が違う（OPEN_QUESTIONS #121）。
    const { found } = await find(true, false);
    expect(found?.isActive).toBe(true);
    expect(found?.userIsActive).toBe(false);
  });
});

describe("findMembershipByUserId — クエリ", () => {
  it("**JOIN 1 回で完結する**（`user` を別に引かない）", async () => {
    const { fake } = await find(true, true);
    expect(fake.queries).toHaveLength(1);
    const sql = fake.queries[0]?.sql ?? "";
    expect(sql).toContain("join");
    expect(sql).toContain('"user"');
    expect(sql).toContain('"membership"');
  });

  it("`user` 側にも組織条件を掛ける（結合条件だけに頼らない）", async () => {
    const { fake } = await find(true, true);
    const sql = fake.queries[0]?.sql ?? "";
    expect(sql).toContain('"user"."organization_id"');
    expect(fake.queries[0]?.params).toContain(TEST_ORG.organizationId);
  });

  it("**認証情報を選ばない**（security.md §6）", async () => {
    // JOIN で `user` を引くので、行をそのまま返すとハッシュが出る。
    const { fake } = await find(true, true);
    const sql = fake.queries[0]?.sql ?? "";
    for (const forbidden of ["password_hash", "pin_hash"]) {
      expect(sql, forbidden).not.toContain(forbidden);
    }
  });
});
