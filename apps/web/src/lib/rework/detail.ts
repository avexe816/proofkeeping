/**
 * 差戻し 1 件の応答を組み立てる（PK-SPEC-P2 §4.6 / §11.4）。
 *
 * task:  docs/tasks/P2-07.md
 * ルール: .claude/rules/security.md §1
 *
 * ── 2 つの絞りをここに閉じる ─────────────────────────────
 * §4.6 の「清掃者は差戻し項目だけを表示できる」は 2 段で成り立つ。
 *   ① `assertReworkVisible()` … **自分に割り当てられた差戻しか**
 *   ② `reworkVisibleItemIds()` … **不合格かつ再清掃が要る項目だけ**
 * どちらも**サーバー側**（CLAUDE.md §5「フロントの非表示は権限制御と
 * みなさない」）。M-12 は返ってきたものをそのまま並べるだけにしてある。
 *
 * ── 検査者を返さない ────────────────────────────────────
 * `inspection.inspectorId` を応答に載せない。誰が差し戻したかは差戻しの
 * 内容と関係がなく、現場で名前が出ると内容ではなく人への反応になる
 * （§1.2「差戻しは人ではなく項目に紐づける」）。
 */

import type { Rework, ReworkItem } from "@pk/contracts";
import {
  listChecklistItemsByIds,
  listChecklistResults,
  listInspectionItemResults,
  listInspectionPhotos,
  NotFoundError,
  type Env,
  type TenantContext,
} from "@pk/db";
import { reworkVisibleItemIds } from "@pk/engine";

import { signObjectUrl } from "../storage/signedUrl.js";

/** `reworkCycle` の行のうち、応答に使う列。 */
export interface ReworkRow {
  id: string;
  taskId: string;
  propertyId: string;
  inspectionId: string;
  round: number;
  assignedToId: string;
  status: "OPEN" | "IN_PROGRESS" | "RESOLVED" | "WAIVED";
  reasonSummary: string;
  dueAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  waivedReason: string | null;
  waivedIssueId: string | null;
}

/** 応答に要るタスクの情報。 */
export interface ReworkTaskInfo {
  businessDate: string;
  roomNumber: string;
}

/** 行 → 応答。**`waivedById` を返さない**（免除した人の名前を現場に出さない）。 */
export function toRework(row: ReworkRow, task: ReworkTaskInfo): Rework {
  return {
    reworkCycleId: row.id,
    taskId: row.taskId,
    propertyId: row.propertyId,
    roomNumber: task.roomNumber,
    businessDate: task.businessDate,
    round: row.round,
    status: row.status,
    reasonSummary: row.reasonSummary,
    dueAt: row.dueAt?.getTime() ?? null,
    startedAt: row.startedAt?.getTime() ?? null,
    completedAt: row.completedAt?.getTime() ?? null,
    waivedReason: row.waivedReason,
    waivedIssueId: row.waivedIssueId,
  };
}

/**
 * その差戻しを見てよいか（§4.6）。
 *
 * `CLEANER` は**自分に割り当てられた差戻しだけ。** 他人の差戻しへの
 * アクセスは `NotFoundError`（→ 404）。**403 を返さない**（INV-31。
 * 403 は「他人の差戻しが存在する」ことを示唆してしまう）。
 *
 * `CLEANER` 以外（施設責任者・検査担当・監査）は担当施設の範囲で見られる。
 * 絞りは `assertPermission("rework.read")` が施設で掛けている。
 *
 * @throws {NotFoundError} `CLEANER` が自分以外の差戻しを開いたとき。
 */
export function assertReworkVisible(
  ctx: TenantContext,
  row: { assignedToId: string },
  membershipId: string,
): void {
  if (ctx.role !== "CLEANER") return;
  if (row.assignedToId !== membershipId) throw new NotFoundError("RESOURCE_NOT_FOUND");
}

/**
 * 再清掃で直す項目を並べる（§11.4 のワイヤー）。
 *
 * 並びは**清掃時のチェックリストの定義順**（`taskChecklistResult.sortOrder`）。
 * 検査者が触った順で出すと、同じ差戻しでも開くたびに並びが変わる。
 *
 * 検査写真は 15 分有効の署名付き URL（security.md §4）。**`storageKey` を
 * 返さない。**
 */
export async function listReworkItems(
  env: Env,
  ctx: TenantContext,
  row: { inspectionId: string; taskId: string },
  now: Date,
): Promise<ReworkItem[]> {
  const [results, photos, cleaningResults] = await Promise.all([
    listInspectionItemResults(env, ctx, row.inspectionId),
    listInspectionPhotos(env, ctx, row.inspectionId),
    listChecklistResults(env, ctx, row.taskId),
  ]);

  // **差し戻された項目だけ**（§4.6）。engine の純粋関数で絞る。
  const visible = new Set(
    reworkVisibleItemIds(
      results.map((entry) => ({
        checklistItemId: entry.checklistItemId,
        status: entry.status,
        reworkRequired: entry.reworkRequired,
      })),
    ),
  );
  if (visible.size === 0) return [];

  const resultByItem = new Map(results.map((entry) => [entry.checklistItemId, entry]));
  const photosByItemResult = new Map<string, typeof photos>();
  for (const photo of photos) {
    const bucket = photosByItemResult.get(photo.itemResultId);
    if (bucket === undefined) photosByItemResult.set(photo.itemResultId, [photo]);
    else bucket.push(photo);
  }

  // **項目 ID で引く**（`listTemplateItems()` は `templateId` で絞る）。
  const labels = await listChecklistItemsByIds(env, ctx, [...visible]);
  const labelById = new Map(labels.map((item) => [item.id, item]));

  const items: ReworkItem[] = [];
  for (const cleaning of cleaningResults) {
    if (!visible.has(cleaning.itemId)) continue;
    const judged = resultByItem.get(cleaning.itemId);
    if (judged === undefined) continue;

    items.push({
      checklistItemId: cleaning.itemId,
      section: labelById.get(cleaning.itemId)?.section ?? "",
      labels: labelById.get(cleaning.itemId)?.labels ?? {},
      defectCode: judged.defectCode,
      note: judged.note,
      photos: await Promise.all(
        (photosByItemResult.get(judged.id) ?? []).map(async (photo) => ({
          photoId: photo.id,
          url: await signObjectUrl(env.SESSION_SECRET, photo.storageKey, now),
        })),
      ),
      sortOrder: cleaning.sortOrder,
    });
  }
  return items;
}
