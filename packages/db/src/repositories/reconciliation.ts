/**
 * 照合の実行と差異のリポジトリ（PK-SPEC-P4 §2.4 / §2.5 / §5）。
 *
 * task: docs/tasks/P4-05.md
 *
 * ── 消す関数を作らない ──────────────────────────────────
 * `db.delete(auditFinding)` も `db.delete(reconciliationRun)` も書かない。
 * 再実行は**差分の追加**であって置き換えではない（§5.3 MUST）。
 * `repositories.spec.ts` がソースを走査して固定する。
 *
 * ── 人が付けた判断を上書きしない ────────────────────────
 * `insertFindings()` は既存の `(roomId, businessDate, ruleCode)` に当たったら
 * **その行に一切触らない**（§5.3 MUST）。確信度が上がっていても、
 * 文言が変わっていても、`status` を人が動かした行を書き換えない。
 * 「3 回再実行しても Finding が重複しない」（§10.2）はこの 1 点で成り立つ。
 *
 * ── 冪等は一意索引だけに頼っていない ────────────────────
 * `uq_finding` はあるが、**既存行を先に読んでから足す。** D1 に
 * `ON CONFLICT DO NOTHING` を投げて件数だけ見る形にすると、「新規に作った
 * 差異」と「既にあった差異」を区別できず、`findingsCreated`（§2.4）が
 * 実態とずれる。P4-02 の取込と同じ判断。
 */

import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant, generateId } from "../id.js";
import { getTenantDb, type TenantContext } from "../router.js";
import {
  auditFinding,
  detectionFeedback,
  physicalSignal,
  reconciliationRun,
  roomAccessLog,
  ruleConfig,
  type DetectionOutcome,
  type FindingSeverity,
  type FindingStatus,
  type ReconciliationRunStatus,
  type ReconciliationSource,
  type RoomAccessPurpose,
  type RuleCode,
} from "../schema/reconciliation.js";

import { withTenantScope } from "./base.js";

// ────────────────────────────────────────────────────────────
// 読み取り（照合の入力）
// ────────────────────────────────────────────────────────────

/** 施設 × 業務日で引く共通の絞り込み。 */
export interface PropertyDateFilter {
  propertyId: string;
  businessDate: string;
}

/**
 * C 系統 — 物理の痕跡（§2.2）。**発生順に返す。**
 *
 * 並びを固定するのは §10.1 の決定性のため。同じ日を 2 回照合したときに
 * ルールの見る順が変わらない。
 */
export async function listPhysicalSignals(
  env: Env,
  ctx: TenantContext,
  filter: PropertyDateFilter,
) {
  assertIdBelongsToTenant(filter.propertyId, ctx);
  const db = await getTenantDb(env, ctx);

  return db
    .select({
      id: physicalSignal.id,
      roomId: physicalSignal.roomId,
      signalType: physicalSignal.signalType,
      occurredAt: physicalSignal.occurredAt,
      actorType: physicalSignal.actorType,
    })
    .from(physicalSignal)
    .where(
      withTenantScope(
        physicalSignal,
        ctx,
        physicalSignal.propertyId,
        eq(physicalSignal.propertyId, filter.propertyId),
        eq(physicalSignal.businessDate, filter.businessDate),
      ),
    )
    .orderBy(physicalSignal.occurredAt, physicalSignal.id);
}

/**
 * `listRoomAccessLogs()` の絞り込み。
 *
 * **業務日は 1 日でも期間でも指定できる。** 照合は 1 日ぶん（`businessDate`）、
 * 登録の一覧（W-06 の付随画面 / P4-10）は期間で読む。
 */
export interface RoomAccessFilter {
  propertyId: string;
  businessDate?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  roomId?: string | undefined;
  limit?: number | undefined;
}

