/**
 * 越境テストの 4 パターンを組み立てる共通スイート。
 *
 * task:  docs/tasks/P0-13.md
 * ルール: .claude/rules/testing.md §2
 * 仕様:  docs/PK-SPEC-P0.md §19.4 第3層
 *
 * ── なぜ表ごとに手書きしないのか ────────────────────────
 * testing.md §2 は全テーブルに同じ 4 パターンを要求する。手書きすると
 * 表が増えるたびに 4 件を写経することになり、**写経の過程で 1 件だけ
 * 落とした表**が必ず生まれる。落ちた 1 件は「テストが無い」ではなく
 * 「テストがあるように見えて無い」という形で現れ、レビューで見つからない。
 * ここに 4 パターンを持ち、表ごとの spec は「どう呼ぶか」だけを書く。
 *
 * ── 実 D1 ではなく SQL を見ている ───────────────────────
 * P0-02 が未完で、実在する D1 は 1 本だけ。この段階で確かめられるのは
 * 「発行される SQL に組織条件と施設スコープの条件が必ず載ること」と
 * 「越境 ID が DB へ届く前に落ちること」で、それは記録された SQL で足りる
 * （`packages/db/src/test-support/fake-d1.ts` と同じ方針）。
 * **実 DB に 2 組織を同居させた実測は P0-02 の完了後に足すこと。**
 * そのとき差し替えるのはこのファイルだけで済むように、表ごとの spec には
 * fake を持ち込んでいない。
 */

import {
  createFakeD1,
  createFakeEnv,
  type FakeD1,
} from "@pk/db/test-support";
import { NotFoundError, type Env, type Role, type TenantContext } from "@pk/db";
import { describe, expect, it } from "vitest";

import { SAME_SHARD_ORG_PAIR } from "../fixtures/shard-pairs.js";

/** 固定時刻。`ctx.now` の経路を決定的にする。 */
const NOW = new Date("2026-08-12T00:00:00.000Z");

/** 越境テストで使う 2 組織。**同一シャードに落ちる**（fixtures 参照）。 */
export const ORG_A = SAME_SHARD_ORG_PAIR.a;
export const ORG_B = SAME_SHARD_ORG_PAIR.b;

/** 組織の文脈を作る。既定は組織全体ロール。 */
export function contextFor(
  org: { organizationId: string; orgShortId: string },
  overrides: Partial<Pick<TenantContext, "role" | "allowedPropertyIds">> = {},
): TenantContext {
  return {
    organizationId: org.organizationId,
    orgShortId: org.orgShortId,
    role: "ORG_ADMIN",
    allowedPropertyIds: [],
    now: NOW,
    ...overrides,
  };
}

/** 表 1 つ分の呼び出し方。 */
export interface IsolationSubject {
  /** 表の名前。`audit_log` のような SQL 上の名前。 */
  table: string;
  /**
   * 一覧を引く。第 1・第 3・第 4 パターンで使う。
   *
   * 施設スコープの検査に使うため、**施設の次元を持つ表では
   * `ctx.allowedPropertyIds` で絞られる関数を渡すこと。**
   */
  list: (env: Env, ctx: TenantContext) => Promise<unknown>;
  /**
   * ID を 1 つ取って引く。第 2 パターン（越境 ID → 404）で使う。
   *
   * `id` には**別組織の自己記述 ID**が渡る。
   * ID を取る関数が無い表は省略できる（その表では第 2 パターンを飛ばす）。
   */
  findById?: (env: Env, ctx: TenantContext, id: string) => Promise<unknown>;
  /**
   * 越境 ID に使う entityPrefix（`packages/db/src/id.ts` のレジストリ）。
   * `findById` を渡す表では必須。
   */
  entityPrefix?: string;
  /**
   * 施設スコープの検査に使う値。
   *
   * `propertyColumn` は SQL 上の列名（`property_id` / `id`）。
   * 施設の次元を持たない表（`user` / `organization`）は `null` を渡す。
   * **省略ではなく `null` を書かせる。** 省略を許すと「施設で絞るべき表なのに
   * 書き忘れた」場合と区別がつかない（`NO_PROPERTY_SCOPE` と同じ方針）。
   */
  propertyColumn: string | null;
}

/** SELECT / UPDATE / DELETE の組織条件。 */
const ORG_CONDITION = /"[a-z_]+"\."organization_id" = \?/;

/** 施設スコープロールが 1 施設だけ担当している状態。 */
const ASSIGNED_PROPERTY = "aa1111__prop_01JBXQ3ZK8N4P2VYR60000";

/** 担当外の施設。同じ組織の中にあるが `allowedPropertyIds` に無い。 */
const UNASSIGNED_PROPERTY = "aa1111__prop_01JBXQ3ZK8N4P2VYR60001";

