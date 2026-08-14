/**
 * 「D1 へ送る文が 100 変数を超えない」の横断検証。
 *
 * 仕様: docs/PK-SPEC-P1 §3（タスク自動生成）/ §9.5（客室ボード）
 * ルール: .claude/rules/architecture.md §1 / .claude/rules/testing.md
 *
 * ── なぜ必要か ──────────────────────────────────────────
 * **D1 は 1 ステートメントあたりのバインド変数を 100 個までしか受けない**
 * （`limits.ts`）。超えると `D1_ERROR: too many SQL variables` で落ちる。
 * これは**件数が増えたときにだけ**起きるので、1〜2 件を渡すテストでは
 * 決して露見しない。実際に `expandChecklist()` が 60 行 × 11 列 = 660 変数の
 * 文を組んでおり、清掃タスクの自動生成が本番相当の件数で 1 件も通らず、
 * 結果として M-08 / M-09（検査）へ到達できていなかった。
 *
 * ── 何を見ているか ──────────────────────────────────────
 * 「呼び出し側が渡す並びの長さで文の大きさが決まる関数」に**現実的に
 * 大きい入力**を渡し、代役の D1 が受け取った全ての文について
 * `params.length <= 100` を確かめる。分割の実装（何件ずつか）には
 * 触れない。**守りたいのは「落ちないこと」だけ。**
 *
 * ── 関数を足したらここへ 1 行足す ────────────────────────
 * 並びを受け取る新しいリポジトリ関数は、必ず下の `CASES` に載せること。
 */

import { describe, expect, it } from "vitest";

import { D1_MAX_BOUND_PARAMS } from "../limits.js";
import { generateId } from "../id.js";
import type { Env } from "../env.js";
import type { TenantContext } from "../router.js";
import {
  createFakeD1,
  createFakeEnv,
  TEST_ORG,
  tenantContext,
  type FakeD1,
} from "../test-support/fake-d1.js";

import { expandChecklist, listChecklistItemsByIds, listTemplateItems } from "./checklist.js";
import { assignTasks } from "./cleaningTask.js";
import { setHousekeepingStatus } from "./room.js";
import { upsertOccupancySnapshots } from "./occupancy.js";
import { countPhotosByTask } from "./taskPhoto.js";

/** 本番相当の規模。**100 室の施設**（§9.5 の盤面がこの大きさ）。 */
const BULK = 120;

/** その組織の ID を `count` 件。 */
function ids(prefix: Parameters<typeof generateId>[1], count: number): string[] {
  return Array.from({ length: count }, () => generateId(TEST_ORG.orgShortId, prefix));
}

/**
 * 検証する 1 件。
 *
 * `role` を指定できるようにしてあるのは、**施設スコープロールでは
 * `withTenantScope()` が `allowedPropertyIds` のぶんだけ変数を足す**ため。
 * 組織全体ロールだけで試すと、予約分の見込み違いを見逃す。
 */
interface Case {
  name: string;
  run: (env: Env, ctx: TenantContext) => Promise<unknown>;
}

const CASES: Case[] = [
  {
    name: "checklist.expandChecklist（1 タスク 40 項目 × 30 タスク）",
    run: (env, ctx) =>
      expandChecklist(
        env,
        ctx,
        Array.from({ length: 30 }, () => ({
          taskId: generateId(TEST_ORG.orgShortId, "task"),
          propertyId: generateId(TEST_ORG.orgShortId, "prop"),
          templateVersion: 1,
          items: ids("citm", 40).map((itemId) => ({
            itemId,
            isRequired: true,
            photoRequired: false,
          })),
        })),
      ),
  },
  {
    name: "checklist.listTemplateItems",
    run: (env, ctx) => listTemplateItems(env, ctx, ids("ctpl", BULK)),
  },
  {
    name: "checklist.listChecklistItemsByIds",
    run: (env, ctx) => listChecklistItemsByIds(env, ctx, ids("citm", BULK)),
  },
  {
    name: "taskPhoto.countPhotosByTask",
    run: (env, ctx) => countPhotosByTask(env, ctx, ids("task", BULK)),
  },
  {
    name: "room.setHousekeepingStatus",
    run: (env, ctx) => setHousekeepingStatus(env, ctx, ids("room", BULK), "DIRTY"),
  },
  {
    name: "cleaningTask.assignTasks",
    run: (env, ctx) =>
      assignTasks(env, ctx, ids("task", BULK), generateId(TEST_ORG.orgShortId, "mem")),
  },
  {
    // P4-02。**1 行ずつ INSERT / UPDATE する**ので件数で文が大きくならないが、
    // 列が 23 個あるため 1 文で 23 変数を使う。列を足したときにここが鳴る。
    name: "occupancy.upsertOccupancySnapshots（120 室ぶん）",
    run: (env, ctx) =>
      upsertOccupancySnapshots(
        env,
        ctx,
        {
          propertyId: generateId(TEST_ORG.orgShortId, "prop"),
          businessDate: "2026-09-09",
          source: "CSV_IMPORT",
          importedById: generateId(TEST_ORG.orgShortId, "mem"),
        },
        ids("room", BULK).map((roomId) => ({
          roomId,
          isOccupied: true,
          guestCount: 2,
          adultCount: 0,
          childCount: 0,
          reservationRef: "RSV-1",
          channelCode: null,
          checkInAt: null,
          checkOutAt: null,
          isStayover: false,
          nightsTotal: null,
          nightIndex: null,
          ratePlanCode: null,
          isComplimentary: false,
          isHouseUse: false,
          rawPayload: null,
        })),
      ),
  },
  {
    name: "cleaningTask.assignTasks（includeActive で 2 文になる経路）",
    run: (env, ctx) =>
      assignTasks(env, ctx, ids("task", BULK), generateId(TEST_ORG.orgShortId, "mem"), {
        includeActive: true,
      }),
  },
];

/** 施設スコープロールの担当施設。**変数を食う側の条件を再現する。** */
const ASSIGNED_PROPERTIES = ids("prop", 15);

/** 最大の変数数と、その文。 */
function worst(d1: FakeD1): { count: number; sql: string } {
  let count = 0;
  let sql = "";
  for (const query of d1.queries) {
    if (query.params.length > count) {
      count = query.params.length;
      sql = query.sql;
    }
  }
  return { count, sql };
}

describe("D1 の 1 文あたり 100 変数を超えない", () => {
  for (const testCase of CASES) {
    it(`${testCase.name} — 組織全体ロール`, async () => {
      const d1 = createFakeD1();
      const env = createFakeEnv(d1);
      await testCase.run(env, tenantContext({ role: "ORG_ADMIN", allowedPropertyIds: [] }));

      const { count, sql } = worst(d1);
      // 1 文も送っていないなら分割の検証にならない。**必ず送っていること。**
      expect(d1.queries.length).toBeGreaterThan(0);
      expect(count, sql).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
    });

    it(`${testCase.name} — 施設スコープロール（担当 15 施設）`, async () => {
      // **`allowedPropertyIds` が変数を食う。** 予約分の見込みがここで効く。
      const d1 = createFakeD1();
      const env = createFakeEnv(d1);
      await testCase.run(
        env,
        tenantContext({ role: "PROPERTY_MANAGER", allowedPropertyIds: ASSIGNED_PROPERTIES }),
      );

      const { count, sql } = worst(d1);
      expect(d1.queries.length).toBeGreaterThan(0);
      expect(count, sql).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
    });
  }
});
