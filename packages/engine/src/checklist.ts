/**
 * チェックリストの階層解決と完了判定（PK-SPEC-P1 §6 / §5.3）。**純粋関数。**
 *
 * task: docs/tasks/P1-06.md / docs/tasks/P1-05.md
 */

/** 3 値（PK-IMPL-CONTRACT §2.4 / INV-22）。 */
export const CHECKLIST_VALUE_VALUES = ["DONE", "COULD_NOT", "NOT_APPLICABLE"] as const;

export type ChecklistValueKind = (typeof CHECKLIST_VALUE_VALUES)[number];

/** 階層解決に要るテンプレートの情報。 */
export interface TemplateCandidate {
  id: string;
  /** null = 組織共通。 */
  propertyId: string | null;
  /** null = 全客室タイプ。 */
  roomTypeId: string | null;
  taskType: string;
  isActive: boolean;
}

/** 解決の対象。 */
export interface TemplateScope {
  propertyId: string;
  roomTypeId: string | null;
  taskType: string;
}

/**
 * 3 階層のうち**最も具体的なテンプレートを 1 つ**選ぶ（§6.1）。
 *
 * ```
 * 客室タイプ別（propertyId 一致 かつ roomTypeId 一致） … 3 点
 * 施設別      （propertyId 一致 かつ roomTypeId = null）… 2 点
 * 組織共通    （propertyId = null）                     … 1 点
 * ```
 *
 * **同点が複数あっても例外にしない。** 組織共通テンプレートの重複は
 * SQLite の UNIQUE では弾けない（NULL 同士は別値）ため、現実に起こりうる。
 * 落とすと、その施設の全タスクが生成できなくなる。`id` の昇順で 1 つに
 * 決める（ULID なので「先に作られた方」）。
 *
 * 該当が無ければ `null`。**チェックリストの無いタスクは成立する**
 * （§7 リスク表の「チェックリストが長すぎる ＝ 形骸化」への配慮でもある）。
 */
export function resolveTemplate<T extends TemplateCandidate>(
  candidates: readonly T[],
  scope: TemplateScope,
): T | null {
  let best: { template: T; score: number } | null = null;

  for (const candidate of candidates) {
    if (!candidate.isActive) continue;
    if (candidate.taskType !== scope.taskType) continue;

    let score: number;
    if (candidate.propertyId === null) {
      // 組織共通。roomTypeId を持つ組織共通テンプレートは階層の定義に無いので採らない。
      if (candidate.roomTypeId !== null) continue;
      score = 1;
    } else if (candidate.propertyId !== scope.propertyId) {
      continue;
    } else if (candidate.roomTypeId === null) {
      score = 2;
    } else if (candidate.roomTypeId === scope.roomTypeId) {
      score = 3;
    } else {
      continue;
    }

    if (best === null || score > best.score) {
      best = { template: candidate, score };
      continue;
    }
    if (score === best.score && candidate.id < best.template.id) {
      best = { template: candidate, score };
    }
  }

  return best?.template ?? null;
}

/** 完了判定に使う 1 件の実施結果。 */
export interface ChecklistResultInput {
  itemId: string;
  isRequired: boolean;
  photoRequired: boolean;
  value: ChecklistValueKind | null;
  /** その項目に紐づく写真の枚数。 */
  photoCount: number;
}

/** 完了判定の結果。 */
export interface CompletionCheck {
  ok: boolean;
  /** 必須なのに未記録の項目（§5.3 の `CHECKLIST_INCOMPLETE`）。 */
  incompleteItemIds: string[];
  /** 写真必須なのに写真が無い項目（同 `PHOTO_REQUIRED`）。 */
  missingPhotoItemIds: string[];
}

/**
 * `complete` を通してよいかを判定する（§5.3 の 2 つの MUST）。
 *
 * ── 必須項目の「記録済み」とは ──────────────────────────
 * 3 値のいずれかが入っていること。**`DONE` に限らない。** INV-22 が
 * 3 値を求めているのは「できなかった」を記録として残すためで、
 * `COULD_NOT` を理由に完了を拒むと、清掃員は事実と違う `DONE` を
 * 押すことになる（記録の質が落ちる — INV-01 の背景と同じ）。
 * 未記録（`null`）だけを拒否する。
 *
 * ── 写真必須の判定 ──────────────────────────────────────
 * `NOT_APPLICABLE` の項目には写真を求めない。該当しない設備の写真は
 * 撮れない。
 */
export function checkCompletion(results: readonly ChecklistResultInput[]): CompletionCheck {
  const incompleteItemIds: string[] = [];
  const missingPhotoItemIds: string[] = [];

  for (const result of results) {
    if (result.isRequired && result.value === null) {
      incompleteItemIds.push(result.itemId);
      continue;
    }
    if (result.photoRequired && result.value !== "NOT_APPLICABLE" && result.photoCount === 0) {
      missingPhotoItemIds.push(result.itemId);
    }
  }

  return {
    ok: incompleteItemIds.length === 0 && missingPhotoItemIds.length === 0,
    incompleteItemIds,
    missingPhotoItemIds,
  };
}

/**
 * 進捗（分子 / 分母）。**分母から `NOT_APPLICABLE` を除く**（§2.4）。
 *
 * 「該当なし」を分母に残すと、達成しようのない分数が画面に出る。
 */
export function checklistProgress(results: readonly ChecklistResultInput[]): {
  done: number;
  total: number;
} {
  let done = 0;
  let total = 0;
  for (const result of results) {
    if (result.value === "NOT_APPLICABLE") continue;
    total += 1;
    if (result.value === "DONE") done += 1;
  }
  return { done, total };
}
