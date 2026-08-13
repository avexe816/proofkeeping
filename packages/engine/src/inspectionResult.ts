/**
 * 検査結果の集約（PK-SPEC-P2 §4.3〜§4.5）。**純粋関数。**
 *
 * task: docs/tasks/P2-04.md
 *
 * ── 全体の判定を人が入力しない ──────────────────────────
 * §4.3 の MUST は「1 項目でも FAIL があれば検査全体は FAIL。検査者が
 * 全体だけ PASS に上書きできない」。**そのために全体の判定を受け取る
 * 引数を持たない。** `aggregateResult()` は項目の並びだけから決まる。
 * API のボディに `result` を置かないのも同じ理由（`packages/contracts`）。
 *
 * ── 未選択を PASS とみなさない ──────────────────────────
 * 検査項目は「合格 / 不合格 / 対象外」の 3 値で、**初期値を持たない**
 * （P2 固有の絶対ルール「検査項目を全 PASS で初期化しない」）。
 * したがって「答えていない項目がある検査」は完了できない。
 * 未選択を PASS に倒すと、開始してすぐ完了を押すだけで全項目合格の
 * 記録が作れてしまい、絶対ルールを API 側から回避できる。
 *
 * ── 不合格に必要なもの（§4.3）───────────────────────────
 * `defectCode` / コメント 1〜200 文字 / 写真 1 枚以上。
 * **3 つとも欠けていたら 3 つとも返す。** 直しては拒否される往復を
 * 作らない（`checkCompletion()`（P1-06）と同じ方針）。
 */

/** 項目 1 件の判定（`packages/db` の `INSPECTION_ITEM_STATUSES` と同じ語彙）。 */
export const INSPECTION_ITEM_STATUS_VALUES = ["PASS", "FAIL", "NOT_APPLICABLE"] as const;

export type InspectionItemStatusValue = (typeof INSPECTION_ITEM_STATUS_VALUES)[number];

/** 検査全体の判定（同 `INSPECTION_RESULTS`）。 */
export const INSPECTION_RESULT_VALUES = ["PASS", "FAIL"] as const;

export type InspectionResultValue = (typeof INSPECTION_RESULT_VALUES)[number];

/** 不合格コメントの長さ（§4.3「コメント 1〜200 文字」）。 */
export const DEFECT_NOTE_MIN_LENGTH = 1;
export const DEFECT_NOTE_MAX_LENGTH = 200;

/**
 * 集約の入力 1 件。
 *
 * `status` が `null` の項目は**まだ答えていない**（行が無い場合も
 * 呼び出し側がこの形で並べる）。
 */
export interface InspectionItemInput {
  checklistItemId: string;
  status: InspectionItemStatusValue | null;
  defectCode: string | null;
  note: string | null;
  /** その項目に紐づく検査写真の枚数。 */
  photoCount: number;
}

/**
 * 全体の判定。**1 件でも FAIL があれば FAIL**（§4.3 MUST）。
 *
 * 未選択（`null`）は判定に加えない。加えると「まだ見ていない項目が
 * あるから FAIL」になり、`checkInspectionCompletion()` が返すべき
 * 「答えていない項目がある」という別の話と混ざる。
 */
export function aggregateResult(items: readonly InspectionItemInput[]): InspectionResultValue {
  return items.some((item) => item.status === "FAIL") ? "FAIL" : "PASS";
}

/** FAIL の項目 ID。差戻し（§4.5）が拾う。 */
export function failedItemIds(items: readonly InspectionItemInput[]): string[] {
  return items.filter((item) => item.status === "FAIL").map((item) => item.checklistItemId);
}

/** 再清掃が要る項目があるか。**FAIL の有無と一致する。** */
export function hasFailure(items: readonly InspectionItemInput[]): boolean {
  return items.some((item) => item.status === "FAIL");
}

/** 完了の可否と、足りないものの内訳。 */
export interface InspectionCompletionCheck {
  ok: boolean;
  /** まだ「合格 / 不合格 / 対象外」を選んでいない項目。 */
  unansweredItemIds: string[];
  /** FAIL なのに理由コードが無い項目。 */
  missingDefectCodeItemIds: string[];
  /** FAIL なのにコメントが無い（または長すぎる）項目。 */
  missingNoteItemIds: string[];
  /** FAIL なのに写真が 1 枚も無い項目。 */
  missingPhotoItemIds: string[];
}

