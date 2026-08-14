/**
 * 差異レポートの組み立て（PK-SPEC-P4 §6.1〜§6.3）。
 *
 * task:  docs/tasks/P4-06.md / docs/tasks/P4-07.md
 * ルール: .claude/rules/security.md §1 / .claude/rules/ui-writing.md §2
 *
 * ── 権限判定はここに無い ────────────────────────────────
 * 呼び出し側（API ハンドラ・loader）が `assertPermission()` を先に通す。
 * **`CLEANER` / `INSPECTOR` はここへ到達しない**（§6.4 / security.md §1）。
 * この層が守るのは施設スコープ（リポジトリの `withTenantScope()`）だけ。
 *
 * ── 3 系統は差異の `evidence` から作らない ──────────────
 * §6.2 は「そのとき何が記録されていたか」を並べる画面で、`evidence` は
 * **ルールが判定に使った部分の写し**にすぎない（ルールごとに形が違う）。
 * ここは 3 系統を DB から引き直して組み立てる。欠けている系統は `null` に
 * なり、画面が「データなし」と出す（§6.2 MUST / §1.2）。
 *
 * ── 抑制を沈黙させない ──────────────────────────────────
 * §4.3。抑制された差異は行として存在しないので、
 * `reconciliationRun.findingsSuppressed` を合計して件数だけ返す。
 */

import {
  type FindingAssignableStatusValue,
  type FindingDetailResponse,
  type FindingHistoryEntry,
  type FindingListResponse,
  type FindingSignalFact,
  type FindingSummary,
} from "@pk/contracts";
import {
  countFindingsByStatus,
  countTaskPhotos,
  findFindingById,
  findPropertyById,
  findRoomById,
  insertDetectionFeedback,
  listFindings,
  listObservations,
  listOccupancySnapshots,
  listPhysicalSignals,
  listProperties,
  listPropertyStaff,
  listRoomAccessLogs,
  listRoomNumbersByIds,
  listTasks,
  recordAudit,
  sumSuppressedFindings,
  updateFindingStatus,
  type Env,
  type FindingSeverity,
  type FindingStatus,
  type TenantContext,
} from "@pk/db";

import { shiftBusinessDate } from "../businessDate.js";
import { canViewStaffName } from "../ui/staffName.js";

/**
 * 重要度の並び（§6.1 の表は「高 → 中 → 低」）。
 *
 * **リポジトリでは並べられない。** `severity` は text なので昇順が
 * `HIGH < LOW < MEDIUM` になる（`listFindings()` の注記）。語彙の順序を
 * 知っている画面側＝ここで並べ直す。
 */
const SEVERITY_ORDER: Record<FindingSeverity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/** 一覧の絞り込み（W-06 のフィルタ 3 つ）。 */
export interface FindingQuery {
  propertyId?: string | undefined;
  /** 業務日の範囲（両端を含む）。 */
  from?: string | undefined;
  to?: string | undefined;
  status?: readonly FindingStatus[] | undefined;
  severity?: readonly FindingSeverity[] | undefined;
  limit?: number | undefined;
}

/**
 * 一覧（§6.1）。
 *
 * **件数は一覧の `limit` と別に数える**（`countFindingsByStatus()`）。
 * 200 件で切った画面でも、ヘッダーの「未対応 12」はその期間の全件。
 */
export async function collectFindingList(
  env: Env,
  ctx: TenantContext,
  query: FindingQuery,
): Promise<FindingListResponse> {
  const filter = {
    ...(query.propertyId === undefined ? {} : { propertyId: query.propertyId }),
    ...(query.from === undefined ? {} : { from: query.from }),
    ...(query.to === undefined ? {} : { to: query.to }),
    ...(query.severity === undefined ? {} : { severity: query.severity }),
  };

  const [rows, countRows, suppressedCount, properties] = await Promise.all([
    listFindings(env, ctx, {
      ...filter,
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    }),
    // **状態で絞らずに数える。** 「未対応 12・確認中 3…」は絞りの外側の情報。
    countFindingsByStatus(env, ctx, filter),
    sumSuppressedFindings(env, ctx, {
      ...(query.propertyId === undefined ? {} : { propertyId: query.propertyId }),
      ...(query.from === undefined ? {} : { from: query.from }),
      ...(query.to === undefined ? {} : { to: query.to }),
    }),
    listProperties(env, ctx),
  ]);

  const roomNumbers = await listRoomNumbersByIds(
    env,
    ctx,
    rows.map((row) => row.roomId),
  );
  const propertyNames = new Map(properties.map((row) => [row.id, row.name]));

  const data = rows
    .map((row) => toSummary(row, propertyNames, roomNumbers))
    .sort(compareFindingsForDisplay);

  return {
    data,
    counts: {
      OPEN: countRows.get("OPEN") ?? 0,
      REVIEWING: countRows.get("REVIEWING") ?? 0,
      RESOLVED: countRows.get("RESOLVED") ?? 0,
      FALSE_POSITIVE: countRows.get("FALSE_POSITIVE") ?? 0,
      SUPPRESSED: countRows.get("SUPPRESSED") ?? 0,
    },
    suppressedCount,
  };
}

