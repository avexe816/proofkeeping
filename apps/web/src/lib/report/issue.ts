/**
 * 設備不具合のユースケース（PK-SPEC-P2 §8）。
 *
 * task: docs/tasks/P2-12.md
 *
 * ── §8.2 MUST の 2 段構え ───────────────────────────────
 * 「CRITICAL 登録時は確認画面を出し、確定後に `Room.saleStatus = OUT_OF_ORDER`、
 * `housekeepingStatus = BLOCKED` へ自動変更する」。
 *   ① 確認 … `confirmed: true` をサーバー側でも要求する
 *      （画面だけの確認は API を直接叩けば迂回できる）
 *   ② 変更 … 2 つの列を**両方**立てる
 * `HIGH` は「原則 BLOCKED」なので**自動では止めない**（engine の
 * `roomEffectOf()` が `SUGGEST_BLOCK` を返す）。
 *
 * ── 戻す経路がここに無い ────────────────────────────────
 * §8.3「不具合を閉じても客室状態は自動復旧しない。明示操作が必要」。
 * `resolveIssue()` は客室に触らない。**復旧は W-03 の手動上書き**
 * （`room.statusOverride` / 理由必須・監査ログ）だけ。
 * **このファイルに「解決したら戻す」を足さないこと。**
 */

import type { IssueReportSummary, IssueStatusValue } from "@pk/contracts";
import {
  advanceIssueReport,
  createIssueReport,
  listIssueReports,
  recordAudit,
  setHousekeepingStatus,
  setRoomSaleStatus,
  type Env,
  type IssueReportFilter,
  type TenantContext,
} from "@pk/db";
import { evaluateIssueTransition, requiresConfirmation, roomEffectOf } from "@pk/engine";

/** 報告の入力。 */
export interface ReportIssueInput {
  propertyId: string;
  roomId: string;
  taskId: string | null;
  category: IssueReportSummary["category"];
  severity: IssueReportSummary["severity"];
  title: string;
  description: string;
  reportedById: string;
  /** §8.2 の確認を通したか。**`CRITICAL` では必須。** */
  confirmed: boolean;
  ip?: string | undefined;
}

/** 報告の結果。 */
export type ReportIssueOutcome =
  | {
      kind: "CREATED";
      issueId: string;
      /** 客室を止めたか（§8.2）。画面が「客室を停止しました」を出す。 */
      roomBlocked: boolean;
    }
  | { kind: "REJECTED"; error: "CONFIRMATION_REQUIRED" };

/**
 * 不具合を報告する（§8.1）。
 *
 * ── 客室を止めるのは登録の後 ────────────────────────────
 * 報告を先に立て、成功してから客室を止める。**逆にすると、
 * 客室が止まったのに報告が残らない**（登録が失敗した場合）状態ができ、
 * なぜ止まっているか誰にも分からなくなる。
 *
 * ── 監査ログ ────────────────────────────────────────────
 * security.md §6 の列挙に不具合報告は無いが、**客室を止めた場合だけ
 * `room.statusOverridden` を残す。** §6 は「客室ステータスの手動上書き
 * （理由必須）」を挙げており、自動であっても客室が止まる事実は同じ重さを持つ。
 * 理由は不具合の題名（`title`）を入れる。**理由欄が空の記録を作らない。**
 */
export async function reportIssue(
  env: Env,
  ctx: TenantContext,
  input: ReportIssueInput,
): Promise<ReportIssueOutcome> {
  // §8.2 MUST の①。**画面の確認だけに頼らない。**
  if (requiresConfirmation(input.severity) && !input.confirmed) {
    return { kind: "REJECTED", error: "CONFIRMATION_REQUIRED" };
  }

  const blocksRoom = roomEffectOf(input.severity) === "AUTO_BLOCK";

  const created = await createIssueReport(env, ctx, {
    propertyId: input.propertyId,
    taskId: input.taskId,
    roomId: input.roomId,
    category: input.category,
    severity: input.severity,
    title: input.title,
    description: input.description,
    reportedById: input.reportedById,
    roomBlocked: blocksRoom,
  });

  if (blocksRoom) {
    // §8.2 MUST の②。**2 つの列を両方立てる。** 片方だけだと
    // 「清掃済だが売れない」「売れるが清掃中」のどちらかしか表せない。
    await setRoomSaleStatus(env, ctx, [input.roomId], "OUT_OF_ORDER");
    await setHousekeepingStatus(env, ctx, [input.roomId], "BLOCKED");
    await recordAudit(env, ctx, {
      actorId: input.reportedById,
      action: "room.statusOverridden",
      targetType: "room",
      targetId: input.roomId,
      propertyId: input.propertyId,
      after: { saleStatus: "OUT_OF_ORDER", housekeepingStatus: "BLOCKED", issueId: created.issueId },
      // 理由必須（`AUDIT_ACTIONS`）。**不具合の題名をそのまま入れる。**
      reason: input.title,
      ...(input.ip === undefined ? {} : { ip: input.ip }),
    });
  }

  return { kind: "CREATED", issueId: created.issueId, roomBlocked: blocksRoom };
}

