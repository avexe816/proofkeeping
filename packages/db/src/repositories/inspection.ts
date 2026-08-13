/**
 * 検査・検査項目・検査写真・差戻しサイクルのリポジトリ（PK-SPEC-P2 §4）。
 *
 * task: docs/tasks/P2-04.md
 * 仕様: docs/PK-SPEC-P2.md §3.2〜§3.4 / §4.2〜§4.5
 *
 * ── この層が判断しないこと ──────────────────────────────
 * 検査全体の判定（`packages/engine` の `aggregateResult()`）、自己検査の
 * 可否（同 `evaluateSelfInspection()`）、権限（`assertPermission()`）、
 * 排他（`InspectionLock`）。ここは**組織条件を必ず載せた読み書き**だけ。
 *
 * ── 更新できるものを絞ってある ──────────────────────────
 * `inspection` に汎用の update を置かない。完了は `completeInspection()`
 * だけが行い、**判定が未確定（`result IS NULL`）の行にしか当たらない。**
 * 一度確定した検査を後から書き換える経路を作らないため（§16.1 の
 * 「差戻し → 再清掃 → 再検査の履歴が欠落なく残る」）。訂正は次のラウンドで行う。
 *
 * ── `evidenceSnapshot` はここに無い ─────────────────────
 * 証跡の書き込みは P2-08。**このファイルに update / delete を書かないこと**
 * （`repositories.spec.ts` がソースを走査して固定している）。
 */

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant, generateId } from "../id.js";
import { chunkIdsForInArray } from "../limits.js";
import { getTenantDb, type TenantContext } from "../router.js";
import {
  inspection,
  inspectionItemResult,
  inspectionPhoto,
  reworkCycle,
  type DefectCode,
  type InspectionItemStatus,
  type InspectionResult,
  type ReworkStatus,
} from "../schema/inspection.js";

import { withTenantScope } from "./base.js";

// ────────────────────────────────────────────────────────────
// 検査（`inspection`）
// ────────────────────────────────────────────────────────────