/**
 * 詳細（§6.2）。
 *
 * @returns 差異が無ければ `null`（呼び出し側が 404 に写す）。
 */
export async function collectFindingDetail(
  env: Env,
  ctx: TenantContext,
  findingId: string,
): Promise<FindingDetailResponse | null> {
  const finding = await findFindingById(env, ctx, findingId);
  if (finding === null) return null;

  const { propertyId, roomId, businessDate } = finding;

  const [property, room, occupancyRows, observationRows, signalRows, accessRows, taskRows] =
    await Promise.all([
      findPropertyById(env, ctx, propertyId),
      findRoomById(env, ctx, roomId),
      listOccupancySnapshots(env, ctx, { propertyId, businessDate }),
      listObservations(env, ctx, { propertyId, from: businessDate, to: businessDate }),
      listPhysicalSignals(env, ctx, { propertyId, businessDate }),
      listRoomAccessLogs(env, ctx, { propertyId, businessDate, roomId }),
      listTasks(env, ctx, { propertyId, businessDate, roomId }),
    ]);
  if (property === undefined || room === undefined) return null;

  // ── ① 稼働記録（A 系統）──────────────────────────────
  // 同じ客室・同じ業務日に取込元ちがいの行が並びうる（`uq_occ`）。
  // **先頭 1 件を採る。** どれを採るかを画面で選ばせる設計は §6.2 に無い。
  const occupancyRow = occupancyRows.find((row) => row.roomId === roomId) ?? null;

  // ── ② 現場観察（B 系統）──────────────────────────────
  const observationRow = observationRows.find((row) => row.roomId === roomId) ?? null;
  const task = taskRows[0] ?? null;
  // 「今回は記録しない」を選んだ（PK-SPEC-P3 §1.3）。**データなしとは違う。**
  const observationSkipped = task?.observationSkipped ?? false;

  const recordedByName = await resolveRecorderName(
    env,
    ctx,
    propertyId,
    observationRow?.recordedById ?? null,
  );

  // ── ③ 物理信号（C 系統）──────────────────────────────
  const signals: FindingSignalFact[] = signalRows
    .filter((row) => row.roomId === roomId)
    .map((row) => ({
      signalType: row.signalType,
      occurredAt: row.occurredAt.getTime(),
      actorType: row.actorType,
    }));

  // ── 参考情報 ────────────────────────────────────────
  const photoCount = task === null ? 0 : await countTaskPhotos(env, ctx, task.id);
  const adjacent = await collectAdjacentOccupancy(env, ctx, propertyId, roomId, businessDate);

  const summary = toSummary(
    finding,
    new Map([[property.id, property.name]]),
    new Map([[room.id, room.roomNumber]]),
  );

  return {
    finding: {
      ...summary,
      ruleVersion: finding.ruleVersion,
      summary: finding.summary,
      matchedSignals: [...finding.matchedSignals],
      resolutionNote: finding.resolutionNote,
      resolvedAt: finding.resolvedAt?.getTime() ?? null,
    },
    sources: {
      occupancy:
        occupancyRow === null
          ? null
          : {
              source: occupancyRow.source,
              isOccupied: occupancyRow.isOccupied,
              guestCount: occupancyRow.guestCount,
              reservationRef: occupancyRow.reservationRef,
              isStayover: occupancyRow.isStayover,
              isHouseUse: occupancyRow.isHouseUse,
              isComplimentary: occupancyRow.isComplimentary,
              importedAt: occupancyRow.importedAt.getTime(),
            },
      observation:
        observationRow === null
          ? null
          : {
              bedsUsed: observationRow.bedsUsed,
              trashLevel: observationRow.trashLevel,
              bathTowelUsed: observationRow.bathTowelUsed,
              faceTowelUsed: observationRow.faceTowelUsed,
              bathMatUsed: observationRow.bathMatUsed,
              usedDefaults: observationRow.usedDefaults,
              inputDurationMs: observationRow.inputDurationMs,
              recordedAt: observationRow.recordedAt.getTime(),
              recordedByName,
            },
      observationSkipped,
      // **0 件は `null`。** 「信号が 1 つも無い」と「連携していない」を
      // 画面で区別しない（どちらも「データなし」と出す / §6.2）。
      signals: signals.length === 0 ? null : signals,
    },
    reference: {
      photoCount,
      accessLogs: accessRows.map((row) => ({
        purpose: row.purpose,
        enteredAt: row.enteredAt.getTime(),
        exitedAt: row.exitedAt?.getTime() ?? null,
      })),
      roomSaleStatus: room.saleStatus,
      roomHousekeepingStatus: room.housekeepingStatus,
      adjacent,
    },
    history: historyOf(finding),
  };
}