/** 正当な入室の記録（§2.3）。**あれば差異を抑制する**（§4.1）。 */
export async function listRoomAccessLogs(env: Env, ctx: TenantContext, filter: RoomAccessFilter) {
  assertIdBelongsToTenant(filter.propertyId, ctx);
  const db = await getTenantDb(env, ctx);

  return db
    .select({
      id: roomAccessLog.id,
      propertyId: roomAccessLog.propertyId,
      roomId: roomAccessLog.roomId,
      businessDate: roomAccessLog.businessDate,
      purpose: roomAccessLog.purpose,
      enteredAt: roomAccessLog.enteredAt,
      exitedAt: roomAccessLog.exitedAt,
      actorName: roomAccessLog.actorName,
      note: roomAccessLog.note,
      registeredAt: roomAccessLog.registeredAt,
    })
    .from(roomAccessLog)
    .where(
      withTenantScope(
        roomAccessLog,
        ctx,
        roomAccessLog.propertyId,
        eq(roomAccessLog.propertyId, filter.propertyId),
        filter.businessDate === undefined
          ? undefined
          : eq(roomAccessLog.businessDate, filter.businessDate),
        filter.from === undefined ? undefined : gte(roomAccessLog.businessDate, filter.from),
        filter.to === undefined ? undefined : lte(roomAccessLog.businessDate, filter.to),
        filter.roomId === undefined ? undefined : eq(roomAccessLog.roomId, filter.roomId),
      ),
    )
    .orderBy(roomAccessLog.enteredAt, roomAccessLog.id)
    .limit(filter.limit ?? 500);
}

/** `createRoomAccessLog()` の入力。**業務日は呼び出し側が日締め時刻から決める。** */
export interface CreateRoomAccessLogInput {
  propertyId: string;
  roomId: string;
  businessDate: string;
  purpose: RoomAccessPurpose;
  enteredAt: Date;
  exitedAt: Date | null;
  /** 立ち入った担当者名。**宿泊者ではない**（security.md §3・§5）。 */
  actorName: string | null;
  note: string | null;
  registeredById: string;
}

/**
 * 入室記録を 1 件足す（§2.3）。
 *
 * ── 上書きも取消も無い ──────────────────────────────────
 * `updateRoomAccessLog()` も `deleteRoomAccessLog()` も作らない。
 * この表は**差異を抑制する根拠**（§4.1）なので、後から書き換えられると
 * 「抑制されたのは登録があったからか、登録が消えたからか」が読めなくなる。
 * 誤登録の訂正は、正しい記録を足したうえで `note` に残す運用にする。
 */
export async function createRoomAccessLog(
  env: Env,
  ctx: TenantContext,
  input: CreateRoomAccessLogInput,
): Promise<string> {
  assertIdBelongsToTenant(input.propertyId, ctx);
  assertIdBelongsToTenant(input.roomId, ctx);
  const db = await getTenantDb(env, ctx);

  const id = generateId(ctx.orgShortId, "racc");
  await db.insert(roomAccessLog).values({
    id,
    organizationId: ctx.organizationId,
    propertyId: input.propertyId,
    roomId: input.roomId,
    businessDate: input.businessDate,
    purpose: input.purpose,
    enteredAt: input.enteredAt,
    exitedAt: input.exitedAt,
    // **`actorId` を書かない。** 立ち入るのは外部業者のこともあり、
    // 組織内の `membership` に必ず対応するとは限らない。名前だけを残す。
    actorId: null,
    actorName: input.actorName,
    note: input.note,
    registeredById: input.registeredById,
    registeredAt: ctx.now,
  });

  return id;
}

/**
 * ルール設定（§2.7）。**組織の既定と施設の行を両方返す。**
 *
 * どちらを採るかは呼び出し側（施設の行が優先）。ここで畳むと、
 * 「施設に設定が無い」のか「組織の既定と同じ」のかが読めなくなる。
 *
 * @param propertyId `null` なら**組織の既定だけ**（W-25 が組織の既定を
 *   編集するときに使う / P4-13）。施設 ID を渡すと既定 + その施設の行。
 */
