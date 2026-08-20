/**
 * 差異レポートの語彙 → 文言キー（PK-SPEC-P4 §6.1〜§6.3）。
 *
 * task:  docs/tasks/P4-06.md / docs/tasks/P4-07.md
 * ルール: .claude/rules/ui-writing.md §1・§2
 *
 * ── 訳を画面ごとに持たない ──────────────────────────────
 * 一覧（W-06）と詳細（W-07）が同じ語を別の言い方で出すと、
 * 「解決済」と「対応済」が同じものかどうかが読めなくなる。**1 か所に置く。**
 *
 * ── 禁止語を通さない ────────────────────────────────────
 * `FALSE_POSITIVE` の表示は「誤検知」ではなく「対象外」。
 * `CONFIRMED_DISCREPANCY` は「差異を確認し、社内で対応」（§6.3 MUST）。
 * 実際の文面は `locales/ja.json`。ここは鍵の対応表だけ。
 */

import {
  FINDING_FALSE_POSITIVE_CODES,
  FINDING_RESOLVED_CODES,
  type FindingFalsePositiveCodeValue,
  type FindingResolvedCodeValue,
} from "@pk/contracts";
import type { FindingSeverity, FindingStatus, RoomAccessPurpose } from "@pk/db";

import type { MessageKey } from "../i18n.js";

/** 重要度（§2.5）。 */
export const SEVERITY_LABEL: Record<FindingSeverity, MessageKey> = {
  HIGH: "finding.severity.high",
  MEDIUM: "finding.severity.medium",
  LOW: "finding.severity.low",
};

/** 状態（§2.5）。 */
export const STATUS_LABEL: Record<FindingStatus, MessageKey> = {
  OPEN: "finding.status.open",
  REVIEWING: "finding.status.reviewing",
  RESOLVED: "finding.status.resolved",
  FALSE_POSITIVE: "finding.status.falsePositive",
  SUPPRESSED: "finding.status.suppressed",
};

/** 解決コード（§6.3 の `RESOLVED` 側）。 */
export const RESOLVED_CODE_LABEL: Record<FindingResolvedCodeValue, MessageKey> = {
  OPERATIONAL_EXCEPTION: "finding.code.operationalException",
  RECORD_MISSING: "finding.code.recordMissing",
  SYSTEM_DELAY: "finding.code.systemDelay",
  EQUIPMENT_ISSUE: "finding.code.equipmentIssue",
  PROCESS_IMPROVED: "finding.code.processImproved",
  CONFIRMED_DISCREPANCY: "finding.code.confirmedDiscrepancy",
  OTHER: "finding.code.other",
};

/** 解決コード（§6.3 の `FALSE_POSITIVE` 側）。 */
export const FALSE_POSITIVE_CODE_LABEL: Record<FindingFalsePositiveCodeValue, MessageKey> = {
  RULE_TOO_SENSITIVE: "finding.code.ruleTooSensitive",
  BASELINE_INACCURATE: "finding.code.baselineInaccurate",
  DATA_ERROR: "finding.code.dataError",
  OTHER: "finding.code.other",
};

/** 解決コード全体。**どちらの側にも `OTHER` があるので突き合わせて引く。** */
export function resolutionCodeLabel(code: string | null): MessageKey | null {
  if (code === null) return null;
  if ((FINDING_RESOLVED_CODES as readonly string[]).includes(code)) {
    return RESOLVED_CODE_LABEL[code as FindingResolvedCodeValue];
  }
  if ((FINDING_FALSE_POSITIVE_CODES as readonly string[]).includes(code)) {
    return FALSE_POSITIVE_CODE_LABEL[code as FindingFalsePositiveCodeValue];
  }
  return null;
}

/** 入室の目的（§2.3）。 */
export const ACCESS_PURPOSE_LABEL: Record<RoomAccessPurpose, MessageKey> = {
  INSPECTION: "roomAccess.purpose.inspection",
  MAINTENANCE: "roomAccess.purpose.maintenance",
  VENDOR_VISIT: "roomAccess.purpose.vendorVisit",
  SHOWING: "roomAccess.purpose.showing",
  TRAINING: "roomAccess.purpose.training",
  OTHER: "roomAccess.purpose.other",
};

/**
 * ルールの 1 行説明（プロトタイプ 04「ルール別の発生件数」の `.mini`）。
 *
 * **engine ではなくここに置く。** `Rule.title` は差異の `title` を組み立てる
 * 判定側の語で、こちらは画面にだけ出る説明。UI 文字列はカタログ経由という
 * 原則（ui-writing.md §1）に従い、鍵の対応表をこの表に置く。
 *
 * 未実装のコード（R007〜R009 / R011 / OPEN_QUESTIONS #066）は載っていない。
 * **載っていないコードは説明を出さない**（推測で書かない）。
 */
const RULE_NOTE_LABEL: Readonly<Record<string, MessageKey>> = {
  R001: "finding.rule.R001.note",
  R002: "finding.rule.R002.note",
  R003: "finding.rule.R003.note",
  R004: "finding.rule.R004.note",
  R005: "finding.rule.R005.note",
  R006: "finding.rule.R006.note",
  R010: "finding.rule.R010.note",
  R012: "finding.rule.R012.note",
  R013: "finding.rule.R013.note",
  R014: "finding.rule.R014.note",
};

/** 1 行説明を引く。**未実装・未知のコードは `null`。** */
export function ruleNoteLabel(ruleCode: string): MessageKey | null {
  return RULE_NOTE_LABEL[ruleCode] ?? null;
}
