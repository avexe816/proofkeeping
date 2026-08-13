/**
 * 証跡タイムラインの組み立て（PK-SPEC-P2 §12.3）。**純粋関数。**
 *
 * task: docs/tasks/P2-09.md
 *
 * ── payload から組み立てない ────────────────────────────
 * 証跡の `payload` は**正規化された文字列として保存されている値**で、
 * ハッシュの再計算にだけ使う（`lib/evidence/verify.ts`）。ここを
 * `JSON.parse` して画面を組むと、
 *   ① 画面の都合で payload の形を変えたくなる（＝過去の証跡が壊れる）
 *   ② parse → 再表示の過程が「証跡を読んだ」ように見えてしまう
 * の 2 つが起きる。**タイムラインは `taskTimeLog` / `inspection` /
 * `reworkCycle` という業務の記録から組む。** 証跡はその横に
 * ハッシュだけを並べる（§12.2 の表示順で 8 番目）。
 *
 * ── 出来事に「誰が」は持つが「速さ」は持たない ──────────
 * §1.3 / security.md §5。各行は担当者の `membership.id` を持つが、
 * **所要時間・遅延・他人との比較を持たない。** 経過は開始と完了の
 * 時刻から読む人が読めばよく、ここで差を計算して並べると
 * 「誰が何分掛かったか」の一覧に育つ。
 *
 * ── 並びが決定的であること ──────────────────────────────
 * 同一ミリ秒の出来事がありうる（検査完了と差戻しの作成は同じ操作の中で
 * 書かれる）。時刻だけで並べると実行のたびに順序が変わり、画面の
 * スクリーンショットと突き合わせられない。`KIND_RANK` で第 2 鍵を固定する。
 */

/** タイムラインに出る出来事の種別。**§12.3 の例に現れるものが全て。** */
export const TIMELINE_KINDS = [
  "CLEANING_START",
  "CLEANING_PAUSE",
  "CLEANING_RESUME",
  "CLEANING_COMPLETE",
  "TASK_BLOCK",
  "TASK_UNBLOCK",
  "INSPECTION_START",
  "INSPECTION_PASS",
  "INSPECTION_FAIL",
  "REWORK_START",
  "REWORK_COMPLETE",
  "REWORK_WAIVED",
] as const;

export type TimelineKind = (typeof TIMELINE_KINDS)[number];

/**
 * 同一ミリ秒のときの第 2 鍵。**小さいほど先。**
 *
 * 「検査不合格 → 再清掃開始」のように因果のある組を、時刻が並んだ場合でも
 * 因果の順に出す。`TIMELINE_KINDS` の並びをそのまま使う。
 */
const KIND_RANK = new Map<TimelineKind, number>(
  TIMELINE_KINDS.map((kind, index) => [kind, index]),
);

/** 時間ログ 1 行（`packages/db` の `taskTimeLog`）。 */
export interface TimelineTimeLogInput {
  event: "START" | "PAUSE" | "RESUME" | "COMPLETE" | "BLOCK" | "UNBLOCK";
  atMs: number;
  /** 中断・入室不可の理由コード。**自由記述ではない。** */
  reasonCode: string | null;
  /** 操作した `membership.id`。 */
  actorId: string | null;
}

/** 検査 1 件（`inspection`）。**完了前の行も渡してよい。** */
export interface TimelineInspectionInput {
  inspectionId: string;
  round: number;
  inspectorId: string;
  /** 完了までは `null`。 */
  result: "PASS" | "FAIL" | null;
  startedAtMs: number;
  completedAtMs: number | null;
}

/** 差戻し 1 件（`reworkCycle`）。 */
export interface TimelineReworkInput {
  reworkCycleId: string;
  round: number;
  assignedToId: string;
  status: "OPEN" | "IN_PROGRESS" | "RESOLVED" | "WAIVED";
  startedAtMs: number | null;
  completedAtMs: number | null;
  /**
   * 免除した時刻。
   *
   * **`reworkCycle` に免除時刻の列が無い**（§3.4 のモデルに無く、P2-07 も
   * 足していない）。呼び出し側は `status === "WAIVED"` のとき `updatedAt` を
   * 渡す。列を足す task が現れたらここへ本来の値が来る。
   */
  waivedAtMs: number | null;
}

/** タイムラインの入力。 */
export interface EvidenceTimelineInput {
  timeLogs: readonly TimelineTimeLogInput[];
  inspections: readonly TimelineInspectionInput[];
  reworkCycles: readonly TimelineReworkInput[];
}

