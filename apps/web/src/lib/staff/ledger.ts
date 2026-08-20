/**
 * スタッフ台帳の組み立て（P8-01 / プロトタイプ ops 07 スタッフ管理）。
 *
 * task: docs/tasks/P8-01.md
 * 決定: docs/DECISIONS.md #221 / #223
 * ルール: .claude/rules/security.md §5（従業員データ）
 *
 * ── 個人を序列化しない ──────────────────────────────────
 * security.md §5 / PK-SPEC-P8 §1.2。**速さ・件数・順位を持ち込まない。**
 * ここが返すのは在籍の事実（言語・経験年数・状態）だけで、
 * 実績の列を 1 つも持たない。**「今月の完了件数」を足さないこと。**
 *
 * ── 在留期限はここでは決めない ──────────────────────────
 * 一覧に在留期限の列があるが、**読める相手は `ORG_ADMIN` だけ**
 * （INV-08）。読めない相手には `expiresOn: null` を入れる。
 * 判定は呼び出し側が `can(ctx, "residency.read", …)` で行い、
 * この関数は**渡されたとおりに詰めるだけ**にする（門をここに増やすと
 * 判定が 2 か所になる）。
 *
 * ── 純粋関数。DB も現在時刻も持ち込まない ────────────────
 * 現在時刻は `businessDate` で注入する（`packages/engine` と同じ作法）。
 */

import type { OrgStaff, ResidencyRow, StaffLedgerRow, WorkStatus } from "@pk/db";

/** 一覧の 1 行（プロトタイプ ops 07 の列）。 */
export interface StaffLedgerView {
  membershipId: string;
  /**
   * `staff_pay_profile.id`。**台帳の行が無ければ `null`。**
   * 在留資格はこの ID に紐づくので、`null` のスタッフには記録できない
   * （先に台帳の行が要る）。
   */
  staffProfileId: string | null;
  displayName: string;
  staffNumber: string | null;
  /** 対応できる言語。台帳が空なら表示言語 1 つで代用する。 */
  languages: readonly string[];
  /**
   * 在籍年数。`hiredOn` が無ければ `null`（**0 年目にしない**）。
   * 未入力と「入って間もない」は違う。
   */
  years: number | null;
  /** 入社からの月数。1 年未満をプロトタイプは「1か月」と出す。 */
  months: number | null;
  workStatus: WorkStatus;
  /** **`residency.read` を持たない相手には常に `null`。** */
  expiresOn: string | null;
  /** 期限までの残り日数。`expiresOn` が `null` なら `null`。 */
  daysUntilExpiry: number | null;
}

/** KPI 4 枚（プロトタイプ ops 07）。 */
export interface StaffLedgerSummary {
  registered: number;
  active: number;
  training: number;
  /** **件数だけ。** `residency.read` を持たない相手にも出せる（INV-08）。 */
  expiringWithin90Days: number;
}

/** 「🌐 言語の構成」の 1 行。 */
export interface LanguageBreakdownRow {
  language: string;
  count: number;
  /** 最多の言語を 100 とした比率（バーの長さ）。 */
  ratio: number;
}

/** 台帳の画面 1 枚ぶん。 */
export interface StaffLedgerPage {
  rows: readonly StaffLedgerView[];
  summary: StaffLedgerSummary;
  languages: readonly LanguageBreakdownRow[];
}

/** `YYYY-MM-DD` を UTC の epoch 日に直す。**タイムゾーンを持ち込まない。** */
function toEpochDay(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return null;
  const [, y, m, d] = match;
  if (y === undefined || m === undefined || d === undefined) return null;
  return Math.floor(Date.UTC(Number(y), Number(m) - 1, Number(d)) / 86_400_000);
}

/** 満月数。`from` が `to` より後なら `null`（先付けの入社日を年数にしない）。 */
function monthsBetween(from: string, to: string): number | null {
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(from);
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(to);
  if (a === null || b === null) return null;
  const months =
    (Number(b[1]) - Number(a[1])) * 12 +
    (Number(b[2]) - Number(a[2])) -
    (Number(b[3]) < Number(a[3]) ? 1 : 0);
  return months < 0 ? null : months;
}

