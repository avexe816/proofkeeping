/**
 * チェックリストのテンプレート・項目・実施結果のリポジトリ。
 *
 * task: docs/tasks/P1-06.md
 * 仕様: docs/PK-SPEC-P1.md §6
 *
 * ── テンプレートは施設列が null を取りうる ──────────────
 * 組織共通テンプレート（`propertyId = null`）は施設で絞れない。
 * `withTenantScope()` に `checklistTemplate.propertyId` を渡すと、
 * 施設スコープロールから組織共通テンプレートが**見えなくなる**
 * （`inArray(null, [...])` は真にならない）。清掃員のチェックリストが
 * 空になってしまうため、テンプレートの読み取りは組織条件だけで行い、
 * 施設の絞りは呼び出し側（`resolveTemplate()` の入力を組み立てる側）が持つ。
 * **書き込みは `assertPermission("checklistTemplate.write", ...)` が守る。**
 */

import { and, eq, inArray, isNull, or, type SQL } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant, generateId } from "../id.js";
import { getTenantDb, type TenantContext } from "../router.js";
import {
  checklistItem,
  checklistTemplate,
  taskChecklistResult,
  type ChecklistValue,
} from "../schema/checklist.js";
import type { TaskType } from "../schema/task.js";

import { NO_PROPERTY_SCOPE, withTenantScope } from "./base.js";

/**
 * 施設に効きうるテンプレートを列挙する（組織共通 + その施設）。
 *
 * 階層の解決そのものは `packages/engine` の `resolveTemplate()`。
 * ここは候補を集めるだけ。
 */
export async function listTemplatesForProperty(
  env: Env,
  ctx: TenantContext,
  propertyId: string,
  taskTypes?: readonly TaskType[],
) {
  assertIdBelongsToTenant(propertyId, ctx);
  const db = await getTenantDb(env, ctx);
  const scope: SQL | undefined =
    or(isNull(checklistTemplate.propertyId), eq(checklistTemplate.propertyId, propertyId)) ??
    undefined;
  return db
    .select()
    .from(checklistTemplate)
    .where(
      withTenantScope(
        checklistTemplate,
        ctx,
        NO_PROPERTY_SCOPE,
        scope,
        eq(checklistTemplate.isActive, true),
        taskTypes === undefined || taskTypes.length === 0
          ? undefined
          : inArray(checklistTemplate.taskType, [...taskTypes]),
      ),
    );
}

/** 組織の全テンプレート（W-16 の設定画面）。 */
export async function listTemplates(env: Env, ctx: TenantContext) {
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(checklistTemplate)
    .where(withTenantScope(checklistTemplate, ctx, NO_PROPERTY_SCOPE));
}

/** テンプレートの項目。`sortOrder` の昇順。 */
export async function listTemplateItems(
  env: Env,
  ctx: TenantContext,
  templateIds: readonly string[],
) {
  for (const id of templateIds) assertIdBelongsToTenant(id, ctx);
  if (templateIds.length === 0) return [];

  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(checklistItem)
    .where(
      withTenantScope(
        checklistItem,
        ctx,
        NO_PROPERTY_SCOPE,
        inArray(checklistItem.templateId, [...templateIds]),
      ),
    )
    .orderBy(checklistItem.sortOrder);
}

/** `createTemplate()` の 1 項目。 */
export interface CreateChecklistItemInput {
  section: string;
  labels: Record<string, string>;
  isRequired: boolean;
  photoRequired: boolean;
}

/** `createTemplate()` の入力。 */
export interface CreateTemplateInput {
  propertyId: string | null;
  roomTypeId: string | null;
  taskType: TaskType;
  name: string;
  items: readonly CreateChecklistItemInput[];
}

/**
 * テンプレートを 1 件作る。**項目もまとめて作る。**
 *
 * 版は 1 から始まる。項目を差し替えるときは `replaceTemplateItems()` が
 * 版を上げる。実施済みの記録は `templateVersion` で当時の版に固定される。
 */
export async function createTemplate(
  env: Env,
  ctx: TenantContext,
  input: CreateTemplateInput,
): Promise<string> {
  const db = await getTenantDb(env, ctx);
  const templateId = generateId(ctx.orgShortId, "ctpl");

  await db.insert(checklistTemplate).values({
    id: templateId,
    organizationId: ctx.organizationId,
    propertyId: input.propertyId,
    roomTypeId: input.roomTypeId,
    taskType: input.taskType,
    name: input.name,
    version: 1,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });

  await insertItems(env, ctx, templateId, input.items);
  return templateId;
}

/** 項目を挿入する。**並び順は配列の順序をそのまま使う。** */
async function insertItems(
  env: Env,
  ctx: TenantContext,
  templateId: string,
  items: readonly CreateChecklistItemInput[],
): Promise<void> {
  if (items.length === 0) return;
  const db = await getTenantDb(env, ctx);
  await db.insert(checklistItem).values(
    items.map((item, index) => ({
      id: generateId(ctx.orgShortId, "citm"),
      organizationId: ctx.organizationId,
      templateId,
      section: item.section,
      labels: item.labels,
      isRequired: item.isRequired,
      photoRequired: item.photoRequired,
      sortOrder: index,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })),
  );
}

/**
 * テンプレートの項目を差し替え、版を 1 上げる。
 *
 * **古い項目行を消さない。** 実施済みの `taskChecklistResult.itemId` が
 * 参照しているため、消すと過去の記録が何の項目だったか分からなくなる
 * （§2.2 の「テンプレートのバージョン固定」が守ろうとしているもの）。
 * 差し替えは「新しい項目を足して、テンプレートの版を上げる」で表す。
 * 展開時は**その版で作られた項目だけ**を使う。
 */
