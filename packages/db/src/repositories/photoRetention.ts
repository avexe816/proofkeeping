/**
 * 写真の保持期限（PK-SPEC-P7 §4.5 / security.md §4 / P7-10）のリポジトリ。
 *
 * task:  docs/tasks/P7-10.md
 * ルール: .claude/rules/security.md §4
 *
 * ── 消す順序を守る ──────────────────────────────────────
 * **D1 の行を先に消し、R2 の実体を後に消す。**
 * 逆にすると、途中で落ちたときに**行が実体の無い写真を指す**状態が残り、
 * 画面には出るのに開けない写真ができる。行を先に消せば、残るのは
 * 参照されない R2 オブジェクト（費用だけの問題）で、後から掃除できる。
 * `lib/offline/queue.ts` の `dropItem()` と同じ向き（INV-27）。
 *
 * **その順序を強制するのはこの層ではなく消費側**（`consumers/photoRetention.ts`）。
 * ここは D1 の読み書きだけを持つ。
 *
 * ── 「退避」ではない ────────────────────────────────────
 * §19.7 のアーカイブと違い、**写しを作らずに消す。** だから
 * `delete` という名前をそのまま使う。P7 固有の絶対ルールが言い換えを
 * 求めているのは退避（R2 に写しが残るもの）のほうで、ここではない。
 */

import { asc, inArray, lt } from "drizzle-orm";

import type { Env } from "../env.js";
import { getTenantDb, type TenantContext } from "../router.js";
import { inspectionPhoto } from "../schema/inspection.js";
import { issuePhoto, lostItemPhoto } from "../schema/report.js";
import { taskPhoto } from "../schema/task.js";

import { NO_PROPERTY_SCOPE, withTenantScope } from "./base.js";

/**
 * 写真を持つ 4 表（security.md §4）。
 *
 * **ここに無い表の写真は消えない。** 表が増えたときに書き足し忘れると
 * 「消えずに残る」＝取り返しのつく側に倒れる。
 */
const PHOTO_SOURCES = {
  task_photo: {
    table: taskPhoto,
    id: taskPhoto.id,
    storageKey: taskPhoto.storageKey,
    uploadedAt: taskPhoto.uploadedAt,
  },
  inspection_photo: {
    table: inspectionPhoto,
    id: inspectionPhoto.id,
    storageKey: inspectionPhoto.storageKey,
    uploadedAt: inspectionPhoto.uploadedAt,
  },
  issue_photo: {
    table: issuePhoto,
    id: issuePhoto.id,
    storageKey: issuePhoto.storageKey,
    uploadedAt: issuePhoto.uploadedAt,
  },
  lost_item_photo: {
    table: lostItemPhoto,
    id: lostItemPhoto.id,
    storageKey: lostItemPhoto.storageKey,
    uploadedAt: lostItemPhoto.uploadedAt,
  },
} as const;

/** 写真を持つ表の名前。 */
export type PhotoSourceTable = keyof typeof PHOTO_SOURCES;

/** 期限が関わる写真 1 枚。**画像そのものは読まない。** */
export interface ExpiringPhoto {
  table: PhotoSourceTable;
  id: string;
  /** R2 のキー。**消す実体の在りか。** */
  storageKey: string;
  uploadedAtMs: number;
}

/**
 * 指定の時刻より前にアップロードされた写真を読む。
 *
 * `before` は**含まない**（`lib/photo/retention.ts` の境界の向きに合わせる）。
 * 並びは `uploaded_at` 昇順。**古いものから消す**ので、上限で打ち切っても
 * 「いちばん古いものが残り続ける」ことにならない。
 */
export async function listPhotosUploadedBefore(
  env: Env,
  ctx: TenantContext,
  params: { table: PhotoSourceTable; beforeMs: number; limit: number },
): Promise<ExpiringPhoto[]> {
  const source = PHOTO_SOURCES[params.table];
  const db = await getTenantDb(env, ctx);

  const rows = await db
    .select({
      id: source.id,
      storageKey: source.storageKey,
      uploadedAt: source.uploadedAt,
    })
    .from(source.table)
    .where(
      withTenantScope(
        source.table,
        ctx,
        NO_PROPERTY_SCOPE,
        lt(source.uploadedAt, new Date(params.beforeMs)),
      ),
    )
    .orderBy(asc(source.uploadedAt), asc(source.id))
    .limit(params.limit);

  return rows.map((row) => ({
    table: params.table,
    id: row.id,
    storageKey: row.storageKey,
    uploadedAtMs: row.uploadedAt.getTime(),
  }));
}

/**
 * 写真の行を消す（§4.5 の日次バッチ）。
 *
 * **R2 の実体はここでは触らない。** 順序（行 → 実体）は消費側が持つ。
 *
 * @returns 実際に消えた行数。
 */
export async function deletePhotoRows(
  env: Env,
  ctx: TenantContext,
  params: { table: PhotoSourceTable; ids: readonly string[] },
): Promise<number> {
  if (params.ids.length === 0) return 0;
  const source = PHOTO_SOURCES[params.table];
  const db = await getTenantDb(env, ctx);

  const result = await db
    .delete(source.table)
    .where(
      withTenantScope(
        source.table,
        ctx,
        NO_PROPERTY_SCOPE,
        inArray(source.id, [...params.ids]),
      ),
    );

  return result.meta.changes;
}