/** 残り日数。過去なら負。 */
export function daysUntil(from: string, target: string): number | null {
  const a = toEpochDay(from);
  const b = toEpochDay(target);
  return a === null || b === null ? null : b - a;
}

export interface BuildStaffLedgerInput {
  staff: readonly OrgStaff[];
  ledger: readonly StaffLedgerRow[];
  /**
   * 在留資格。**`residency.read` を持たない相手には空配列を渡すこと。**
   * ここで権限を見ない（門を 2 か所に置かない）。
   */
  residency: readonly ResidencyRow[];
  /** 在籍年数と残り日数の基準日。**現在時刻をここで読まない。** */
  businessDate: string;
  /** KPI の「在留期限 90 日以内」。**読めない相手にも渡す件数**（INV-08）。 */
  expiringWithin90Days: number;
}

/**
 * 台帳の画面を組み立てる。
 *
 * ── 退職者を一覧から消さない ────────────────────────────
 * プロトタイプの KPI は「登録 31 名 / 稼働中 28 名」で、**分母に
 * 退職者が入っている。** 一覧から消すと数が合わない。
 * 並びはスタッフ番号順（`listOrgStaff()` が付ける）。
 */
export function buildStaffLedger(input: BuildStaffLedgerInput): StaffLedgerPage {
  const ledgerByMembership = new Map(input.ledger.map((row) => [row.membershipId, row]));
  const residencyByProfile = new Map(input.residency.map((row) => [row.staffProfileId, row]));

  const rows: StaffLedgerView[] = input.staff.map((person) => {
    const ledger = ledgerByMembership.get(person.membershipId);
    const residency =
      ledger === undefined ? undefined : residencyByProfile.get(ledger.id);

    // 台帳に行が無いスタッフも一覧に出す。**空欄で出す**のが正しく、
    // 一覧から落とすと「登録したのに出てこない」になる。
    const languages =
      ledger === undefined || ledger.languages.length === 0
        ? [person.locale]
        : ledger.languages;

    const months =
      ledger?.hiredOn === undefined || ledger.hiredOn === null
        ? null
        : monthsBetween(ledger.hiredOn, input.businessDate);

    const expiresOn = residency?.expiresOn ?? null;

    return {
      membershipId: person.membershipId,
      staffProfileId: ledger?.id ?? null,
      displayName: person.displayName,
      staffNumber: person.staffNumber,
      languages,
      years: months === null ? null : Math.floor(months / 12),
      months,
      // 台帳の行が無ければ、`membership.isActive` から素直に写す。
      workStatus:
        ledger?.workStatus ?? (person.isActive ? ("ACTIVE" as const) : ("RESIGNED" as const)),
      expiresOn,
      daysUntilExpiry: expiresOn === null ? null : daysUntil(input.businessDate, expiresOn),
    };
  });

  const counts = new Map<string, number>();
  for (const row of rows) {
    // **1 人が複数の言語を持つ。** 合計は人数と一致しない
    // （プロトタイプの「登録 31 名」は表の外に出ている）。
    for (const language of row.languages) {
      counts.set(language, (counts.get(language) ?? 0) + 1);
    }
  }
  const max = Math.max(1, ...counts.values());
  const languages = [...counts.entries()]
    .map(([language, count]) => ({ language, count, ratio: Math.round((count / max) * 100) }))
    .sort((a, b) => b.count - a.count || a.language.localeCompare(b.language));

  return {
    rows,
    summary: {
      registered: rows.length,
      active: rows.filter((row) => row.workStatus === "ACTIVE").length,
      training: rows.filter((row) => row.workStatus === "TRAINING").length,
      expiringWithin90Days: input.expiringWithin90Days,
    },
    languages,
  };
}
