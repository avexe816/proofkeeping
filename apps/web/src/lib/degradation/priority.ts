/**
 * 縮退運転の優先順位（PK-SPEC-P7 §5.2）。**純粋。**
 *
 * task:  docs/tasks/P7-11.md
 * ルール: CLAUDE.md §4（P7 固有の絶対ルール）
 *
 * ```
 * 優先度  機能                       障害時の扱い
 *   1     清掃タスクの参照・開始・完了  何があっても維持する
 *   2     写真アップロード             オフラインキューで吸収
 *   3     検査                        一時的に「検査なし」へフォールバック可
 *   4     客室ボード                   更新頻度を落とす
 *   5     照合バッチ                   遅延して実行
 *   6     PDF 生成                    キューに滞留させる
 *   7     外部連携                    停止して手動 CSV へ
 * ```
 *
 * ── これは新しい機能ではない ────────────────────────────
 * P7 固有の絶対ルールは「**新規機能を追加しない**」。この表は
 * 既に在る仕組み（オフラインキュー・Queue・サーキットブレーカー）が
 * §5.2 のどこに当たるかを**書き留めるためのもの**で、実行時の
 * 分岐を増やさない。**優先度を見て機能を止めるコードを書かないこと。**
 * §5.2 が定めているのは「壊れたときにどこから諦めるか」であって、
 * 「平常時に何かを止める」ではない。
 *
 * ── 何を検証しているか ──────────────────────────────────
 * 完了条件の 2 つは、実装ではなく**性質**として押さえてある。
 *
 *   優先度 1 が障害時も維持される
 *     → `priority.spec.ts` が経路を走査する。開始・完了は
 *       画面から直接 `fetch` せず、必ず送信キューを通ること。
 *     → 参照は `readCachedMyDay()` があり、取得に失敗しても
 *       前回の一覧が出ること。
 *
 *   D1 書き込み失敗時もオフラインキューが吸収する
 *     → `lib/offline/policy.ts` の `verdictOf()` が 5xx を
 *       `RETRY` にし、5 回を超えても**キューから消さない**
 *       （`requiresManualRetry` で保持する）。
 */

/** §5.2 の優先度。**1 がいちばん高い。** */
export const DEGRADATION_PRIORITIES = [1, 2, 3, 4, 5, 6, 7] as const;

export type DegradationPriority = (typeof DEGRADATION_PRIORITIES)[number];

/** 障害時の扱い（§5.2 の 3 列目）。 */
export type DegradationHandling =
  /** 何があっても維持する。**優先度 1 だけ。** */
  | "MAINTAIN"
  /** オフラインキューで吸収する（端末に貯める）。 */
  | "OFFLINE_QUEUE"
  /** 一時的に無しへフォールバックできる。 */
  | "FALLBACK"
  /** 更新頻度を落とす。 */
  | "SLOW_DOWN"
  /** 遅延して実行する（サーバー側のキューに積む）。 */
  | "DEFER"
  /** 停止して手動の代替手段へ。 */
  | "MANUAL";

/** §5.2 の 1 行。 */
export interface DegradationEntry {
  priority: DegradationPriority;
  /** 機能。**i18n キーではない**（画面に出さない。設計の記録）。 */
  feature: string;
  handling: DegradationHandling;
  /** その扱いを実際に担っている仕組み。 */
  mechanism: string;
}

/** §5.2 の表そのもの。**順序も仕様どおり。** */
export const DEGRADATION_TABLE: readonly DegradationEntry[] = [
  {
    priority: 1,
    feature: "清掃タスクの参照・開始・完了",
    handling: "MAINTAIN",
    mechanism: "lib/offline/queue.ts（送信キュー）と lib/offline/myDayCache.ts（参照）",
  },
  {
    priority: 2,
    feature: "写真アップロード",
    handling: "OFFLINE_QUEUE",
    mechanism: "lib/offline/queue.ts の enqueuePhoto()",
  },
  {
    priority: 3,
    feature: "検査",
    handling: "FALLBACK",
    mechanism: "property.inspectionMode（NONE へ落とせる）",
  },
  {
    priority: 4,
    feature: "客室ボード",
    handling: "SLOW_DOWN",
    mechanism: "PropertyBoard（Durable Object）とポーリング間隔",
  },
  {
    priority: 5,
    feature: "照合バッチ",
    handling: "DEFER",
    mechanism: "pk-reconciliation キュー",
  },
  {
    priority: 6,
    feature: "PDF 生成",
    handling: "DEFER",
    mechanism: "pk-pdf-generation キュー",
  },
  {
    priority: 7,
    feature: "外部連携",
    handling: "MANUAL",
    mechanism: "packages/integrations のサーキットブレーカーと CSV 取込",
  },
];

/**
 * 優先度 1 の書き込み経路（§5.2「清掃タスクの参照・開始・完了」）。
 *
 * **末尾の動作名だけを持つ。** タスク ID を含む URL は
 * `/api/v1/tasks/{id}/start` の形なので、前方一致では書けない。
 */
export const PRIORITY_ONE_TASK_ACTIONS = ["start", "pause", "resume", "complete"] as const;

/** 優先度 1 の参照経路（M-02 の一覧。`myDayCache.ts` が引く先）。 */
export const PRIORITY_ONE_READ_PATH = "/api/v1/tasks/my-day";

/**
 * その URL が優先度 1 の書き込みか。
 *
 * **クエリ文字列を落としてから見る。** `?retry=1` のような付加で
 * 判定が外れると、キューを通らない経路ができてしまう。
 */
export function isPriorityOneWrite(url: string): boolean {
  const path = url.split("?")[0] ?? "";
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const action = segments[segments.length - 1];
  if (action === undefined) return false;
  if (!(PRIORITY_ONE_TASK_ACTIONS as readonly string[]).includes(action)) return false;
  // `/api/v1/tasks/{taskId}/{action}` の形だけ。
  return segments.slice(0, 3).join("/") === "api/v1/tasks" && segments.length === 5;
}

/** 障害時に諦めてよいか。**優先度 1 だけが偽。** */
export function mayDegrade(priority: DegradationPriority): boolean {
  return priority !== 1;
}

/** 優先度から扱いを引く。**表に無い優先度は作れない**（型で塞いである）。 */
export function handlingOf(priority: DegradationPriority): DegradationHandling {
  const entry = DEGRADATION_TABLE.find((row) => row.priority === priority);
  // 型の上では必ず在る。`find` の戻りを絞るためだけの分岐。
  if (entry === undefined) throw new Error(`DEGRADATION_ENTRY_MISSING:${String(priority)}`);
  return entry.handling;
}