/** 検査 1 件。越境 ID は DB へ行く前に `NotFoundError`（→ 404）。 */
export async function findInspectionById(env: Env, ctx: TenantContext, inspectionId: string) {
  assertIdBelongsToTenant(inspectionId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(inspection)
    .where(
      withTenantScope(inspection, ctx, inspection.propertyId, eq(inspection.id, inspectionId)),
    )
    .limit(1);
  return rows[0];
}

/**
 * そのタスクの、まだ判定が出ていない検査。
 *
 * **`(taskId, round)` ではなく「未完了」で引く。** 画面の再読み込みや
 * オフラインの再送で「自分が始めた検査に入れない」を作らないため
 * （`InspectionLock` の `acquire()` が同じ検査者の再要求を通すのと対）。
 */
export async function findOpenInspectionByTask(env: Env, ctx: TenantContext, taskId: string) {
  assertIdBelongsToTenant(taskId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(inspection)
    .where(
      withTenantScope(
        inspection,
        ctx,
        inspection.propertyId,
        and(eq(inspection.taskId, taskId), isNull(inspection.result)),
      ),
    )
    .limit(1);
  return rows[0];
}

/** タスク 1 件の検査履歴。**ラウンドの昇順。** */
export async function listInspectionsByTask(env: Env, ctx: TenantContext, taskId: string) {
  assertIdBelongsToTenant(taskId, ctx);
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(inspection)
    .where(withTenantScope(inspection, ctx, inspection.propertyId, eq(inspection.taskId, taskId)))
    .orderBy(inspection.round);
}

/**
 * 複数タスクの検査をまとめて引く（P2-14 の日報 / §9.2）。
 *
 * **`listInspectionsByTask()` を 100 回呼ばないため**にある。日報は
 * 1 施設 1 業務日で 100 室ぶんの明細を作る（§15「100 室で 30 秒以内」）。
 * 1 室ずつ引くと D1 への往復が 100 回になる。
 *
 * **`inspection` は業務日を持たない。** 業務日はタスク側の列なので、
 * 「その日の検査」はタスク ID の並びからしか引けない。
 * ID の並びは D1 の 1 文 100 変数の上限に収まる塊へ割る（`limits.ts`）。
 *
 * 並びは `taskId` → `round` の昇順。**塊をまたぐと崩れるので最後に並べ直す。**
 */
export async function listInspectionsByTaskIds(
  env: Env,
  ctx: TenantContext,
  taskIds: readonly string[],
) {
  if (taskIds.length === 0) return [];
  const db = await getTenantDb(env, ctx);

  const rows: Awaited<ReturnType<typeof selectInspectionsByTaskIds>> = [];
  for (const chunk of chunkIdsForInArray(taskIds)) {
    rows.push(...(await selectInspectionsByTaskIds(db, ctx, chunk)));
  }
  return rows.sort((a, b) => a.taskId.localeCompare(b.taskId) || a.round - b.round);
}

/** `listInspectionsByTaskIds()` の 1 塊ぶん。**組織条件は必ず載る。** */
async function selectInspectionsByTaskIds(
  db: Awaited<ReturnType<typeof getTenantDb>>,
  ctx: TenantContext,
  taskIds: readonly string[],
) {
  return db
    .select()
    .from(inspection)
    .where(
      withTenantScope(inspection, ctx, inspection.propertyId, inArray(inspection.taskId, [
        ...taskIds,
      ])),
    );
}

/**
 * `Idempotency-Key` で 1 件引く（§14.1「全状態変更 API に必須」）。
 *
 * 再送を「何も起きなかった」に倒すために、**書き込みの前に見る。**
 */
export async function findInspectionByIdempotencyKey(
  env: Env,
  ctx: TenantContext,
  idempotencyKey: string,
) {
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(inspection)
    .where(
      withTenantScope(
        inspection,
        ctx,
        inspection.propertyId,
        eq(inspection.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return rows[0];
}

/** `createInspection()` の入力。**`round` は呼び出し側が決める**（§4.2）。 */
export interface CreateInspectionInput {
  taskId: string;
  propertyId: string;
  round: number;
  /** 検査担当者の `membership.id`。 */
  inspectorId: string;
  /** 清掃担当者本人による検査（§4.2 の例外）。**理由が要る。** */
  selfApproved?: boolean | undefined;
  overrideReason?: string | null | undefined;
  clientTs?: Date | null | undefined;
  idempotencyKey?: string | null | undefined;
}

/**
 * 検査を 1 件開始する。
 *
 * 冪等: 一意制約 `(organizationId, taskId, round)` と
 * `onConflictDoNothing()`。**同じラウンドの 2 件目は作られない**
 * （`InspectionLock` は速い断り方であって唯一の防波堤ではない /
 * `durable/InspectionLock.ts` の注記）。
 *
 * @returns 作れたら行。既にあれば `undefined`（呼び出し側が既存を引く）。
 */
export async function createInspection(
  env: Env,
  ctx: TenantContext,
  input: CreateInspectionInput,
): Promise<{ id: string } | undefined> {
  assertIdBelongsToTenant(input.taskId, ctx);
  assertIdBelongsToTenant(input.propertyId, ctx);
  const db = await getTenantDb(env, ctx);

  const id = generateId(ctx.orgShortId, "insp");
  const result = await db
    .insert(inspection)
    .values({
      id,
      organizationId: ctx.organizationId,
      propertyId: input.propertyId,
      taskId: input.taskId,
      round: input.round,
      inspectorId: input.inspectorId,
      result: null,
      startedAt: ctx.now,
      selfApproved: input.selfApproved ?? false,
      overrideReason: input.overrideReason ?? null,
      clientTs: input.clientTs ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      createdAt: ctx.now,
    })
    .onConflictDoNothing();

  return result.meta.changes > 0 ? { id } : undefined;
}

/** `completeInspection()` の入力。**判定は呼び出し側（engine）が集約した値。** */
export interface CompleteInspectionInput {
  result: InspectionResult;
  durationSeconds: number;
  generalNote?: string | null | undefined;
}

/**
 * 検査を確定する。
 *
 * **`result IS NULL` の行にしか当たらない**（楽観的排他）。同じ検査へ
 * 完了が 2 回届いても、2 回目は 0 行更新になる。呼び出し側はそれを
 * 「既に確定していた」として扱い、状態を二重に進めない。
 *
 * @returns 確定できたら `true`。既に確定済み・該当なしなら `false`。
 */
export async function completeInspection(
  env: Env,
  ctx: TenantContext,
  inspectionId: string,
  input: CompleteInspectionInput,
): Promise<boolean> {
  assertIdBelongsToTenant(inspectionId, ctx);
  const db = await getTenantDb(env, ctx);
  const updated = await db
    .update(inspection)
    .set({
      result: input.result,
      completedAt: ctx.now,
      durationSeconds: input.durationSeconds,
      ...(input.generalNote === undefined ? {} : { generalNote: input.generalNote }),
    })
    .where(
      withTenantScope(
        inspection,
        ctx,
        inspection.propertyId,
        and(eq(inspection.id, inspectionId), isNull(inspection.result)),
      ),
    );
  return updated.meta.changes > 0;
}

// ────────────────────────────────────────────────────────────
// 検査項目（`inspectionItemResult`）
// ────────────────────────────────────────────────────────────

/** 検査 1 件の項目。**記録した順**（`createdAt` 昇順）。 */
export async function listInspectionItemResults(
  env: Env,
  ctx: TenantContext,
  inspectionId: string,
) {
  assertIdBelongsToTenant(inspectionId, ctx);
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(inspectionItemResult)
    .where(
      withTenantScope(
        inspectionItemResult,
        ctx,
        inspectionItemResult.propertyId,
        eq(inspectionItemResult.inspectionId, inspectionId),
      ),
    )
    .orderBy(inspectionItemResult.createdAt);
}

/** 項目 1 件（写真のアップロード先を解決するために引く）。 */
export async function findInspectionItemResultById(
  env: Env,
  ctx: TenantContext,
  itemResultId: string,
) {
  assertIdBelongsToTenant(itemResultId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(inspectionItemResult)
    .where(
      withTenantScope(
        inspectionItemResult,
        ctx,
        inspectionItemResult.propertyId,
        eq(inspectionItemResult.id, itemResultId),
      ),
    )
    .limit(1);
  return rows[0];
}

/** `recordInspectionItemResult()` の入力。**1 項目ずつ。** */
export interface RecordInspectionItemResultInput {
  inspectionId: string;
  propertyId: string;
  checklistItemId: string;
  status: InspectionItemStatus;
  defectCode?: DefectCode | null | undefined;
  note?: string | null | undefined;
  reworkRequired?: boolean | undefined;
}

/**
 * 検査項目の判定を 1 件記録する。
 *
 * **一括更新の関数を作らない。** 配列を受ける口があれば「全項目 PASS」を
 * 1 回で送れてしまい、P2 固有の絶対ルール（全 PASS 初期化の禁止・
 * 「全て合格」ボタンの禁止）が API 側から素通りになる。
 * `recordChecklistResult()`（P1-06 / §6.3）と同じ方針。
 *
 * 冪等: 一意制約 `(organizationId, inspectionId, checklistItemId)` に対する
 * upsert。**選び直しは同じ行を書き換える**（検査中の訂正は履歴に残さない。
 * 残すのは確定した検査結果のほう）。
 *
 * @returns 記録した行の `id`。
 */
export async function recordInspectionItemResult(
  env: Env,
  ctx: TenantContext,
  input: RecordInspectionItemResultInput,
): Promise<string> {
  assertIdBelongsToTenant(input.inspectionId, ctx);
  assertIdBelongsToTenant(input.checklistItemId, ctx);
  assertIdBelongsToTenant(input.propertyId, ctx);
  const db = await getTenantDb(env, ctx);

  const id = generateId(ctx.orgShortId, "ires");
  // **PASS / 対象外に選び直したら理由コードとコメントを消す。** 残すと
  // 「合格なのに理由コードがある」行ができ、§10.1 の理由別集計が狂う。
  const cleared = input.status === "FAIL";
  const values = {
    status: input.status,
    defectCode: cleared ? (input.defectCode ?? null) : null,
    note: cleared ? (input.note ?? null) : null,
    reworkRequired: cleared ? (input.reworkRequired ?? true) : false,
    updatedAt: ctx.now,
  };

  await db
    .insert(inspectionItemResult)
    .values({
      id,
      organizationId: ctx.organizationId,
      propertyId: input.propertyId,
      inspectionId: input.inspectionId,
      checklistItemId: input.checklistItemId,
      ...values,
      createdAt: ctx.now,
    })
    .onConflictDoUpdate({
      target: [
        inspectionItemResult.organizationId,
        inspectionItemResult.inspectionId,
        inspectionItemResult.checklistItemId,
      ],
      set: values,
    });

  const saved = await db
    .select({ id: inspectionItemResult.id })
    .from(inspectionItemResult)
    .where(
      withTenantScope(
        inspectionItemResult,
        ctx,
        inspectionItemResult.propertyId,
        and(
          eq(inspectionItemResult.inspectionId, input.inspectionId),
          eq(inspectionItemResult.checklistItemId, input.checklistItemId),
        ),
      ),
    )
    .limit(1);
  return saved[0]?.id ?? id;
}

// ────────────────────────────────────────────────────────────
// 検査写真（`inspectionPhoto`）
// ────────────────────────────────────────────────────────────

/** 検査 1 件の写真を項目ごとに数える（FAIL の写真必須判定 / §4.3）。 */
export async function countInspectionPhotosByItem(
  env: Env,
  ctx: TenantContext,
  inspectionId: string,
): Promise<Map<string, number>> {
  assertIdBelongsToTenant(inspectionId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select({ itemResultId: inspectionPhoto.itemResultId, count: sql<number>`count(*)` })
    .from(inspectionPhoto)
    .where(
      withTenantScope(
        inspectionPhoto,
        ctx,
        inspectionPhoto.propertyId,
        eq(inspectionPhoto.inspectionId, inspectionId),
      ),
    )
    .groupBy(inspectionPhoto.itemResultId);
  return new Map(rows.map((row) => [row.itemResultId, row.count]));
}

/** `clientId` で 1 件引く（再送で R2 へ二重書き込みしないため）。 */
export async function findInspectionPhotoByClientId(
  env: Env,
  ctx: TenantContext,
  clientId: string,
) {
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(inspectionPhoto)
    .where(
      withTenantScope(
        inspectionPhoto,
        ctx,
        inspectionPhoto.propertyId,
        eq(inspectionPhoto.clientId, clientId),
      ),
    )
    .limit(1);
  return rows[0];
}

/** 検査 1 件の写真（証跡・画面表示）。**アップロード順。** */
export async function listInspectionPhotos(env: Env, ctx: TenantContext, inspectionId: string) {
  assertIdBelongsToTenant(inspectionId, ctx);
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(inspectionPhoto)
    .where(
      withTenantScope(
        inspectionPhoto,
        ctx,
        inspectionPhoto.propertyId,
        eq(inspectionPhoto.inspectionId, inspectionId),
      ),
    )
    .orderBy(inspectionPhoto.uploadedAt);
}

/** `createInspectionPhoto()` の入力。**位置情報の項目を持たない**（INV-11）。 */
export interface CreateInspectionPhotoInput {
  inspectionId: string;
  itemResultId: string;
  propertyId: string;
  /** R2 のキー。採番済みの `photoId` を含む。 */
  storageKey: string;
  /** `storageKey` に埋めた `photoId`。 */
  photoId: string;
  /** バイナリの SHA-256（§6.3）。**サーバーが計算した値。** */
  sha256: string;
  width: number;
  height: number;
  fileSize: number;
  clientId: string;
  /** アップロードした `membership.id`。 */
  uploadedById: string;
}

/** `createInspectionPhoto()` の結果。**再送は「既にあった」を返す。** */
export interface CreateInspectionPhotoResult {
  created: boolean;
  row: NonNullable<Awaited<ReturnType<typeof findInspectionPhotoByClientId>>>;
}

/**
 * 検査写真のメタデータを 1 件作る。
 *
 * 冪等: `(organizationId, clientId)` の一意制約に任せる。
 * **R2 への書き込みより後に呼ぶこと**（`createTaskPhoto()` と同じ理由）。
 */
export async function createInspectionPhoto(
  env: Env,
  ctx: TenantContext,
  input: CreateInspectionPhotoInput,
): Promise<CreateInspectionPhotoResult | undefined> {
  assertIdBelongsToTenant(input.inspectionId, ctx);
  assertIdBelongsToTenant(input.itemResultId, ctx);
  const db = await getTenantDb(env, ctx);

  const result = await db
    .insert(inspectionPhoto)
    .values({
      id: input.photoId,
      organizationId: ctx.organizationId,
      propertyId: input.propertyId,
      inspectionId: input.inspectionId,
      itemResultId: input.itemResultId,
      storageKey: input.storageKey,
      sha256: input.sha256,
      width: input.width,
      height: input.height,
      fileSize: input.fileSize,
      // **サーバー時刻**（PK-IMPL-CONTRACT §2.5）。EXIF の撮影時刻は
      // クライアントの再エンコードで消えており、端末の時計も信用しない。
      capturedAt: ctx.now,
      uploadedAt: ctx.now,
      uploadedById: input.uploadedById,
      clientId: input.clientId,
    })
    .onConflictDoNothing();

  const row = await findInspectionPhotoByClientId(env, ctx, input.clientId);
  if (row === undefined) return undefined;
  return { created: result.meta.changes > 0, row };
}

/** 新しい検査写真の ID。**`storageKey` に埋めるので事前に要る。** */
export function newInspectionPhotoId(ctx: TenantContext): string {
  return generateId(ctx.orgShortId, "ipho");
}

// ────────────────────────────────────────────────────────────
// 差戻しサイクル（`reworkCycle`）
// ────────────────────────────────────────────────────────────

/** `createReworkCycle()` の入力。 */
export interface CreateReworkCycleInput {
  taskId: string;
  propertyId: string;
  inspectionId: string;
  round: number;
  /** 再清掃の担当者。**既定は元の清掃担当者**（§3.4）。 */
  assignedToId: string;
  /** 理由コードを連ねた文字列。**担当者の評価ではない**（§1.3）。 */
  reasonSummary: string;
  dueAt?: Date | null | undefined;
}

/**
 * 差戻しサイクルを 1 件作る（§4.5）。
 *
 * 冪等: 一意制約 `(organizationId, taskId, round)` と `onConflictDoNothing()`。
 * **同じラウンドで 2 件目は作られない。** 再清掃の開始・完了・免除は P2-07。
 *
 * @returns 作れたら行の `id`。既にあれば `undefined`。
 */
export async function createReworkCycle(
  env: Env,
  ctx: TenantContext,
  input: CreateReworkCycleInput,
): Promise<{ id: string } | undefined> {
  assertIdBelongsToTenant(input.taskId, ctx);
  assertIdBelongsToTenant(input.inspectionId, ctx);
  const db = await getTenantDb(env, ctx);

  const id = generateId(ctx.orgShortId, "rwk");
  const result = await db
    .insert(reworkCycle)
    .values({
      id,
      organizationId: ctx.organizationId,
      propertyId: input.propertyId,
      taskId: input.taskId,
      inspectionId: input.inspectionId,
      round: input.round,
      assignedToId: input.assignedToId,
      status: "OPEN",
      reasonSummary: input.reasonSummary,
      dueAt: input.dueAt ?? null,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .onConflictDoNothing();

  return result.meta.changes > 0 ? { id } : undefined;
}

/** タスク 1 件の差戻し履歴。**ラウンドの昇順。** M-12（P2-07）が読む。 */
export async function listReworkCyclesByTask(env: Env, ctx: TenantContext, taskId: string) {
  assertIdBelongsToTenant(taskId, ctx);
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(reworkCycle)
    .where(withTenantScope(reworkCycle, ctx, reworkCycle.propertyId, eq(reworkCycle.taskId, taskId)))
    .orderBy(reworkCycle.round);
}

/**
 * 複数タスクの差戻しをまとめて引く（P2-14 の日報 / §9.2 の「再清掃」列）。
 *
 * 理由と分割は `listInspectionsByTaskIds()` と同じ。
 * 並びは `taskId` → `round` の昇順。
 */
export async function listReworkCyclesByTaskIds(
  env: Env,
  ctx: TenantContext,
  taskIds: readonly string[],
) {
  if (taskIds.length === 0) return [];
  const db = await getTenantDb(env, ctx);

  const rows: Awaited<ReturnType<typeof selectReworkCyclesByTaskIds>> = [];
  for (const chunk of chunkIdsForInArray(taskIds)) {
    rows.push(...(await selectReworkCyclesByTaskIds(db, ctx, chunk)));
  }
  return rows.sort((a, b) => a.taskId.localeCompare(b.taskId) || a.round - b.round);
}

/** `listReworkCyclesByTaskIds()` の 1 塊ぶん。**組織条件は必ず載る。** */
async function selectReworkCyclesByTaskIds(
  db: Awaited<ReturnType<typeof getTenantDb>>,
  ctx: TenantContext,
  taskIds: readonly string[],
) {
  return db
    .select()
    .from(reworkCycle)
    .where(
      withTenantScope(reworkCycle, ctx, reworkCycle.propertyId, inArray(reworkCycle.taskId, [
        ...taskIds,
      ])),
    );
}

/** 差戻し 1 件。越境 ID は DB へ行く前に `NotFoundError`（→ 404）。 */
export async function findReworkCycleById(env: Env, ctx: TenantContext, reworkCycleId: string) {
  assertIdBelongsToTenant(reworkCycleId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(reworkCycle)
    .where(
      withTenantScope(reworkCycle, ctx, reworkCycle.propertyId, eq(reworkCycle.id, reworkCycleId)),
    )
    .limit(1);
  return rows[0];
}

/**
 * そのタスクの、まだ決着していない差戻し（`OPEN` / `IN_PROGRESS`）。
 *
 * **M-12 は `taskId` で開く。** 清掃者は差戻しの ID を知らない（M-02 から
 * 部屋を押して入る）。ラウンドで引かないのは `findOpenInspectionByTask()` と
 * 同じ理由で、再読み込みや再送で「自分に来た差戻しに入れない」を作らないため。
 *
 * 一意制約 `(taskId, round)` があるので、未決着は最大 1 件になる
 * （前のラウンドは再清掃完了時に `RESOLVED` へ動く）。**万一 2 件あれば
 * ラウンドの大きいほうを返す**（新しい差戻しを先に片付ける）。
 */
export async function findOpenReworkCycleByTask(env: Env, ctx: TenantContext, taskId: string) {
  assertIdBelongsToTenant(taskId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(reworkCycle)
    .where(
      withTenantScope(
        reworkCycle,
        ctx,
        reworkCycle.propertyId,
        and(eq(reworkCycle.taskId, taskId), inArray(reworkCycle.status, ["OPEN", "IN_PROGRESS"])),
      ),
    )
    .orderBy(desc(reworkCycle.round))
    .limit(1);
  return rows[0];
}

/** `advanceReworkCycle()` の入力。**状態は呼び出し側（engine）が決めた値。** */
export interface AdvanceReworkCycleInput {
  /** 遷移前の状態。**この状態の行にしか当たらない**（楽観的排他）。 */
  from: ReworkStatus;
  to: ReworkStatus;
  /** `start` で入れる。 */
  startedAt?: Date | null | undefined;
  /** `complete` で入れる。 */
  completedAt?: Date | null | undefined;
  /** `waive` の 3 点（§4.7。**理由と関連 Issue は必須**）。 */
  waivedById?: string | null | undefined;
  waivedReason?: string | null | undefined;
  waivedIssueId?: string | null | undefined;
}

/**
 * 差戻しの状態を 1 段進める（§4.6 / §4.7）。
 *
 * **`status = from` の行にしか当たらない。** 同じ操作が 2 回届いても
 * 2 回目は 0 行更新になり、呼び出し側は「既に進んでいた」として扱う
 * （`completeInspection()` と同じ形）。
 *
 * 差戻しを**削除しない**。免除も `status = WAIVED` で表す
 * （`schema/inspection.ts`「行を消さない。免除したという事実が証跡に要る」）。
 *
 * @returns 進めたら `true`。既に進んでいた・該当なしなら `false`。
 */
export async function advanceReworkCycle(
  env: Env,
  ctx: TenantContext,
  reworkCycleId: string,
  input: AdvanceReworkCycleInput,
): Promise<boolean> {
  assertIdBelongsToTenant(reworkCycleId, ctx);
  const db = await getTenantDb(env, ctx);
  const updated = await db
    .update(reworkCycle)
    .set({
      status: input.to,
      ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
      ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt }),
      ...(input.waivedById === undefined ? {} : { waivedById: input.waivedById }),
      ...(input.waivedReason === undefined ? {} : { waivedReason: input.waivedReason }),
      ...(input.waivedIssueId === undefined ? {} : { waivedIssueId: input.waivedIssueId }),
      updatedAt: ctx.now,
    })
    .where(
      withTenantScope(
        reworkCycle,
        ctx,
        reworkCycle.propertyId,
        and(eq(reworkCycle.id, reworkCycleId), eq(reworkCycle.status, input.from)),
      ),
    );
  return updated.meta.changes > 0;
}
