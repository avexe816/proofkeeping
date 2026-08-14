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
