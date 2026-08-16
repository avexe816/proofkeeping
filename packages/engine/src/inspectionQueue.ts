/**
 * 検査待ちの並び順（PK-SPEC-P2 §5.2 / §5.3 / §11.2）。**純粋関数。**
 *
 * task: docs/tasks/P2-05.md
 *
 * ── §11.2 の 4 段 ───────────────────────────────────────
 *   1. チェックインまで 30 分未満（**緊急**）
 *   2. SLA 超過（`inspectionSlaMinutes` を超えて未着手）
 *   3. 再検査（差戻しから戻ってきた 2 回目以降）
 *   4. 完了時刻の古い順
 *
 * 1〜3 は「どの束に入るか」で、4 は束の中の並び。**段を跨いだ入れ替えを
 * しない。** SLA を 40 分超えていても、チェックイン 20 分前の部屋より
 * 上には出ない（客が入る部屋のほうが締切が硬い）。
 *
 * ── 色は 2 つだけ ───────────────────────────────────────
 * `URGENT`（チェックイン期限）と `OVER_SLA`（§5.2 の「オレンジ表示」）。
 * **待ち時間の長さで赤にしない。** ui-writing.md §3 が禁じているのは
 * 「経過時間超過の赤色表示」で、これは人の作業の遅さを責める色。
 * `URGENT` が赤でよいのは、締切が人ではなく**客の到着**だから。
 *
 * ── ここに時計を持ち込まない ────────────────────────────
 * 現在時刻は引数で受け取る（CLAUDE.md §5）。
 */

/** 「緊急」とみなすチェックインまでの残り時間（§5.3）。 */
export const INSPECTION_URGENT_CHECKIN_MINUTES = 30;

/** 表示の強さ。**この 3 つしか無い。** */
export const INSPECTION_QUEUE_TONES = ["URGENT", "OVER_SLA", "NORMAL"] as const;

export type InspectionQueueTone = (typeof INSPECTION_QUEUE_TONES)[number];

/** 並べ替えの入力 1 件。**担当者名を持たせない**（INV-06 / §11.2）。 */
export interface WaitingInspection {
  taskId: string;
  roomNumber: string;
  /**
   * 清掃が完了した時刻（epoch ミリ秒）。**待ち時間の起点。**
   * 記録が無ければ `null`（待ち時間 0 として扱い、最後尾へ回す）。
   */
  completedAtMs: number | null;
  /**
   * 当日チェックインの予定時刻（epoch ミリ秒）。**無ければ `null`。**
   *
   * P2-05 の時点で**この値を持つ列がまだ無い**（OPEN_QUESTIONS #045）。
   * 呼び出し側は `null` を渡す。列ができたら差すだけで第 1 段が効く。
   */
  checkInAtMs: number | null;
  /** 直前までに終えた検査の回数。1 以上なら再検査（§11.2 の第 3 段）。 */
  completedRounds: number;
}

/** 並べ替えの結果 1 件。表示に要る値を添える。 */
export interface QueuedInspection extends WaitingInspection {
  tone: InspectionQueueTone;
  /** 清掃完了からの経過（分）。**負にならない。** */
  waitedMinutes: number;
  /** チェックインまでの残り（分）。予定が無ければ `null`。過ぎていれば負。 */
  minutesToCheckIn: number | null;
  /** 再検査か（`completedRounds >= 1`）。 */
  isRecheck: boolean;
  /** SLA を超えて未着手か（§5.2）。 */
  isOverSla: boolean;
}

/** 束の番号。小さいほど上（§11.2 の 1〜3 段 + 残り）。 */
function bucketOf(entry: QueuedInspection): number {
  if (entry.tone === "URGENT") return 0;
  if (entry.isOverSla) return 1;
  if (entry.isRecheck) return 2;
  return 3;
}

