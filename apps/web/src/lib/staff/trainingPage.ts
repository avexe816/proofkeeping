/**
 * 研修と資格の画面の組み立て（P8-10 / プロトタイプ ops 08）。**純粋。**
 *
 * task: docs/tasks/P8-10.md
 * ルール: .claude/rules/security.md §5
 *
 * ── 進捗は「N / 全項目」だけ ────────────────────────────
 * 点数・順位・修了までの速さを出さない（security.md §5）。
 * プロトタイプの表も「5 / 6 完了」までしか出していない。
 *
 * ── 「開始日」を出さない ────────────────────────────────
 * プロトタイプにはあるが、研修の開始を記録する列が無い（記録は修了だけ）。
 * **出す元が無い数字を推測で埋めない**（OQ #107 と同じ判断）。
 */

import type {
  CertificationRow,
  OrgStaff,
  StaffLedgerRow,
  TrainingProgramRow,
  TrainingRecordRow,
} from "@pk/db";

import { daysUntil } from "./ledger.js";
import { CERTIFICATION_NOTICE_DAYS } from "./residencyAlert.js";

/** 研修中のスタッフ 1 行（プロトタイプの「🎓 研修中のスタッフ」）。 */
export interface TraineeRow {
  membershipId: string;
  displayName: string;
  /** 修了した項目の数。 */
  completed: number;
  /** 有効な項目の総数。 */
  total: number;
  /** 直近の修了で付き添った人の表示名。無ければ `null`。 */
  mentorName: string | null;
}

/** 資格・講習 1 行（プロトタイプの「📅 資格・講習の更新」）。 */
export interface CertificationView {
  id: string;
  displayName: string;
  name: string;
  expiresOn: string | null;
  /** 期限 60 日以内（期限切れ含む）なら真 → 「更新必要」。 */
  needsRenewal: boolean;
}

export interface TrainingPage {
  trainees: readonly TraineeRow[];
  certifications: readonly CertificationView[];
  summary: {
    inTraining: number;
    completedThisMonth: number;
    programs: number;
    needsRenewal: number;
  };
}

export interface BuildTrainingPageInput {
  staff: readonly OrgStaff[];
  ledger: readonly StaffLedgerRow[];
  programs: readonly TrainingProgramRow[];
  records: readonly TrainingRecordRow[];
  certifications: readonly CertificationRow[];
  /** `YYYY-MM-DD`。今月の判定と期限の残り日数に使う。 */
  businessDate: string;
}

export function buildTrainingPage(input: BuildTrainingPageInput): TrainingPage {
  const nameByMembership = new Map(input.staff.map((row) => [row.membershipId, row.displayName]));
  const activePrograms = input.programs.filter((row) => row.isActive);
  const activeIds = new Set(activePrograms.map((row) => row.id));

  // ── 研修中のスタッフ（`workStatus = TRAINING`）────────────
  const trainees: TraineeRow[] = input.ledger
    .filter((row) => row.workStatus === "TRAINING")
    .map((row) => {
      const own = input.records
        .filter(
          (record) => record.membershipId === row.membershipId && activeIds.has(record.programId),
        )
        .sort((a, b) => (a.completedOn < b.completedOn ? -1 : 1));
      const latestMentor = own.at(-1)?.mentorMembershipId ?? null;
      return {
        membershipId: row.membershipId,
        displayName: nameByMembership.get(row.membershipId) ?? "",
        completed: own.length,
        total: activePrograms.length,
        mentorName: latestMentor === null ? null : (nameByMembership.get(latestMentor) ?? null),
      };
    });

  // ── 今月の修了件数 ──────────────────────────────────────
  const month = input.businessDate.slice(0, 7);
  const completedThisMonth = input.records.filter((record) =>
    record.completedOn.startsWith(month),
  ).length;

  // ── 資格・講習 ──────────────────────────────────────────
  const certifications: CertificationView[] = input.certifications.map((row) => {
    const days = row.expiresOn === null ? null : daysUntil(input.businessDate, row.expiresOn);
    return {
      id: row.id,
      displayName: nameByMembership.get(row.membershipId) ?? "",
      name: row.name,
      expiresOn: row.expiresOn,
      needsRenewal: days !== null && days <= CERTIFICATION_NOTICE_DAYS,
    };
  });

  return {
    trainees,
    certifications,
    summary: {
      inTraining: trainees.length,
      completedThisMonth,
      programs: activePrograms.length,
      needsRenewal: certifications.filter((row) => row.needsRenewal).length,
    },
  };
}

/**
 * 標準の研修 6 項目（プロトタイプ ops 08 の「📚 研修プログラム」）。
 *
 * プログラムが 1 件も無い組織へ、画面のボタンから投入する。
 * **文言はプロトタイプの 6 項目そのまま。**
 */
export const DEFAULT_TRAINING_PROGRAMS: readonly {
  name: string;
  expectedMinutes: number;
}[] = [
  { name: "アプリの操作", expectedMinutes: 120 },
  { name: "清掃の基本手順", expectedMinutes: 240 },
  { name: "浴室・水回りの手順", expectedMinutes: 180 },
  { name: "リネンの取り扱い", expectedMinutes: 120 },
  { name: "衛生と安全", expectedMinutes: 180 },
  { name: "記録の入力実習", expectedMinutes: 120 },
];