export async function listRuleConfigs(
  env: Env,
  ctx: TenantContext,
  propertyId: string | null,
) {
  if (propertyId !== null) assertIdBelongsToTenant(propertyId, ctx);
  const db = await getTenantDb(env, ctx);

  return db
    .select({
      id: ruleConfig.id,
      propertyId: ruleConfig.propertyId,
      ruleCode: ruleConfig.ruleCode,
      isEnabled: ruleConfig.isEnabled,
      severityOverride: ruleConfig.severityOverride,
      thresholds: ruleConfig.thresholds,
    })
    .from(ruleConfig)
    .where(
      and(
        eq(ruleConfig.organizationId, ctx.organizationId),
        propertyId === null
          ? isNull(ruleConfig.propertyId)
          : or(isNull(ruleConfig.propertyId), eq(ruleConfig.propertyId, propertyId)),
      ),
    )
    .orderBy(ruleConfig.ruleCode);
}

/** `upsertRuleConfig()` の入力（W-25 / §2.7）。 */
export interface UpsertRuleConfigInput {
  /** `null` は組織の既定。施設の行があればそちらが優先（§2.7）。 */
  propertyId: string | null;
  ruleCode: RuleCode;
  isEnabled: boolean;
  severityOverride: FindingSeverity | null;
  thresholds: Record<string, number>;
}

/**
 * ルール設定を 1 件書く（W-25 / §2.7）。**無ければ作る。**
 *
 * ── なぜ upsert なのか ──────────────────────────────────
 * `ruleConfig` は**行が無いのが既定の状態**（有効・上書きなし・閾値なし）。
 * 設定画面で初めて何かを変えたときに行ができる。「先に全ルールぶんの行を
 * 作っておく」形にすると、engine にルールを足すたびに全組織へ行を配る
 * 移行が要る。
 *
 * ── 消す関数を作らない ──────────────────────────────────
 * 既定へ戻すのは `isEnabled = true` / `severityOverride = null` /
 * `thresholds = {}` を書くこと。**行を消すと「既定に戻した」のか
 * 「一度も触っていない」のかが `rulesetHash`（§2.4）から読めなくなる。**
 *
 * @returns 作ったか更新したか。**呼び出し側が監査ログの内容を決める。**
 */
export async function upsertRuleConfig(
  env: Env,
  ctx: TenantContext,
  input: UpsertRuleConfigInput,
): Promise<{ id: string; created: boolean }> {
  if (input.propertyId !== null) assertIdBelongsToTenant(input.propertyId, ctx);
  const db = await getTenantDb(env, ctx);

  const existing = await db
    .select({ id: ruleConfig.id })
    .from(ruleConfig)
    .where(
      and(
        eq(ruleConfig.organizationId, ctx.organizationId),
        input.propertyId === null
          ? isNull(ruleConfig.propertyId)
          : eq(ruleConfig.propertyId, input.propertyId),
        eq(ruleConfig.ruleCode, input.ruleCode),
      ),
    )
    .limit(1);

  const found = existing[0];
  if (found !== undefined) {
    await db
      .update(ruleConfig)
      .set({
        isEnabled: input.isEnabled,
        severityOverride: input.severityOverride,
        thresholds: input.thresholds,
        updatedAt: ctx.now,
      })
      .where(
        and(eq(ruleConfig.organizationId, ctx.organizationId), eq(ruleConfig.id, found.id)),
      );
    return { id: found.id, created: false };
  }

  const id = generateId(ctx.orgShortId, "rcfg");
  await db.insert(ruleConfig).values({
    id,
    organizationId: ctx.organizationId,
    propertyId: input.propertyId,
    ruleCode: input.ruleCode,
    isEnabled: input.isEnabled,
    severityOverride: input.severityOverride,
    thresholds: input.thresholds,
    updatedAt: ctx.now,
  });
  return { id, created: true };
}

/**
 * 直近の誤検知（§4.2 の「直近 30 日に 3 回以上」）。
 *
 * **客室ごと・ルールごとに数える。** 施設全体の傾向として記録された行
 * （`roomId = null`）は、その施設のどの客室にも効く。
 *
 * @param from これ以降に記録された行だけを見る（epoch ミリ秒ではなく `Date`）。
 */