/** 施設スコープロール（`base.ts` の `ORG_WIDE_ROLES` の補集合）。 */
const PROPERTY_SCOPED_ROLE: Role = "CLEANER";

/**
 * 1 つの表について testing.md §2 の 4 パターンを実行する。
 *
 * 表ごとの spec は `describeTenantIsolation({ ... })` を 1 回呼ぶだけにする。
 */
export function describeTenantIsolation(subject: IsolationSubject): void {
  describe(`tenant isolation: ${subject.table}`, () => {
    const { findById } = subject;
    if (findById === undefined) {
      // ID を 1 件引く関数が無い表（`organization` は `id === organizationId`）。
      // **第 2 パターンは成立しない。** 飛ばしたことをテスト名に残す。
      it.skip("別組織の ID を指定すると 404（ID を取る関数が無い表）", () => undefined);
    } else {
      it("別組織の ID を指定すると 404", async () => {
        const fake = createFakeD1();
        const env = createFakeEnv(fake);
        // B 組織の ID を A 組織の文脈で引く。403 ではなく 404（INV-31）。
        const prefix = subject.entityPrefix ?? "prop";
        const crossTenantId = `${ORG_B.orgShortId}__${prefix}_01JBXQ3ZK8N4P2VYR60000`;

        await expect(findById(env, contextFor(ORG_A), crossTenantId)).rejects.toBeInstanceOf(
          NotFoundError,
        );
        // **DB へ問い合わせる前に落ちること。** ここが 0 でないと越境 ID が届いている。
        expect(fake.queries).toEqual([]);
      });
    }

    it("別組織のレコードが一覧に混入しない", async () => {
      const fake = createFakeD1();
      await subject.list(createFakeEnv(fake), contextFor(ORG_A));

      expect(fake.queries.length).toBeGreaterThan(0);
      for (const query of fake.queries) {
        expect(query.sql).toMatch(ORG_CONDITION);
        expect(query.params).toContain(ORG_A.organizationId);
        expect(query.params).not.toContain(ORG_B.organizationId);
      }
    });

    it("同一シャードに同居する組織のデータが漏れない", async () => {
      // **このテストだけは同一シャードのペアであることに意味がある。**
      // 別シャードなら物理的に到達不能で、条件を消しても緑のままになる。
      // ペアが本当に同一シャードへ落ちることは _template.spec.ts が検査する。
      const fakeA = createFakeD1();
      const fakeB = createFakeD1();
      await subject.list(createFakeEnv(fakeA), contextFor(ORG_A));
      await subject.list(createFakeEnv(fakeB), contextFor(ORG_B));

      for (const query of fakeA.queries) {
        expect(query.params).toContain(ORG_A.organizationId);
        expect(query.params).not.toContain(ORG_B.organizationId);
      }
      for (const query of fakeB.queries) {
        expect(query.params).toContain(ORG_B.organizationId);
        expect(query.params).not.toContain(ORG_A.organizationId);
      }
    });

    it("施設スコープロールが担当外施設を取得できない", async () => {
      const fake = createFakeD1();
      await subject.list(
        createFakeEnv(fake),
        contextFor(ORG_A, {
          role: PROPERTY_SCOPED_ROLE,
          allowedPropertyIds: [ASSIGNED_PROPERTY],
        }),
      );

      for (const query of fake.queries) {
        // 組織条件は施設スコープでも必ず載る。
        expect(query.sql).toMatch(ORG_CONDITION);
        // 担当外施設の ID が条件に現れてはならない（そもそも渡していない）。
        expect(query.params).not.toContain(UNASSIGNED_PROPERTY);

        if (subject.propertyColumn === null) continue;
        // 施設の次元を持つ表は、担当施設だけに絞る条件が載る。
        expect(query.sql).toContain(`"${subject.propertyColumn}" in (?`);
        expect(query.params).toContain(ASSIGNED_PROPERTY);
      }
    });

    if (subject.propertyColumn !== null) {
      it("担当施設ゼロの施設スコープロールは 1 件も取得できない", async () => {
        // 空配列は「全施設」ではなく「1 件も見えない」（DECISIONS #017）。
        const fake = createFakeD1();
        await subject.list(
          createFakeEnv(fake),
          contextFor(ORG_A, { role: PROPERTY_SCOPED_ROLE, allowedPropertyIds: [] }),
        );
        for (const query of fake.queries) {
          expect(query.sql).toContain("1 = 0");
        }
      });
    }
  });
}

/** 表ごとの spec が代役を直接触りたいときのために再輸出する。 */
export { createFakeD1, createFakeEnv, type FakeD1 };