/** `applyFindingStatus()` の入力。 */
export interface ApplyFindingStatusInput {
  findingId: string;
  status: FindingAssignableStatusValue;
  resolutionCode: string | null;
  resolutionNote: string | null;
  /** 操作者の `membership.id`。 */
  actorId: string;
  ip?: string | undefined;
}

/**
 * 状態を変える（§6.3）。
 *
 * ── 誤検知は必ず学習に落とす ────────────────────────────
 * §1.4 / §2.6。`FALSE_POSITIVE` は `detectionFeedback` に 1 行足す。
 * §4.2 が直近 30 日ぶんを数えて重要度を下げるので、**ここを書き忘れると
 * 同じ指摘が永久に同じ重要度で出続ける。**
 *
 * `CONFIRMED_DISCREPANCY`（差異を確認して社内で対応した）だけは
 * `TRUE_POSITIVE` として残す。他の解決コードは「差異の原因が別にあった」
 * であって、ルールが当たっていたかを言っていないので記録しない。
 *
 * ── 監査ログ ────────────────────────────────────────────
 * security.md §6 の「差異レポートのステータス変更」。
 *
 * @returns 変更後の 1 行。差異が無ければ `null`（呼び出し側が 404 に写す）。
 */
export async function applyFindingStatus(
  env: Env,
  ctx: TenantContext,
  input: ApplyFindingStatusInput,
): Promise<FindingSummary | null> {
  const before = await findFindingById(env, ctx, input.findingId);
  if (before === null) return null;

  const changed = await updateFindingStatus(env, ctx, {
    findingId: before.id,
    status: input.status,
    resolutionCode: input.resolutionCode,
    resolutionNote: input.resolutionNote,
    resolvedById: input.actorId,
  });
  if (!changed) return null;

  const outcome =
    input.status === "FALSE_POSITIVE"
      ? "FALSE_POSITIVE"
      : input.resolutionCode === "CONFIRMED_DISCREPANCY"
        ? "TRUE_POSITIVE"
        : null;
  if (outcome !== null) {
    await insertDetectionFeedback(env, ctx, {
      propertyId: before.propertyId,
      roomId: before.roomId,
      ruleCode: before.ruleCode,
      outcome,
      reasonCode: input.resolutionCode,
    });
  }

  await recordAudit(env, ctx, {
    actorId: input.actorId,
    action: "finding.statusChanged",
    targetType: "finding",
    targetId: before.id,
    propertyId: before.propertyId,
    before: { status: before.status, resolutionCode: before.resolutionCode },
    after: { status: input.status, resolutionCode: input.resolutionCode },
    ...(input.ip === undefined ? {} : { ip: input.ip }),
  });

  const after = await findFindingById(env, ctx, before.id);
  if (after === null) return null;

  const [property, room] = await Promise.all([
    findPropertyById(env, ctx, after.propertyId),
    findRoomById(env, ctx, after.roomId),
  ]);

  return toSummary(
    after,
    new Map(property === undefined ? [] : [[property.id, property.name]]),
    new Map(room === undefined ? [] : [[room.id, room.roomNumber]]),
  );
}