export async function listRecentFalsePositives(
  env: Env,
  ctx: TenantContext,
  filter: { propertyId: string; from: Date },
) {
  assertIdBelongsToTenant(filter.propertyId, ctx);
  const db = await getTenantDb(env, ctx);

  return db
    .select({
      roomId: detectionFeedback.roomId,
      ruleCode: detectionFeedback.ruleCode,
    })
    .from(detectionFeedback)
    .where(
      withTenantScope(
        detectionFeedback,
        ctx,
        detectionFeedback.propertyId,
        eq(detectionFeedback.propertyId, filter.propertyId),
        eq(detectionFeedback.outcome, "FALSE_POSITIVE"),
        gte(detectionFeedback.createdAt, filter.from),
      ),
    );
}

// ────────────────────────────────────────────────────────────
// 実行（§2.4）
// ────────────────────────────────────────────────────────────

/** `startReconciliationRun()` の入力。 */
export interface StartRunInput {
  propertyId: string;
  businessDate: string;
  engineVersion: string;
  /** 適用した設定の指紋。設定変更を後から追える（§2.4）。 */
  rulesetHash: string;
  availableSources: readonly ReconciliationSource[];
}

/**
 * 実行を開始する。**同じ `(施設, 業務日, engineVersion)` は 1 行**（`uq_run`）。
 *
 * 既にあれば作らずにその行を返す。再実行は同じ Run に**差分を足す**
 * （§5.3 MUST）ので、走るたびに Run が増える形にしない。
 *
 * @returns `created` が偽なら再実行。
 */
export async function startReconciliationRun(
  env: Env,
  ctx: TenantContext,
  input: StartRunInput,
): Promise<{ id: string; created: boolean; previousStatus: ReconciliationRunStatus | null }> {
  assertIdBelongsToTenant(input.propertyId, ctx);
  const db = await getTenantDb(env, ctx);

  const existing = await db
    .select({ id: reconciliationRun.id, status: reconciliationRun.status })
    .from(reconciliationRun)
    .where(
      withTenantScope(
        reconciliationRun,
        ctx,
        reconciliationRun.propertyId,
        eq(reconciliationRun.propertyId, input.propertyId),
        eq(reconciliationRun.businessDate, input.businessDate),
        eq(reconciliationRun.engineVersion, input.engineVersion),
      ),
    )
    .limit(1);

  const found = existing[0];
  if (found !== undefined) {
    // **再実行。** `RUNNING` に戻し、開始時刻を更新する。集計値は
    // 完了時に書き直すので、ここでは触らない。
    await db
      .update(reconciliationRun)
      .set({ status: "RUNNING", startedAt: ctx.now, finishedAt: null, errorMessage: null })
      .where(
        and(
          eq(reconciliationRun.organizationId, ctx.organizationId),
          eq(reconciliationRun.id, found.id),
        ),
      );
    return { id: found.id, created: false, previousStatus: found.status };
  }

  const id = generateId(ctx.orgShortId, "run");
  await db.insert(reconciliationRun).values({
    id,
    organizationId: ctx.organizationId,
    propertyId: input.propertyId,
    businessDate: input.businessDate,
    engineVersion: input.engineVersion,
    rulesetHash: input.rulesetHash,
    status: "RUNNING",
    availableSources: [...input.availableSources],
    startedAt: ctx.now,
  });

  return { id, created: true, previousStatus: null };
}

/** `finishReconciliationRun()` の入力。**件数は毎回すべて書き直す。** */
export interface FinishRunInput {
  runId: string;
  status: Extract<ReconciliationRunStatus, "COMPLETED" | "FAILED" | "SKIPPED">;
  roomsEvaluated?: number;
  rulesEvaluated?: number;
  findingsCreated?: number;
  findingsSuppressed?: number;
  availableSources?: readonly ReconciliationSource[];
  skipReason?: string | null;
  errorMessage?: string | null;
}

/**
 * 実行を閉じる。
 *
 * **件数は加算しない。** 再実行では「その回に評価した数」で置き換える
 * （インクリメント方式にしない / architecture.md §3 と同じ理由）。
 * 差異の累計は `auditFinding` を数えれば出る。
 */