/** 1 件ぶんの表示状態を決める。 */
export function waitStateOf(
  entry: WaitingInspection,
  nowMs: number,
  slaMinutes: number,
): QueuedInspection {
  const waitedMinutes =
    entry.completedAtMs === null
      ? 0
      : Math.max(0, Math.floor((nowMs - entry.completedAtMs) / 60_000));

  const minutesToCheckIn =
    entry.checkInAtMs === null ? null : Math.floor((entry.checkInAtMs - nowMs) / 60_000);

  // **チェックインを過ぎていても緊急のまま。** 客が既に着いている部屋を
  // 「期限切れだから後回し」にはしない。
  const isUrgent = minutesToCheckIn !== null && minutesToCheckIn < INSPECTION_URGENT_CHECKIN_MINUTES;

  // SLA は「超えて未着手」（§5.2）。**0 以下の設定は無効**として扱う
  // （0 分にすると全件が超過になり、印が意味を失う）。
  const isOverSla = slaMinutes > 0 && waitedMinutes > slaMinutes;

  return {
    ...entry,
    tone: isUrgent ? "URGENT" : isOverSla ? "OVER_SLA" : "NORMAL",
    waitedMinutes,
    minutesToCheckIn,
    isRecheck: entry.completedRounds >= 1,
    isOverSla,
  };
}

/**
 * §11.2 の並び順そのもの。`Array#sort` の比較関数。
 *
 * **`slaMinutes` を引数に取らない。** 受け取るのは `waitStateOf()` を
 * 通したあとの値で、SLA の判定（`isOverSla`）は既に済んでいる。
 * これが効くのは**施設をまたぐ一覧**（P7-18 の検査キュー）で、
 * 施設ごとに `inspectionSlaMinutes` が違っても、各件を自分の施設の
 * SLA で評価してから 1 本に並べられる。SLA を引数に持つ
 * `sortInspectionQueue()` では、施設が混じった配列を正しく並べられない。
 */
export function compareInspectionQueue(a: QueuedInspection, b: QueuedInspection): number {
  const bucket = bucketOf(a) - bucketOf(b);
  if (bucket !== 0) return bucket;

  // 緊急の束はチェックインが近い順。**待ち時間より締切を優先する。**
  if (a.tone === "URGENT" && b.tone === "URGENT") {
    const left = a.minutesToCheckIn ?? Number.MAX_SAFE_INTEGER;
    const right = b.minutesToCheckIn ?? Number.MAX_SAFE_INTEGER;
    if (left !== right) return left - right;
  }

  // 完了時刻の古い順。**未記録は最後**（並びを不定にしない）。
  const left = a.completedAtMs ?? Number.MAX_SAFE_INTEGER;
  const right = b.completedAtMs ?? Number.MAX_SAFE_INTEGER;
  if (left !== right) return left - right;

  // 最後は客室番号。**同着を安定させるため**（並びが毎回変わると
  // 30 秒ごとの自動更新で行が飛ぶ）。
  return a.roomNumber.localeCompare(b.roomNumber, "en");
}

/**
 * 検査待ちを §11.2 の順に並べる。
 *
 * **入力を書き換えない。** 新しい配列を返す。
 * 同じ束の中は「完了時刻の古い順」で、完了時刻が無い件は最後。
 *
 * **施設 1 件ぶんの一覧に使う**（`slaMinutes` が全件に掛かるため）。
 * 施設をまたぐ一覧は `waitStateOf()` を施設ごとの SLA で掛けてから
 * `compareInspectionQueue()` で並べること。
 */
export function sortInspectionQueue(
  entries: readonly WaitingInspection[],
  nowMs: number,
  slaMinutes: number,
): QueuedInspection[] {
  return entries
    .map((entry) => waitStateOf(entry, nowMs, slaMinutes))
    .sort(compareInspectionQueue);
}

/** 件数の内訳（見出しに出す）。 */
export interface InspectionQueueSummary {
  total: number;
  urgent: number;
  overSla: number;
  recheck: number;
}

/** 内訳を数える。**個人別には数えない**（INV-07）。 */
export function summarizeInspectionQueue(
  entries: readonly QueuedInspection[],
): InspectionQueueSummary {
  return {
    total: entries.length,
    urgent: entries.filter((entry) => entry.tone === "URGENT").length,
    overSla: entries.filter((entry) => entry.isOverSla).length,
    recheck: entries.filter((entry) => entry.isRecheck).length,
  };
}