/** 1 行を API の形へ。**確信度を必ず載せる**（§1.3 MUST）。 */
function toSummary(
  row: {
    id: string;
    propertyId: string;
    roomId: string;
    businessDate: string;
    ruleCode: string;
    severity: FindingSeverity;
    confidence: number;
    title: string;
    status: FindingStatus;
    resolutionCode: string | null;
    createdAt: Date;
  },
  propertyNames: ReadonlyMap<string, string>,
  roomNumbers: ReadonlyMap<string, string>,
): FindingSummary {
  return {
    id: row.id,
    propertyId: row.propertyId,
    // 施設・客室が無効化されていても差異は残る。**空文字にして落とさない。**
    propertyName: propertyNames.get(row.propertyId) ?? "",
    roomId: row.roomId,
    roomNumber: roomNumbers.get(row.roomId) ?? "",
    businessDate: row.businessDate,
    ruleCode: row.ruleCode,
    severity: row.severity,
    confidence: row.confidence,
    title: row.title,
    status: row.status,
    resolutionCode: row.resolutionCode,
    createdAt: row.createdAt.getTime(),
  };
}

/**
 * 表示順（§6.1 の表は重要度が高い順・新しい順）。
 *
 * **公開してあるのはテストのため。** 並びは仕様の一部（高い重要度から順に
 * 目に入る）で、実データ無しで固定できる形にしておく。
 */
export function compareFindingsForDisplay(a: FindingSummary, b: FindingSummary): number {
  const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (bySeverity !== 0) return bySeverity;
  if (a.businessDate !== b.businessDate) return a.businessDate < b.businessDate ? 1 : -1;
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  // **最後は ID。** 同着の並びが呼ぶたびに変わらないようにする。
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 対応履歴（§6.2 の下段）。
 *
 * **専用の履歴表が無い**（`packages/contracts/src/finding.ts` の注記 /
 * DECISIONS #114）。差異が持つ 2 つの時刻から組み立てる。
 */
function historyOf(finding: {
  createdAt: Date;
  status: FindingStatus;
  resolutionCode: string | null;
  resolvedAt: Date | null;
}): FindingHistoryEntry[] {
  const entries: FindingHistoryEntry[] = [
    { at: finding.createdAt.getTime(), kind: "DETECTED", status: null, resolutionCode: null },
  ];
  if (finding.resolvedAt !== null) {
    entries.push({
      at: finding.resolvedAt.getTime(),
      kind: "STATUS_CHANGED",
      status: finding.status,
      resolutionCode: finding.resolutionCode,
    });
  }
  return entries;
}

/**
 * 記録者の表示名（§6.2 の「清掃 田中」）。
 *
 * **`canViewStaffName()` が偽のロールには `null`**（INV-06 / DECISIONS #036）。
 * 差異の画面は「誰がやったか」を問う場ではない。
 */
async function resolveRecorderName(
  env: Env,
  ctx: TenantContext,
  propertyId: string,
  recordedById: string | null,
): Promise<string | null> {
  if (recordedById === null || !canViewStaffName(ctx.role)) return null;
  const staff = await listPropertyStaff(env, ctx, propertyId);
  return staff.find((row) => row.membershipId === recordedById)?.displayName ?? null;
}

/** 前後の業務日の稼働（§6.2 の「前後の稼働 09/08 空室 / 09/10 稼働（2名）」）。 */
async function collectAdjacentOccupancy(
  env: Env,
  ctx: TenantContext,
  propertyId: string,
  roomId: string,
  businessDate: string,
): Promise<FindingDetailResponse["reference"]["adjacent"]> {
  const dates = [shiftBusinessDate(businessDate, -1), shiftBusinessDate(businessDate, 1)];
  const results = await Promise.all(
    dates.map(async (date) => {
      const rows = await listOccupancySnapshots(env, ctx, { propertyId, businessDate: date });
      const row = rows.find((candidate) => candidate.roomId === roomId);
      return {
        businessDate: date,
        // 記録が届いていない日は `null`。**「空室」と混ぜない**（§1.2）。
        isOccupied: row?.isOccupied ?? null,
        guestCount: row?.guestCount ?? null,
      };
    }),
  );
  return results;
}
