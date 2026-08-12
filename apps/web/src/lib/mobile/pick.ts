/**
 * 現場画面の施設選択の解決（PK-SPEC-P1 §19.4）。**純粋関数。**
 *
 * task:  docs/tasks/P1-22.md
 * ルール: .claude/rules/ui-writing.md §3
 *
 * ── 選択は絞り込みであって、権限ではない ────────────────
 * ここが決めるのは「どの施設のタスクを画面に出すか」だけ。
 * **到達してよい施設の判定に使わない**（§19.8 / INV-32）。
 * セッションに残った施設 ID が担当から外れていても、一覧に無いぶん
 * 絞り込みが空振りするだけで済む形にしてある（`lib/property/selection.ts`
 * と同じ方針 / DECISIONS #020）。
 *
 * ── 「当日中は再表示しない」の判定 ──────────────────────
 * 選んだ日（`pickedOn`）が当日の業務日と一致する間だけ選択が効く。
 * 業務日で見るのはカレンダー日ではないため。深夜 2 時に働く人にとって
 * 「当日」は前日の業務日で、そこで日付が変わると勤務の途中で
 * 選択画面が出る（architecture.md §7）。
 */

import { needsPropertyPicker } from "@pk/engine";

import type { MobilePick } from "../auth/session.js";

/**
 * 「すべての施設をまとめて表示」（プロトタイプ 03 Q2 の逃げ道）。
 *
 * 施設 ID の形（`{orgShortId}__prop_{ulid}`）と衝突しないので、
 * 同じ欄に置いても取り違えない。
 */
export const ALL_MOBILE_PROPERTIES = "ALL";

/** 一覧を出す前に決まること。 */
export interface PickDecision {
  /** 選択画面（§19.4）へ送るか。 */
  showPicker: boolean;
  /** 一覧を出す業務日。翌日を選んでいれば未来日になる。 */
  businessDate: string;
  /** 一覧に掛ける絞り込み。`null` は全施設（絞らない）。 */
  filterPropertyId: string | null;
  /** タスクを開始できるか。**翌日以降は `false`**（§19.4）。 */
  startable: boolean;
}

/** `decidePick()` の入力。 */
export interface PickInput {
  /** セッションに残っている選択。未選択なら `undefined`。 */
  pick: MobilePick | undefined;
  /** 当日の業務日。 */
  today: string;
  /**
   * 当日の担当施設数（`my-day` の `propertyCount`）。
   *
   * **M-02 の「🏢 N施設を担当」と同じ数。** 割り当てられている施設の数では
   * ない（`propertyPicker.ts` の `needsPropertyPicker()` の注記）。
   */
  todayPropertyCount: number;
  /** 組織設定の閾値（2〜10）。 */
  threshold: number;
}

/**
 * 選択画面のラジオの値（`{businessDate}/{propertyId}`）。
 *
 * **2 つの値を 1 つの入力で運ぶための形。** 業務日を hidden で別に持つと、
 * 選んだ施設と業務日が食い違う組み合わせを送れてしまう
 * （翌日の施設 + 当日の日付 → 開始できてしまう）。
 * 施設 ID に `/` は現れない（`{orgShortId}__prop_{ulid}`）。
 */
export function encodePickValue(businessDate: string, propertyId: string): string {
  return `${businessDate}/${propertyId}`;
}

/** ラジオの値を読む。**形が違えば `null`。** */
export function decodePickValue(
  value: string,
): { businessDate: string; propertyId: string } | null {
  const separator = value.indexOf("/");
  if (separator === -1) return null;
  const businessDate = value.slice(0, separator);
  const propertyId = value.slice(separator + 1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) return null;
  if (propertyId === "") return null;
  return { businessDate, propertyId };
}

/**
 * いまの選択で一覧をどう出すかを決める。
 *
 * | 選択 | 当日の施設数 | 結果 |
 * |---|---|---|
 * | 当日ぶんがある | — | その選択で絞る（画面は出さない） |
 * | 無い・前日のもの | 閾値未満 | 全施設のグループ表示（§19.3） |
 * | 無い・前日のもの | 閾値以上 | 選択画面へ（§19.4） |
 *
 * **選択が無いことは「全施設」と同じ扱い。** 閾値未満の組織では選択画面を
 * 一度も見ないまま使い続けることになるが、それが §19.3 の既定
 * （「施設を切り替える」概念を持たせない / §19.2 MUST）。
 */
export function decidePick(input: PickInput): PickDecision {
  const active = input.pick !== undefined && input.pick.pickedOn === input.today;

  if (!active) {
    return {
      showPicker: needsPropertyPicker(input.todayPropertyCount, input.threshold),
      businessDate: input.today,
      filterPropertyId: null,
      startable: true,
    };
  }

  // `active` が真なら `pick` は存在する。型を絞るために読み直す。
  const pick = input.pick ?? null;
  if (pick === null) {
    return {
      showPicker: false,
      businessDate: input.today,
      filterPropertyId: null,
      startable: true,
    };
  }

  return {
    showPicker: false,
    businessDate: pick.businessDate,
    filterPropertyId: pick.propertyId === ALL_MOBILE_PROPERTIES ? null : pick.propertyId,
    // 未来の業務日は表示のみ（§19.4）。**過去日は選べない**ので、
    // ここは「当日かどうか」の判定で足りる。
    startable: pick.businessDate <= input.today,
  };
}
