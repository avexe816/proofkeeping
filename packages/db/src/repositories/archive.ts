/**
 * 年次アーカイブの記録（`archiveManifest`）のリポジトリ
 * （PK-SPEC-P0 §19.7 / P7-08）。
 *
 * task: docs/tasks/P7-08.md
 *
 * ── 「削除」と言わない ──────────────────────────────────
 * P7 固有の絶対ルール:「アーカイブを『削除』と表現しない。『退避』と
 * 表現する。」**この層に `delete` を含む関数名を置かない。**
 * 退避した行を D1 から外す操作は `removeArchivedRows()` ではなく
 * **退避側の task が別に持つ**（P7-08 の消費側）。
 *
 * ── 記録は消さない ──────────────────────────────────────
 * `archiveManifest` の行を消す関数が無い。**R2 に写しがある限り、
 * その事実は残る。** 復元（P7-09）がこの表を起点に R2 を引く。
 */

import { and, asc, desc, eq, gte, lt } from "drizzle-orm";

import type { Env } from "../env.js";
import { generateId } from "../id.js";
import { getTenantDb, type TenantContext } from "../router.js";
import { isDirectlyArchivable, type DirectlyArchivableTable } from "../archivePolicy.js";
import { occupancySnapshot, physicalSignal } from "../schema/reconciliation.js";
import { linenRecord, roomObservation } from "../schema/observation.js";
import { archiveManifest } from "../schema/integration.js";
import { cleaningTask } from "../schema/task.js";

import { NO_PROPERTY_SCOPE, withTenantScope } from "./base.js";

/** `recordArchiveManifest()` の入力。 */
export interface RecordArchiveManifestInput {
  year: number;
  /** `ARCHIVABLE_TABLES` の値（`archivePolicy.ts`）。 */
  tableName: string;
  objectKey: string;
  rowCount: number;
  /** 圧縮前の JSONL の SHA-256（16 進）。 */
  sha256: string;
  sizeBytes: number;
  /** 退避した業務日の上限（この日より前を退避した）。 */
  cutoffBusinessDate: string;
}

/**
 * 退避の記録を残す（§19.7 の手順 2）。
 *
 * 冪等。**同じ年・同じ表を 2 回退避しても行は 1 つ**（`uq_archive_manifest`）。
 * 2 回目は上書きで、`sha256` と `rowCount` が新しい退避のものになる。
 * **上書きしてよい理由**: R2 のオブジェクトも同じキーへ上書きされるので、
 * 古いハッシュを残すと「R2 にあるものと合わない記録」になる。
 */
export async function recordArchiveManifest(
  env: Env,
  ctx: TenantContext,
  input: RecordArchiveManifestInput,
): Promise<void> {
  const db = await getTenantDb(env, ctx);
  const values = {
    objectKey: input.objectKey,
    rowCount: input.rowCount,
    sha256: input.sha256,
    sizeBytes: input.sizeBytes,
    cutoffBusinessDate: input.cutoffBusinessDate,
    archivedAt: ctx.now,
  };

  const updated = await db
    .update(archiveManifest)
    .set(values)
    .where(
      withTenantScope(
        archiveManifest,
        ctx,
        NO_PROPERTY_SCOPE,
        and(eq(archiveManifest.year, input.year), eq(archiveManifest.tableName, input.tableName)),
      ),
    );
  if (updated.meta.changes > 0) return;

  await db
    .insert(archiveManifest)
    .values({
      id: generateId(ctx.orgShortId, "arcm"),
      organizationId: ctx.organizationId,
      year: input.year,
      tableName: input.tableName,
      ...values,
    })
    // 先に UPDATE を試し、0 行のときだけここへ来る。その隙間で別の実行が
    // INSERT していても `uq_archive_manifest` が効いて行は 1 つのまま。
    .onConflictDoUpdate({
      target: [archiveManifest.organizationId, archiveManifest.year, archiveManifest.tableName],
      set: values,
    });
}

/** `listArchiveManifests()` の絞り込み。 */
export interface ArchiveManifestFilter {
  year?: number | undefined;
  tableName?: string | undefined;
}

/**
 * 退避の記録の一覧（P7-09 の復元画面が読む）。**新しい順。**
 */
export async function listArchiveManifests(
  env: Env,
  ctx: TenantContext,
  filter: ArchiveManifestFilter = {},
) {
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(archiveManifest)
    .where(
      withTenantScope(
        archiveManifest,
        ctx,
        NO_PROPERTY_SCOPE,
        filter.year === undefined ? undefined : eq(archiveManifest.year, filter.year),
        filter.tableName === undefined
          ? undefined
          : eq(archiveManifest.tableName, filter.tableName),
      ),
    )
    .orderBy(desc(archiveManifest.year), archiveManifest.tableName, archiveManifest.id);
}


/**
 * 退避する行を読む（§19.7 の手順 1）。
 *
 * **`businessDate` を自分で持つ表だけ**（`archivePolicy.ts` の
 * `DIRECTLY_ARCHIVABLE_TABLES`）。持たない表は親を辿る必要があり、
 * その辿り方が仕様に無い（docs/OPEN_QUESTIONS.md #096）。
 *
 * ── 並びを `id` で固定する ──────────────────────────────
 * **並びが変わるとハッシュが変わる。** 同じ年を 2 回退避したときに
 * `sha256` が一致しないと、「中身が変わったのか並びが変わったのか」を
 * 区別できなくなる（testing.md §4 の冪等）。
 *
 * ── 上限を掛ける ────────────────────────────────────────
 * 1 回で読む行数に上限を置く。**Workers のメモリに全件を載せない。**
 * 超える規模の組織は年を分けて実行する（`ARCHIVE_ROW_LIMIT` を
 * 超えた場合、呼び出し側が `rowCount` から気づける）。
 */
export const ARCHIVE_ROW_LIMIT = 50_000;

/** 表ごとの実体と業務日の列。**ここに無い表は読めない。** */
const ARCHIVE_SOURCES = {
  cleaning_task: { table: cleaningTask, businessDate: cleaningTask.businessDate, id: cleaningTask.id },
  room_observation: {
    table: roomObservation,
    businessDate: roomObservation.businessDate,
    id: roomObservation.id,
  },
  linen_record: { table: linenRecord, businessDate: linenRecord.businessDate, id: linenRecord.id },
  occupancy_snapshot: {
    table: occupancySnapshot,
    businessDate: occupancySnapshot.businessDate,
    id: occupancySnapshot.id,
  },
  physical_signal: {
    table: physicalSignal,
    businessDate: physicalSignal.businessDate,
    id: physicalSignal.id,
  },
} as const;

/**
 * 退避する行を読む。
 *
 * `from` は含み、`to` は**含まない**（`archiveCutoffBusinessDate()` が
 * 返す境界は「この日より前」なので）。
 */
export async function listArchiveTableRows(
  env: Env,
  ctx: TenantContext,
  params: { table: DirectlyArchivableTable; from: string; to: string },
): Promise<unknown[]> {
  if (!isDirectlyArchivable(params.table)) return [];
  const source = ARCHIVE_SOURCES[params.table];

  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(source.table)
    .where(
      withTenantScope(
        source.table,
        ctx,
        NO_PROPERTY_SCOPE,
        gte(source.businessDate, params.from),
        lt(source.businessDate, params.to),
      ),
    )
    .orderBy(asc(source.id))
    .limit(ARCHIVE_ROW_LIMIT);
}