/** 状態変更の入力。 */
export interface ChangeIssueStatusInput {
  issueId: string;
  /** 現在の状態。**呼び出し側が引いた行から渡す。** */
  from: IssueStatusValue;
  to: IssueStatusValue;
  actorId: string;
  note: string | null;
  resolutionNote?: string | null | undefined;
  assignedToId?: string | null | undefined;
}

/** 状態変更の結果。 */
export type ChangeIssueStatusOutcome =
  | { kind: "ADVANCED" }
  /** 同じ状態への再送。**成功扱い**（冪等 / testing.md §4）。 */
  | { kind: "NOOP" }
  | { kind: "REJECTED"; error: "INVALID_TRANSITION" | "RESOLUTION_NOTE_REQUIRED" };

/**
 * 状態を進める（§8.3）。
 *
 * **客室に触らない**（冒頭の注記）。解決しても `roomBlocked` は真のまま
 * 残り、客室も止まったまま。戻すのは責任者の明示操作。
 */
export async function changeIssueStatus(
  env: Env,
  ctx: TenantContext,
  input: ChangeIssueStatusInput,
): Promise<ChangeIssueStatusOutcome> {
  const verdict = evaluateIssueTransition({
    from: input.from,
    to: input.to,
    resolutionNote: input.resolutionNote ?? null,
  });
  if (verdict.kind === "NOOP") return { kind: "NOOP" };
  if (verdict.kind === "REJECTED") return { kind: "REJECTED", error: verdict.reason };

  const result = await advanceIssueReport(env, ctx, {
    issueId: input.issueId,
    from: input.from,
    to: input.to,
    actorId: input.actorId,
    note: input.note,
    ...(input.resolutionNote === undefined ? {} : { resolutionNote: input.resolutionNote }),
    ...(input.assignedToId === undefined ? {} : { assignedToId: input.assignedToId }),
  });

  // 楽観的排他に負けた（並行操作）。**engine が許した遷移でも起きうる。**
  if (result.kind === "NOOP") return { kind: "REJECTED", error: "INVALID_TRANSITION" };
  return { kind: "ADVANCED" };
}

/**
 * 一覧（§8）。
 *
 * **`CLEANER` は自分が報告したものだけ。** `lostItem` と同じ方針で、
 * 呼び出し側に絞りを任せない（`lib/report/lostItem.ts` の注記）。
 * `INSPECTOR` は施設内すべてを見られる（検査で見つけた不具合の
 * 対応状況を追う必要がある）。
 */
export async function listVisibleIssues(
  env: Env,
  ctx: TenantContext,
  membershipId: string,
  filter: IssueReportFilter,
): Promise<IssueReportSummary[]> {
  const scoped: IssueReportFilter =
    ctx.role === "CLEANER" ? { ...filter, reportedById: membershipId } : filter;

  const rows = await listIssueReports(env, ctx, scoped);
  return rows.map(toIssueSummary);
}

/** 行 → 応答の形。 */
export function toIssueSummary(row: {
  id: string;
  propertyId: string;
  roomId: string;
  taskId: string | null;
  category: IssueReportSummary["category"];
  severity: IssueReportSummary["severity"];
  title: string;
  description: string;
  status: IssueStatusValue;
  reportedById: string;
  assignedToId: string | null;
  reportedAt: Date;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  roomBlocked: boolean;
}): IssueReportSummary {
  return {
    issueId: row.id,
    propertyId: row.propertyId,
    roomId: row.roomId,
    taskId: row.taskId,
    category: row.category,
    severity: row.severity,
    title: row.title,
    description: row.description,
    status: row.status,
    reportedById: row.reportedById,
    assignedToId: row.assignedToId,
    reportedAtMs: row.reportedAt.getTime(),
    resolvedAtMs: row.resolvedAt?.getTime() ?? null,
    resolutionNote: row.resolutionNote,
    roomBlocked: row.roomBlocked,
  };
}
