/**
 * 作業時間の集計（PK-SPEC-P1 §2.2）。**純粋関数。**
 *
 * task: docs/tasks/P1-05.md
 *
 * ```
 * actualMinutes = Σ(RESUME/START → PAUSE/COMPLETE の各区間)
 * ```
 *
 * `cleaningTask.actualMinutes` はキャッシュに過ぎず、真実は `taskTimeLog`
 * の並びにある。**中断を 3 回挟んでも正しく計算されること**が P1-05 の
 * 完了条件であり、受け入れ基準（§14.1）でもある。
 *
 * ── 入力の壊れ方に対する方針 ────────────────────────────
 * オフラインキューは同じ操作を再送し、順序も前後しうる（§8.2）。
 * 二重の `START`、`PAUSE` が 2 回続く、`RESUME` から始まる、といった
 * 並びが現実に届く。**例外を投げない。** 記録の集計が落ちると、
 * 完了操作そのものが通らなくなり現場が止まる。
 * 「開いている区間が無いのに閉じるイベントが来たら無視する」
 * 「開いている最中に開くイベントが来たら無視する」で吸収する。
 */

/** 集計に使う 1 件のイベント。`packages/db` の `taskTimeLog` の部分集合。 */
export interface TimeLogEntry {
  event: string;
  /** 発生時刻（Unix epoch ミリ秒）。サーバー時刻。 */
  occurredAt: number;
}

/** 区間を開くイベント。 */
const OPENING: readonly string[] = ["START", "RESUME", "UNBLOCK"];

/** 区間を閉じるイベント。 */
const CLOSING: readonly string[] = ["PAUSE", "COMPLETE", "BLOCK"];

/** 集計結果。 */
export interface ElapsedSummary {
  /** 実作業時間（ミリ秒）。中断中・入室不可中は含まない。 */
  workedMs: number;
  /** 中断回数（`PAUSE` の件数）。PK-IMPL-CONTRACT §2.1 の `pauseCount`。 */
  pauseCount: number;
  /** 最初の `START` の時刻。無ければ `null`。 */
  startedAt: number | null;
  /** 最後の `COMPLETE` の時刻。無ければ `null`。 */
  completedAt: number | null;
  /** 集計時点で区間が開いたままか（作業中）。 */
  isOpen: boolean;
}

/**
 * 時間ログを集計する。**入力の順序に依存しない**（時刻順に並べ直す）。
 *
 * 同時刻のイベントは、開く側より閉じる側を先に見る。オフラインの再送で
 * `PAUSE` と `RESUME` が同一ミリ秒に載った場合、閉じてから開く方が
 * 「区間が二重に開く」より安全（時間を多く数えない方向に倒す）。
 */
export function summarizeTimeLogs(entries: readonly TimeLogEntry[]): ElapsedSummary {
  const sorted = [...entries].sort((a, b) => {
    if (a.occurredAt !== b.occurredAt) return a.occurredAt - b.occurredAt;
    const rank = (event: string): number => (CLOSING.includes(event) ? 0 : 1);
    return rank(a.event) - rank(b.event);
  });

  let workedMs = 0;
  let pauseCount = 0;
  let openedAt: number | null = null;
  let startedAt: number | null = null;
  let completedAt: number | null = null;

  for (const entry of sorted) {
    if (entry.event === "START" && startedAt === null) startedAt = entry.occurredAt;
    if (entry.event === "COMPLETE") completedAt = entry.occurredAt;
    if (entry.event === "PAUSE") pauseCount += 1;

    if (OPENING.includes(entry.event)) {
      // 既に開いていれば無視する。二重の START で区間が入れ子にならない。
      if (openedAt === null) openedAt = entry.occurredAt;
      continue;
    }
    if (CLOSING.includes(entry.event)) {
      if (openedAt === null) continue; // 開いていないのに閉じるイベント。無視。
      // 時刻が巻き戻っている場合も負の値を足さない。
      workedMs += Math.max(0, entry.occurredAt - openedAt);
      openedAt = null;
    }
  }

  return { workedMs, pauseCount, startedAt, completedAt, isOpen: openedAt !== null };
}

/**
 * 実作業時間を分で返す。**四捨五入ではなく切り捨て。**
 *
 * 30 秒の作業を 1 分と数えないため。集計は請求の根拠になりうる（P5）ので、
 * 実測より多い側へ丸めない。
 */
export function actualMinutesOf(entries: readonly TimeLogEntry[]): number {
  return Math.floor(summarizeTimeLogs(entries).workedMs / 60_000);
}