/** タイムラインの 1 行。**文言を持たない。** 画面が i18n キーへ写す。 */
export interface TimelineEntry {
  atMs: number;
  kind: TimelineKind;
  /** 操作した `membership.id`。分からない行は `null`。 */
  actorId: string | null;
  /** 検査・差戻しのラウンド。清掃の行は `null`。 */
  round: number | null;
  /** 中断・入室不可の理由コード。**自由記述を載せない。** */
  reasonCode: string | null;
}

/** 時間ログの `event` → タイムラインの種別。 */
const KIND_BY_TIME_EVENT: Readonly<Record<TimelineTimeLogInput["event"], TimelineKind>> = {
  START: "CLEANING_START",
  PAUSE: "CLEANING_PAUSE",
  RESUME: "CLEANING_RESUME",
  COMPLETE: "CLEANING_COMPLETE",
  BLOCK: "TASK_BLOCK",
  UNBLOCK: "TASK_UNBLOCK",
};

/**
 * §12.3 のタイムラインを組む。
 *
 * **入力の並びに依存しない。** どの順で渡しても同じ結果になる
 * （時刻 → 種別 → 種別内の安定順 の 3 段で決まる）。
 *
 * 完了していない検査は `INSPECTION_START` だけを出す。**判定の行を
 * 先回りして出さない**（「検査中」を「合格見込み」と読ませない）。
 */
export function buildEvidenceTimeline(input: EvidenceTimelineInput): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  for (const log of input.timeLogs) {
    entries.push({
      atMs: log.atMs,
      kind: KIND_BY_TIME_EVENT[log.event],
      actorId: log.actorId,
      round: null,
      reasonCode: log.reasonCode,
    });
  }

  for (const inspection of input.inspections) {
    entries.push({
      atMs: inspection.startedAtMs,
      kind: "INSPECTION_START",
      actorId: inspection.inspectorId,
      round: inspection.round,
      reasonCode: null,
    });
    // **完了時刻と判定の両方が揃った行だけ**が結果の行を持つ。
    // 片方だけの行（異常終了した検査）は開始だけが残る。
    if (inspection.completedAtMs === null || inspection.result === null) continue;
    entries.push({
      atMs: inspection.completedAtMs,
      kind: inspection.result === "PASS" ? "INSPECTION_PASS" : "INSPECTION_FAIL",
      actorId: inspection.inspectorId,
      round: inspection.round,
      reasonCode: null,
    });
  }

  for (const rework of input.reworkCycles) {
    // **差戻しの「作成」を行にしていない。** 作成は検査不合格と同じ操作で、
    // `INSPECTION_FAIL` が既にその時刻を持つ。2 行に分けると同じ出来事が
    // 二重に並ぶ。
    if (rework.startedAtMs !== null) {
      entries.push({
        atMs: rework.startedAtMs,
        kind: "REWORK_START",
        actorId: rework.assignedToId,
        round: rework.round,
        reasonCode: null,
      });
    }
    if (rework.status === "RESOLVED" && rework.completedAtMs !== null) {
      entries.push({
        atMs: rework.completedAtMs,
        kind: "REWORK_COMPLETE",
        actorId: rework.assignedToId,
        round: rework.round,
        reasonCode: null,
      });
    }
    if (rework.status === "WAIVED" && rework.waivedAtMs !== null) {
      // 免除した本人は `waivedById` だが、**この行の主体は差戻しの担当者**に
      // 揃えていない。免除は担当者の作業ではないので `actorId` は `null` にし、
      // 「誰が免除したか」は §12.2 の差戻しの節（画面）で出す。
      entries.push({
        atMs: rework.waivedAtMs,
        kind: "REWORK_WAIVED",
        actorId: null,
        round: rework.round,
        reasonCode: null,
      });
    }
  }

  return sortTimeline(entries);
}

/**
 * 時刻 → 種別 → 元の並び で安定に並べる。
 *
 * `Array#sort` は仕様上は安定だが、**第 3 の鍵を明示しておく。**
 * 入力の順（DB の返す順）に暗黙に依存すると、リポジトリの `orderBy` を
 * 変えた瞬間に画面の並びが変わる。
 */
function sortTimeline(entries: readonly TimelineEntry[]): TimelineEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      if (a.entry.atMs !== b.entry.atMs) return a.entry.atMs - b.entry.atMs;
      const rankA = KIND_RANK.get(a.entry.kind) ?? 0;
      const rankB = KIND_RANK.get(b.entry.kind) ?? 0;
      if (rankA !== rankB) return rankA - rankB;
      return a.index - b.index;
    })
    .map((wrapped) => wrapped.entry);
}