export async function finishReconciliationRun(
  env: Env,
  ctx: TenantContext,
  input: FinishRunInput,
): Promise<void> {
  assertIdBelongsToTenant(input.runId, ctx);
  const db = await getTenantDb(env, ctx);

  await db
    .update(reconciliationRun)
    .set({
      status: input.status,
      finishedAt: ctx.now,
      ...(input.roomsEvaluated === undefined ? {} : { roomsEvaluated: input.roomsEvaluated }),
      ...(input.rulesEvaluated === undefined ? {} : { rulesEvaluated: input.rulesEvaluated }),
      ...(input.findingsCreated === undefined ? {} : { findingsCreated: input.findingsCreated }),
      ...(input.findingsSuppressed === undefined
        ? {}
        : { findingsSuppressed: input.findingsSuppressed }),
      ...(input.availableSources === undefined
        ? {}
        : { availableSources: [...input.availableSources] }),
      ...(input.skipReason === undefined ? {} : { skipReason: input.skipReason }),
      ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
    })
    .where(
      and(
        eq(reconciliationRun.organizationId, ctx.organizationId),
        eq(reconciliationRun.id, input.runId),
      ),
    );
}

/** 実行の一覧（W-06 の「最終実行」表示・手動実行の重複確認）。**新しい順。** */
export async function listReconciliationRuns(
  env: Env,
  ctx: TenantContext,
  filter: { propertyId: string; from?: string; to?: string; limit?: number },
) {
  assertIdBelongsToTenant(filter.propertyId, ctx);
  const db = await getTenantDb(env, ctx);

  return db
    .select()
    .from(reconciliationRun)
    .where(
      withTenantScope(
        reconciliationRun,
        ctx,
        reconciliationRun.propertyId,
        eq(reconciliationRun.propertyId, filter.propertyId),
        filter.from === undefined ? undefined : gte(reconciliationRun.businessDate, filter.from),
        filter.to === undefined ? undefined : lte(reconciliationRun.businessDate, filter.to),
      ),
    )
    .orderBy(desc(reconciliationRun.businessDate), desc(reconciliationRun.startedAt))
    .limit(filter.limit ?? 30);
}