export async function replaceTemplateItems(
  env: Env,
  ctx: TenantContext,
  templateId: string,
  input: { name: string; items: readonly CreateChecklistItemInput[] },
): Promise<void> {
  assertIdBelongsToTenant(templateId, ctx);
  const db = await getTenantDb(env, ctx);

  // 旧項目は無効化ではなく「版が上がる」ことで参照されなくなる。
  await db
    .delete(checklistItem)
    .where(
      withTenantScope(
        checklistItem,
        ctx,
        NO_PROPERTY_SCOPE,
        eq(checklistItem.templateId, templateId),
      ),
    );
  await insertItems(env, ctx, templateId, input.items);

  const current = await db
    .select({ version: checklistTemplate.version })
    .from(checklistTemplate)
    .where(
      withTenantScope(
        checklistTemplate,
        ctx,
        NO_PROPERTY_SCOPE,
        eq(checklistTemplate.id, templateId),
      ),
    )
    .limit(1);

  await db
    .update(checklistTemplate)
    .set({ name: input.name, version: (current[0]?.version ?? 1) + 1, updatedAt: ctx.now })
    .where(
      withTenantScope(
        checklistTemplate,
        ctx,
        NO_PROPERTY_SCOPE,
        eq(checklistTemplate.id, templateId),
      ),
    );
}

/** テンプレートを無効化する。**物理削除しない。** */
export async function deactivateTemplate(
  env: Env,
  ctx: TenantContext,
  templateId: string,
): Promise<void> {
  assertIdBelongsToTenant(templateId, ctx);
  const db = await getTenantDb(env, ctx);
  await db
    .update(checklistTemplate)
    .set({ isActive: false, updatedAt: ctx.now })
    .where(
      withTenantScope(
        checklistTemplate,
        ctx,
        NO_PROPERTY_SCOPE,
        eq(checklistTemplate.id, templateId),
      ),
    );
}

/** タスクへ展開する 1 行。 */
export interface ExpandChecklistInput {
  taskId: string;
  propertyId: string;
  templateVersion: number;
  items: readonly {
    itemId: string;
    isRequired: boolean;
    photoRequired: boolean;
  }[];
}

/**
 * テンプレートをタスクへ展開する（§6.1）。
 *
 * 冪等: `(organizationId, taskId, itemId)` の一意制約と
 * `onConflictDoNothing()`。**再生成で 2 回展開しても記録が消えない。**
 * 既に記録済みの結果を上書きしないのが要点（INV-27 と同じ考え方）。
 *
 * SQLite の変数上限に当たらないよう分割して INSERT する。
 */
export async function expandChecklist(
  env: Env,
  ctx: TenantContext,
  inputs: readonly ExpandChecklistInput[],
): Promise<number> {
  const db = await getTenantDb(env, ctx);

  const rows = inputs.flatMap((input) =>
    input.items.map((item, index) => ({
      id: generateId(ctx.orgShortId, "cres"),
      organizationId: ctx.organizationId,
      propertyId: input.propertyId,
      taskId: input.taskId,
      itemId: item.itemId,
      templateVersion: input.templateVersion,
      isRequired: item.isRequired,
      photoRequired: item.photoRequired,
      sortOrder: index,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })),
  );
  if (rows.length === 0) return 0;

  // 1 行 12 列。SQLite の既定上限（999 変数）に収まる塊へ割る。
  const CHUNK = 60;
  let inserted = 0;
  for (let offset = 0; offset < rows.length; offset += CHUNK) {
    const result = await db
      .insert(taskChecklistResult)
      .values(rows.slice(offset, offset + CHUNK))
      .onConflictDoNothing();
    inserted += result.meta.changes;
  }
  return inserted;
}

/** タスク 1 件の実施結果。`sortOrder` の昇順。 */
export async function listChecklistResults(env: Env, ctx: TenantContext, taskId: string) {
  assertIdBelongsToTenant(taskId, ctx);
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(taskChecklistResult)
    .where(
      withTenantScope(
        taskChecklistResult,
        ctx,
        taskChecklistResult.propertyId,
        eq(taskChecklistResult.taskId, taskId),
      ),
    )
    .orderBy(taskChecklistResult.sortOrder);
}

/** `recordChecklistResult()` の入力。 */
export interface RecordChecklistResultInput {
  taskId: string;
  itemId: string;
  value: ChecklistValue;
  reasonCode?: string | undefined;
  /** 記録した `membership.id`。 */
  checkedById: string;
}

/**
 * 実施結果を 1 件記録する。**1 項目ずつ。**
 *
 * 一括更新の関数を作らない。「すべてチェック」を画面から消しても、
 * API にまとめて送れる口があれば同じことができてしまう（§6.3）。
 *
 * @returns 更新できたら `true`。展開されていない項目なら `false`。
 */
export async function recordChecklistResult(
  env: Env,
  ctx: TenantContext,
  input: RecordChecklistResultInput,
): Promise<boolean> {
  assertIdBelongsToTenant(input.taskId, ctx);
  assertIdBelongsToTenant(input.itemId, ctx);
  const db = await getTenantDb(env, ctx);
  const result = await db
    .update(taskChecklistResult)
    .set({
      value: input.value,
      reasonCode: input.reasonCode ?? null,
      checkedAt: ctx.now,
      checkedById: input.checkedById,
      updatedAt: ctx.now,
    })
    .where(
      withTenantScope(
        taskChecklistResult,
        ctx,
        taskChecklistResult.propertyId,
        and(
          eq(taskChecklistResult.taskId, input.taskId),
          eq(taskChecklistResult.itemId, input.itemId),
        ),
      ),
    );
  return result.meta.changes > 0;
}
