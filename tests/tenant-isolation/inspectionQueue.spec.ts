/**
 * tenant isolation: 検査キュー（施設横断 / P7-18）の読み取り経路
 *
 * task:  docs/tasks/P7-18.md
 * ルール: .claude/rules/testing.md §2
 *
 * ── なぜ表ごとではなく経路ごとに掛けるのか ──────────────
 * `cleaningTask.spec.ts` の末尾の注記と同じ。**越境は「表に条件が
 * 載っているか」ではなく「その関数がその呼び方で載せているか」で決まる。**
 * 検査キューは `cleaning_task` / `room` / `property` を
 * **施設を指定せずに**引く（施設横断の一覧なので `propertyId` を渡さない）。
 * 施設で絞る呼び方だけを検査していると、この呼び方が抜ける。
 *
 * 4 パターンのうち第 4（施設スコープロールが担当外を取得できない）が
 * ここでは特に効く。**`propertyId` を渡さない呼び出しで
 * `scopeToProperties()` が掛かり続けること**が、キューの前提そのもの
 * （`resolveListScope()` が返す範囲と一致していること）。
 */

import { findTaskById, listProperties, listRooms, listTasks } from "@pk/db";

import { describeTenantIsolation } from "./isolation-suite.js";

/** 検査キューが引くタスク。**施設を指定しない**（施設横断のため）。 */
describeTenantIsolation({
  table: "cleaning_task",
  list: (env, ctx) =>
    listTasks(env, ctx, { businessDate: "2026-08-12", status: ["AWAITING_INSPECTION"] }),
  findById: (env, ctx, id) => findTaskById(env, ctx, id),
  entityPrefix: "task",
  propertyColumn: "property_id",
});

/** 客室番号の引き当て。**施設を指定しない全件取得。** */
describeTenantIsolation({
  table: "room",
  list: (env, ctx) => listRooms(env, ctx),
  propertyColumn: "property_id",
});

/** 施設名の引き当て。`property` は施設そのものなので列は `id`。 */
describeTenantIsolation({
  table: "property",
  list: (env, ctx) => listProperties(env, ctx, { isActive: true }),
  propertyColumn: "id",
});