/**
 * 検査を完了してよいかを判定する（§4.3）。
 *
 * **項目が 1 件も無い検査は完了できない。** 検査項目は清掃時の
 * `taskChecklistResult` から生成される（§4.3）ので、0 件になるのは
 * 展開に失敗した場合だけ。それを「全項目合格」として通さない。
 */
export function checkInspectionCompletion(
  items: readonly InspectionItemInput[],
): InspectionCompletionCheck {
  const unansweredItemIds: string[] = [];
  const missingDefectCodeItemIds: string[] = [];
  const missingNoteItemIds: string[] = [];
  const missingPhotoItemIds: string[] = [];

  for (const item of items) {
    if (item.status === null) {
      unansweredItemIds.push(item.checklistItemId);
      continue;
    }
    if (item.status !== "FAIL") continue;

    if ((item.defectCode ?? "") === "") missingDefectCodeItemIds.push(item.checklistItemId);

    const note = item.note ?? "";
    if (note.length < DEFECT_NOTE_MIN_LENGTH || note.length > DEFECT_NOTE_MAX_LENGTH) {
      missingNoteItemIds.push(item.checklistItemId);
    }

    if (item.photoCount < 1) missingPhotoItemIds.push(item.checklistItemId);
  }

  const ok =
    items.length > 0 &&
    unansweredItemIds.length === 0 &&
    missingDefectCodeItemIds.length === 0 &&
    missingNoteItemIds.length === 0 &&
    missingPhotoItemIds.length === 0;

  return { ok, unansweredItemIds, missingDefectCodeItemIds, missingNoteItemIds, missingPhotoItemIds };
}

/**
 * 差戻し理由の要約（`reworkCycle.reasonSummary`）。
 *
 * **理由コードを並べるだけ。** 担当者の評価を書かない（§1.3 /
 * `schema/inspection.ts` の注記）。重複は畳み、**最初に現れた順**を保つ
 * （並べ替えると「どの項目から出た理由か」の手がかりが消える）。
 * コメント本文は含めない。要約に個別の文面が混ざると、一覧に出したときに
 * 現場の書きぶりがそのまま比較の材料になる。
 */
export function reasonSummaryOf(items: readonly InspectionItemInput[]): string {
  const codes: string[] = [];
  for (const item of items) {
    if (item.status !== "FAIL") continue;
    const code = item.defectCode ?? "";
    if (code === "" || codes.includes(code)) continue;
    codes.push(code);
  }
  return codes.join(",");
}

/** 自己検査の可否（§4.2 の例外 / security.md §1）。 */
export type SelfInspectionVerdict =
  /** 清掃担当者ではない。通常の検査。 */
  | { kind: "ALLOWED"; selfApproved: false }
  /** 清掃担当者本人だが、施設が許しており理由もある。**監査ログが要る。** */
  | { kind: "ALLOWED"; selfApproved: true }
  /** 清掃担当者本人で、施設が許していない。 */
  | { kind: "FORBIDDEN" }
  /** 清掃担当者本人で、施設は許しているが理由が無い。 */
  | { kind: "REASON_REQUIRED" };

/**
 * 清掃担当者本人が検査してよいか（§4.2 / security.md §1）。
 *
 * 「清掃担当者本人は自分のタスクを検査できない（緊急時の例外は理由必須＋
 * 監査ログ）」を 1 か所に閉じる。**既定は禁止**で、施設が
 * `selfInspectionAllowed` を立てて、かつ理由を書いたときだけ通る。
 *
 * @param cleanerId タスクの担当清掃者（`membership.id`）。未割当なら `null`。
 * @param inspectorId 検査しようとしている者（`membership.id`）。
 */
export function evaluateSelfInspection(
  cleanerId: string | null,
  inspectorId: string,
  selfInspectionAllowed: boolean,
  overrideReason: string | null,
): SelfInspectionVerdict {
  if (cleanerId === null || cleanerId !== inspectorId) {
    return { kind: "ALLOWED", selfApproved: false };
  }
  if (!selfInspectionAllowed) return { kind: "FORBIDDEN" };
  if ((overrideReason ?? "").trim() === "") return { kind: "REASON_REQUIRED" };
  return { kind: "ALLOWED", selfApproved: true };
}

/**
 * 検査にかかった秒数。**負にならない。**
 *
 * 端末の時刻ではなくサーバー時刻の差を使う前提（`clientTs` は参考値）。
 * 同一ミリ秒なら 0 を返す。
 */
export function durationSecondsOf(startedAtMs: number, completedAtMs: number): number {
  return Math.max(0, Math.floor((completedAtMs - startedAtMs) / 1000));
}
