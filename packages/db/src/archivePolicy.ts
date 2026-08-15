/**
 * 年次アーカイブの対象と除外（PK-SPEC-P0 §19.7 / P7-08）。**純粋。**
 *
 * task: docs/tasks/P7-08.md
 * ルール: .claude/rules/architecture.md / .claude/rules/billing.md §2
 *
 * ```
 * 対象: businessDate が 13 か月以上前のレコード
 *   - cleaningTask / taskTimeLog / taskChecklistResult
 *   - inspection / inspectionItemResult
 *   - roomObservation / linenRecord
 *   - occupancySnapshot / physicalSignal
 *
 * 除外（アーカイブしない）:
 *   - evidenceSnapshot のハッシュ行（payload は元から R2）
 *   - auditLog（別途 5 年保持）
 *   - invoice / receipt（法定保存期間に従う）
 *   - organization / property / room などマスタ
 * ```
 *
 * ── 「削除」と言わない ──────────────────────────────────
 * P7 固有の絶対ルール:「**アーカイブを『削除』と表現しない。『退避』と
 * 表現する。**」関数名・ログ・UI 文言すべてに掛かる。ここに `delete` を
 * 含む名前を置かないこと（`archivePolicy.spec.ts` が走査する）。
 *
 * ── 既定は「退避しない」側（いちばん大事な設計）───────────
 * 完了条件の「**除外対象（証跡ハッシュ・監査ログ・帳票・マスタ）が
 * 守られる**」を、**表の一覧を手で書いた条件分岐では守れない。**
 * 表が増えるたびに書き足す必要があり、書き忘れたら
 * **法定保存期間のある帳票が R2 へ出て D1 から消える。**
 *
 * そこで向きを逆にした。**明示的に「退避してよい」と書いた表だけが
 * 対象**で、知らない表はすべて除外へ落ちる。書き忘れは
 * 「退避されずに D1 に残る」＝**シャードが減らないだけ**で、
 * 取り返しのつく側に倒れる（`base.ts` の `ORG_WIDE_ROLES` と同じ向き）。
 *
 * ── 除外の理由を型で持つ ────────────────────────────────
 * 「なぜ除外なのか」を文字列で持たせてある。運用者が
 * 「この表はいつ消えるのか」を追えるようにするためで、
 * **理由の無い除外を作らせない**（`EXCLUSION_REASONS` に無い理由は書けない）。
 */

/** 退避の対象になる表（§19.7 の「対象」）。**ここに無い表は退避しない。** */
export const ARCHIVABLE_TABLES = [
  "cleaning_task",
  "task_time_log",
  "task_checklist_result",
  "inspection",
  "inspection_item_result",
  "room_observation",
  "linen_record",
  "occupancy_snapshot",
  "physical_signal",
] as const;

export type ArchivableTable = (typeof ARCHIVABLE_TABLES)[number];

/**
 * **いま実際に退避できる表**（`businessDate` 列を自分で持つもの）。
 *
 * ── §19.7 の 9 表のうち 5 表しかない ────────────────────
 * §19.7 は「`businessDate` が 13 か月以上前のレコード」を対象と定めるが、
 * **`task_time_log` / `task_checklist_result` / `inspection` /
 * `inspection_item_result` の 4 表は `businessDate` 列を持たない。**
 * 親（`cleaning_task` / `inspection`）を辿らないと業務日が決まらず、
 * その辿り方は仕様に書かれていない（docs/OPEN_QUESTIONS.md #096）。
 *
 * **退避する表を減らす方向は安全側。** 退避されなかった行は D1 に
 * 残るだけで、失われない。逆に業務日の解決を推測で書くと、
 * **まだ新しい行を退避して D1 から外す**恐れがある。
 */
export const DIRECTLY_ARCHIVABLE_TABLES = [
  "cleaning_task",
  "room_observation",
  "linen_record",
  "occupancy_snapshot",
  "physical_signal",
] as const;

export type DirectlyArchivableTable = (typeof DIRECTLY_ARCHIVABLE_TABLES)[number];

/** 自分で `businessDate` を持つ表か。**持たない表はいま退避できない。** */
export function isDirectlyArchivable(table: string): table is DirectlyArchivableTable {
  return (DIRECTLY_ARCHIVABLE_TABLES as readonly string[]).includes(table);
}

/**
 * 除外の理由（§19.7 の「除外」）。
 *
 * **`UNLISTED` を用意してあるのが要点。** §19.7 が名指ししていない表は
 * すべてここへ落ちる。「まだ検討していない」と「検討して除外した」を
 * 区別できるようにしてある。
 */