/** 1 件だけ引く。**越境 ID は DB へ行く前に `NotFoundError`（→ 404）。** */
export async function findReconciliationRunById(env: Env, ctx: TenantContext, runId: string) {
  assertIdBelongsToTenant(runId, ctx);
  const db = await getTenantDb(env, ctx);

  const rows = await db
    .select()
    .from(reconciliationRun)
    .where(
      withTenantScope(
        reconciliationRun,
        ctx,
        reconciliationRun.propertyId,
        eq(reconciliationRun.id, runId),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

// ────────────────────────────────────────────────────────────
// 差異（§2.5）
// ────────────────────────────────────────────────────────────

/** 書き込む差異 1 件。 */
export interface FindingInput {
  roomId: string;
  ruleCode: RuleCode;
  ruleVersion: string;
  severity: FindingSeverity;
  confidence: number;
  title: string;
  summary: string;
  evidence: Record<string, unknown>;
  matchedSignals: string[];
}

/** `insertFindings()` の宛先。 */
export interface InsertFindingsParams {
  runId: string;
  propertyId: string;
  businessDate: string;
}

/** `insertFindings()` の結果。 */
export interface InsertFindingsResult {
  /** 新しく作った差異の数（`reconciliationRun.findingsCreated`）。 */
  created: number;
  /** 既にあったので触らなかった数。**再実行はここに寄る。** */
  existing: number;
}

/**
 * 差異を書く。**既にある差異には一切触らない**（§5.3 MUST / §10.2）。
 *
 * ── なぜ更新しないのか ──────────────────────────────────
 * 同じ客室・同じ業務日・同じルールの差異は 1 件（`uq_finding`）。2 回目の
 * 照合で確信度が変わっていても上書きしない。**人が `status` を動かした行を
 * 書き換えないため**で、これは「ステータス変更済みの Finding が保護される」
 * （task の完了条件）そのもの。更新したい場合は新しい `engineVersion` で
 * 別の Run として記録する（§5.4）。
 */
export async function insertFindings(
  env: Env,
  ctx: TenantContext,
  params: InsertFindingsParams,
  findings: readonly FindingInput[],
): Promise<InsertFindingsResult> {
  assertIdBelongsToTenant(params.propertyId, ctx);
  assertIdBelongsToTenant(params.runId, ctx);
  if (findings.length === 0) return { created: 0, existing: 0 };

  const db = await getTenantDb(env, ctx);

  // 既にある鍵を先に読む。**書き込みの前に 1 回だけ。**
  const roomIds = [...new Set(findings.map((finding) => finding.roomId))];
  const existingRows = await db
    .select({ roomId: auditFinding.roomId, ruleCode: auditFinding.ruleCode })
    .from(auditFinding)
    .where(
      withTenantScope(
        auditFinding,
        ctx,
        auditFinding.propertyId,
        eq(auditFinding.propertyId, params.propertyId),
        eq(auditFinding.businessDate, params.businessDate),
        inArray(auditFinding.roomId, roomIds),
      ),
    );

  const taken = new Set(existingRows.map((row) => `${row.roomId} ${row.ruleCode}`));

  const rows = [];
  let existing = 0;
  for (const finding of findings) {
    const key = `${finding.roomId} ${finding.ruleCode}`;
    // **同じ照合の中で同じ鍵が 2 度来ても 1 行しか作らない。**
    if (taken.has(key)) {
      existing += 1;
      continue;
    }
    taken.add(key);
    rows.push({
      id: generateId(ctx.orgShortId, "find"),
      organizationId: ctx.organizationId,
      runId: params.runId,
      propertyId: params.propertyId,
      roomId: finding.roomId,
      businessDate: params.businessDate,
      ruleCode: finding.ruleCode,
      ruleVersion: finding.ruleVersion,
      severity: finding.severity,
      confidence: finding.confidence,
      title: finding.title,
      summary: finding.summary,
      evidence: finding.evidence,
      matchedSignals: finding.matchedSignals,
      status: "OPEN" as const,
      createdAt: ctx.now,
    });
  }

  if (rows.length > 0) await db.insert(auditFinding).values(rows);
  return { created: rows.length, existing };
}

/** `listFindings()` の絞り込み（W-06 / §6.1）。 */
export interface FindingFilter {
  propertyId?: string | undefined;
  businessDate?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  status?: readonly FindingStatus[] | undefined;
  severity?: readonly FindingSeverity[] | undefined;
  ruleCode?: RuleCode | undefined;
  limit?: number | undefined;
}

/**
 * 差異の一覧。**重要度の高い順・新しい順。**
 *
 * `CLEANER` / `INSPECTOR` はこの関数に到達しない。**権限判定は呼び出し側**
 * （`assertPermission(ctx, "finding.read", ...)` / security.md §1）。
 * リポジトリは施設スコープだけを見る。
 */
export async function listFindings(env: Env, ctx: TenantContext, filter: FindingFilter = {}) {
  const db = await getTenantDb(env, ctx);

  return db
    .select()
    .from(auditFinding)
    .where(
      withTenantScope(
        auditFinding,
        ctx,
        auditFinding.propertyId,
        filter.propertyId === undefined
          ? undefined
          : eq(auditFinding.propertyId, filter.propertyId),
        filter.businessDate === undefined
          ? undefined
          : eq(auditFinding.businessDate, filter.businessDate),
        filter.from === undefined ? undefined : gte(auditFinding.businessDate, filter.from),
        filter.to === undefined ? undefined : lte(auditFinding.businessDate, filter.to),
        filter.status === undefined ? undefined : inArray(auditFinding.status, [...filter.status]),
        filter.severity === undefined
          ? undefined
          : inArray(auditFinding.severity, [...filter.severity]),
        filter.ruleCode === undefined ? undefined : eq(auditFinding.ruleCode, filter.ruleCode),
      ),
    )
    // **重要度で並べない。** `severity` は text なので昇順が
    // `HIGH < LOW < MEDIUM` になり、意図した並びにならない。重要度順の
    // 並べ替えは画面側（W-06 / P4-06）が語彙の順序を知って行う。
    .orderBy(desc(auditFinding.businessDate), desc(auditFinding.createdAt))
    .limit(filter.limit ?? 200);
}

/**
 * 状態ごとの件数（W-06 の「未対応 12 ・ 確認中 3 ・ …」/ §6.1）。
 *
 * **一覧の `limit` に左右されない。** 画面が 200 件で切っていても、
 * ヘッダーの件数はその期間の全件を数える。
 */
export async function countFindingsByStatus(
  env: Env,
  ctx: TenantContext,
  filter: FindingFilter = {},
): Promise<Map<FindingStatus, number>> {
  const db = await getTenantDb(env, ctx);

  const rows = await db
    .select({ status: auditFinding.status, count: sql<number>`count(*)` })
    .from(auditFinding)
    .where(
      withTenantScope(
        auditFinding,
        ctx,
        auditFinding.propertyId,
        filter.propertyId === undefined
          ? undefined
          : eq(auditFinding.propertyId, filter.propertyId),
        filter.from === undefined ? undefined : gte(auditFinding.businessDate, filter.from),
        filter.to === undefined ? undefined : lte(auditFinding.businessDate, filter.to),
        filter.severity === undefined
          ? undefined
          : inArray(auditFinding.severity, [...filter.severity]),
        filter.ruleCode === undefined ? undefined : eq(auditFinding.ruleCode, filter.ruleCode),
      ),
    )
    .groupBy(auditFinding.status);

  return new Map(rows.map((row) => [row.status, row.count]));
}

/**
 * 月ごと・重要度ごとの件数（月次監査レポート §7.1 の「2. 重要度別の推移」）。
 *
 * ── 12 か月ぶんを 1 回で読む ────────────────────────────
 * 月ごとに `countFindingsByStatus()` を呼ぶと 12 クエリになる。
 * **業務日の先頭 7 文字（`YYYY-MM`）で GROUP BY する。**
 * 業務日は `YYYY-MM-DD` の text なので、切り出しで月になる
 * （architecture.md §7 が形式を固定している）。
 *
 * 組織内の GROUP BY なので、テナント横断の集計にはあたらない
 * （architecture.md §3 が禁じるのは組織をまたぐ集計）。
 */
export async function countFindingsByMonth(
  env: Env,
  ctx: TenantContext,
  filter: { propertyId: string; from: string; to: string },
): Promise<{ month: string; severity: FindingSeverity; count: number }[]> {
  assertIdBelongsToTenant(filter.propertyId, ctx);
  const db = await getTenantDb(env, ctx);

  const month = sql<string>`substr(${auditFinding.businessDate}, 1, 7)`;
  return db
    .select({ month, severity: auditFinding.severity, count: sql<number>`count(*)` })
    .from(auditFinding)
    .where(
      withTenantScope(
        auditFinding,
        ctx,
        auditFinding.propertyId,
        eq(auditFinding.propertyId, filter.propertyId),
        gte(auditFinding.businessDate, filter.from),
        lte(auditFinding.businessDate, filter.to),
      ),
    )
    .groupBy(month, auditFinding.severity);
}

/**
 * 抑制された差異の件数（§4.3 の「抑制された差異 N 件」）。
 *
 * ── 差異の表からは数えられない ──────────────────────────
 * 抑制はルールを**呼ぶ前**に効く（`suppression.ts`）ので、
 * `auditFinding` に行は残らない。数えられるのは
 * `reconciliationRun.findingsSuppressed` だけ。
 *
 * ── 同じ日の複数 Run を足さない ─────────────────────────
 * `engineVersion` が違えば同じ施設・同じ業務日に Run が 2 行できる
 * （§5.4）。単純に合計すると同じ抑制を二重に数える。**施設 × 業務日の
 * 最大値を採る**（最新のエンジンが見た抑制の数）。
 */
export async function sumSuppressedFindings(
  env: Env,
  ctx: TenantContext,
  filter: { propertyId?: string | undefined; from?: string | undefined; to?: string | undefined },
): Promise<number> {
  const db = await getTenantDb(env, ctx);

  const rows = await db
    .select({
      propertyId: reconciliationRun.propertyId,
      businessDate: reconciliationRun.businessDate,
      suppressed: sql<number>`max(${reconciliationRun.findingsSuppressed})`,
    })
    .from(reconciliationRun)
    .where(
      withTenantScope(
        reconciliationRun,
        ctx,
        reconciliationRun.propertyId,
        filter.propertyId === undefined
          ? undefined
          : eq(reconciliationRun.propertyId, filter.propertyId),
        filter.from === undefined ? undefined : gte(reconciliationRun.businessDate, filter.from),
        filter.to === undefined ? undefined : lte(reconciliationRun.businessDate, filter.to),
      ),
    )
    .groupBy(reconciliationRun.propertyId, reconciliationRun.businessDate);

  return rows.reduce((total, row) => total + row.suppressed, 0);
}

/** `updateFindingStatus()` の入力。**状態と理由しか変えられない。** */
export interface UpdateFindingStatusInput {
  findingId: string;
  status: Exclude<FindingStatus, "SUPPRESSED">;
  resolutionCode: string | null;
  resolutionNote: string | null;
  /** 変更した人の `membership.id`。 */
  resolvedById: string;
}

/**
 * 差異の状態を変える（§6.3）。
 *
 * ── 差異そのものは書き換えない ──────────────────────────
 * `severity` / `confidence` / `title` / `summary` / `evidence` を
 * 引数に取らない。照合が出した根拠を人が上書きできる形にしない。
 *
 * ── 閉じていない状態では解決の跡を残さない ──────────────
 * `OPEN` / `REVIEWING` へ戻したときは `resolvedAt` / `resolvedById` /
 * 解決コードを `null` に戻す。**「解決済みの時刻を持ったまま未対応」を
 * 作らない。**
 *
 * @returns 更新できたら真。他組織の行・存在しない行なら偽。
 */
export async function updateFindingStatus(
  env: Env,
  ctx: TenantContext,
  input: UpdateFindingStatusInput,
): Promise<boolean> {
  assertIdBelongsToTenant(input.findingId, ctx);
  const db = await getTenantDb(env, ctx);

  const closed = input.status === "RESOLVED" || input.status === "FALSE_POSITIVE";
  const result = await db
    .update(auditFinding)
    .set({
      status: input.status,
      resolutionCode: closed ? input.resolutionCode : null,
      resolutionNote: closed ? input.resolutionNote : null,
      resolvedAt: closed ? ctx.now : null,
      resolvedById: closed ? input.resolvedById : null,
    })
    .where(
      and(eq(auditFinding.organizationId, ctx.organizationId), eq(auditFinding.id, input.findingId)),
    );

  return result.meta.changes > 0;
}

/** `insertDetectionFeedback()` の入力。 */
export interface DetectionFeedbackInput {
  propertyId: string;
  /** 施設全体の傾向として記録するときは null（§2.6）。 */
  roomId: string | null;
  ruleCode: RuleCode;
  outcome: DetectionOutcome;
  reasonCode: string | null;
}

/**
 * 誤検知の学習を 1 件足す（§2.6 / §1.4）。
 *
 * **追記のみ。** 取り消したいときは反対の `outcome` を足す（schema の注記）。
 * §4.2 が直近 30 日の `FALSE_POSITIVE` を数えて重要度を下げる。
 */
export async function insertDetectionFeedback(
  env: Env,
  ctx: TenantContext,
  input: DetectionFeedbackInput,
): Promise<string> {
  assertIdBelongsToTenant(input.propertyId, ctx);
  const db = await getTenantDb(env, ctx);

  const id = generateId(ctx.orgShortId, "dfb");
  await db.insert(detectionFeedback).values({
    id,
    organizationId: ctx.organizationId,
    propertyId: input.propertyId,
    roomId: input.roomId,
    ruleCode: input.ruleCode,
    outcome: input.outcome,
    reasonCode: input.reasonCode,
    createdAt: ctx.now,
  });

  return id;
}

/** 1 件だけ引く。**越境 ID は DB へ行く前に `NotFoundError`（→ 404）。** */
export async function findFindingById(env: Env, ctx: TenantContext, findingId: string) {
  assertIdBelongsToTenant(findingId, ctx);
  const db = await getTenantDb(env, ctx);

  const rows = await db
    .select()
    .from(auditFinding)
    .where(
      withTenantScope(auditFinding, ctx, auditFinding.propertyId, eq(auditFinding.id, findingId)),
    )
    .limit(1);

  return rows[0] ?? null;
}
