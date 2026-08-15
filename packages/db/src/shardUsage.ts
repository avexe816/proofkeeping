/**
 * シャードの使用率と警告レベル（PK-SPEC-P7 §4.3 / P7-06）。
 *
 * task: docs/tasks/P7-06.md
 * ルール: .claude/rules/architecture.md §1
 *
 * ```
 * 監視項目（シャードごと）:
 *   - データベースサイズ（10GB に対する使用率）
 *   - 1 日の書き込み行数
 *   - 平均クエリ時間
 *   - テナント数
 *
 * 警告閾値:
 *   使用率 60% → 情報
 *   使用率 75% → 警告。アーカイブの実行を検討
 *   使用率 85% → 緊急。テナント移送またはアーカイブを実行
 * ```
 *
 * ── ここに Workers の型を持ち込まない ───────────────────
 * **`scripts/shard-usage.ts`（node が直接起動する CLI）が import する。**
 * `D1Database` を参照すると、node 側の tsconfig が Workers の型を持たない
 * ため型検査が落ちる。D1 を触る収集側は `shardUsageCollector.ts` に分けた。
 *
 * ── これは運用者向けであってテナント向けではない ────────
 * CLAUDE.md §4 は「**シャード番号を URL・レスポンス・ログに露出しない**」と
 * 定める。守っているのは**テナントに見せない**ことで、運用者に対しては
 * 別で、architecture.md §6 も migration が「シャード番号を出力」すると
 * 書いている。
 *
 * そのためこのモジュールは**シャード番号を持つ値を返す**が、
 * **テナント向けの API・画面から呼ばないこと。** 呼び出し側は
 * `scripts/shard-usage.ts`（運用者の CLI）だけ。`/api/health` が
 * 「番号を持たない。件数だけ」（`health.ts`）にしてあるのと対になっている。
 * ダッシュボードとしてどこに出すかは docs/OPEN_QUESTIONS.md #095。
 *
 * ── 取れない値を 0 で埋めない ───────────────────────────
 * D1 が `PRAGMA page_count` を通すかは環境による。通らなければ
 * `sizeBytes` は `null`（「取得できていません」）で、**0 にしない。**
 * 0 にすると「空のシャード」と区別できず、使用率 0% の緑として出てしまう。
 */

/** D1 1 本の上限（§4.3 の「10GB に対する使用率」）。 */
export const SHARD_CAPACITY_BYTES = 10 * 1024 * 1024 * 1024;

/**
 * 警告レベル（§4.3）。**並びは軽い順。**
 *
 * `unknown` は「使用率が取れていない」。**`ok` と混ぜない。**
 * 取れていないことを緑として出すと、いちばん危ない状態
 * （測れていないまま埋まっていく）が見えなくなる。
 */
export const SHARD_USAGE_LEVELS = ["unknown", "ok", "info", "warning", "critical"] as const;

export type ShardUsageLevel = (typeof SHARD_USAGE_LEVELS)[number];

/** §4.3 の閾値。**比（0〜1）で持つ。** */
export const SHARD_USAGE_INFO_RATIO = 0.6;
export const SHARD_USAGE_WARNING_RATIO = 0.75;
export const SHARD_USAGE_CRITICAL_RATIO = 0.85;

/**
 * 使用率から警告レベルを決める（§4.3）。**純粋関数。**
 *
 * 境界は**その値を含む。** 60% ちょうどは `info`、85% ちょうどは `critical`。
 * 「60% を超えたら」ではなく「60% → 情報」と書かれているため、
 * 到達した時点で上げる（危ない側へ倒す）。
 *
 * @param ratio 0〜1。取れていなければ `null`。
 */
export function shardUsageLevelOf(ratio: number | null): ShardUsageLevel {
  if (ratio === null || !Number.isFinite(ratio)) return "unknown";
  if (ratio >= SHARD_USAGE_CRITICAL_RATIO) return "critical";
  if (ratio >= SHARD_USAGE_WARNING_RATIO) return "warning";
  if (ratio >= SHARD_USAGE_INFO_RATIO) return "info";
  return "ok";
}

/** そのレベルで運用者が動くべきか（§4.3 の「実行を検討」「実行」）。 */
export function needsAction(level: ShardUsageLevel): boolean {
  return level === "warning" || level === "critical";
}

/** いちばん重いレベルを選ぶ。**`unknown` は `ok` より重い扱い。** */
export function worstLevelOf(levels: readonly ShardUsageLevel[]): ShardUsageLevel {
  let worst: ShardUsageLevel = "ok";
  for (const level of levels) {
    if (SHARD_USAGE_LEVELS.indexOf(level) > SHARD_USAGE_LEVELS.indexOf(worst)) worst = level;
  }
  // 1 本も無ければ「測れていない」。
  return levels.length === 0 ? "unknown" : worst;
}

/** 使用率を「12.3%」の形へ。**取れていなければ `—`。** */
export function formatUsageRatio(ratio: number | null): string {
  return ratio === null ? "—" : `${(ratio * 100).toFixed(1)}%`;
}

/** バイト数を「1.2 GB」の形へ。**取れていなければ `—`。** */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