export const EXCLUSION_REASONS = {
  /** 証跡のハッシュ行。payload は元から R2 にある（§19.7）。 */
  EVIDENCE_HASH: "証跡のハッシュ行。payload は元から R2 にある",
  /** 監査ログ。別途 5 年保持（§19.7 / security.md §6）。 */
  AUDIT_LOG: "監査ログ。別途 5 年保持",
  /** 発行済み帳票。法定保存期間に従う（§19.7 / billing.md §2）。 */
  LEGAL_RETENTION: "発行済み帳票。法定保存期間に従う",
  /** マスタ。業務日を持たず、古くならない（§19.7）。 */
  MASTER_DATA: "マスタ。業務日を持たない",
  /** §19.7 が名指ししていない。**既定はこれ。** */
  UNLISTED: "§19.7 の対象に挙がっていない",
} as const;

export type ExclusionReason = keyof typeof EXCLUSION_REASONS;

/**
 * 名指しで除外した表と、その理由。
 *
 * **ここに書いていない表も除外される**（`UNLISTED`）。この表は
 * 「なぜ除外なのかを説明できる」ものだけを載せる。運用者が
 * 「請求書はいつ消えるのか」と聞かれたときに答えられるようにするため。
 */
export const EXPLICIT_EXCLUSIONS: Readonly<Record<string, ExclusionReason>> = {
  evidence_snapshot: "EVIDENCE_HASH",
  audit_log: "AUDIT_LOG",
  invoice: "LEGAL_RETENTION",
  invoice_line: "LEGAL_RETENTION",
  invoice_tax_summary: "LEGAL_RETENTION",
  receipt: "LEGAL_RETENTION",
  document_delivery: "LEGAL_RETENTION",
  daily_report: "LEGAL_RETENTION",
  organization: "MASTER_DATA",
  property: "MASTER_DATA",
  room: "MASTER_DATA",
  room_type: "MASTER_DATA",
  building: "MASTER_DATA",
  floor: "MASTER_DATA",
  user: "MASTER_DATA",
  membership: "MASTER_DATA",
};

/** 退避してよい表か。**知らない表は偽**（既定は退避しない）。 */
export function isArchivable(table: string): boolean {
  return (ARCHIVABLE_TABLES as readonly string[]).includes(table);
}

/**
 * 退避しない理由。**退避してよい表なら `null`。**
 *
 * 名指しの除外に無ければ `UNLISTED`。
 */
export function exclusionReasonOf(table: string): ExclusionReason | null {
  if (isArchivable(table)) return null;
  return EXPLICIT_EXCLUSIONS[table] ?? "UNLISTED";
}

/** 退避の下限（§19.7 の「13 か月以上前」）。 */
export const ARCHIVE_RETENTION_MONTHS = 13;

/**
 * この業務日より前が退避の対象、という境界を返す（`YYYY-MM-DD`）。
 *
 * **境界そのものは対象に含めない。** 「13 か月以上前」なので、
 * ちょうど 13 か月前の業務日は**残す**側に倒す（1 日ぶん多く残る方が、
 * 1 日ぶん多く消えるより安全）。
 *
 * **`Date.now()` を呼ばない。** 現在時刻は引数で受ける
 * （`packages/engine` と同じ作法 / CLAUDE.md §5）。
 */
export function archiveCutoffBusinessDate(now: Date): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();
  // **月の加減算は `Date` に任せる。** 3/31 の 13 か月前のような
  // 月末の繰り上がりを自前で書かない。
  const cutoff = new Date(Date.UTC(year, month - ARCHIVE_RETENTION_MONTHS, day));
  return cutoff.toISOString().slice(0, 10);
}

/**
 * R2 のキー（§19.7 の `archive/{orgId}/{year}/{table}.jsonl.gz`）。
 *
 * **組織 ID をそのまま使う。** 自己記述 ID（`{orgShortId}__org_{ulid}`）で
 * 一意なので、シャード番号は要らない（**キーに載せてはならない** /
 * CLAUDE.md §4）。
 */
export function archiveObjectKey(params: {
  organizationId: string;
  year: number;
  table: ArchivableTable;
}): string {
  return `archive/${params.organizationId}/${String(params.year)}/${params.table}.jsonl.gz`;
}

/** 退避 1 件の結果。 */
export interface ArchiveEntry {
  table: ArchivableTable;
  year: number;
  objectKey: string;
  /** 書き出した行数。**0 行でも記録する**（「その年は無かった」も事実）。 */
  rowCount: number;
  /** 圧縮前の JSONL の SHA-256（16 進）。 */
  sha256: string;
  /** 圧縮後のバイト数。 */
  sizeBytes: number;
}

/**
 * 行を JSONL へ。**1 行 1 レコード、末尾は改行。**
 *
 * 空配列なら空文字（**改行だけの行を作らない**）。JSONL を読み直す側が
 * 空行を 1 件として数えないようにするため。
 */
export function toJsonl(rows: readonly unknown[]): string {
  return rows.length === 0 ? "" : `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}
