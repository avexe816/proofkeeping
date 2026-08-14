/**
 * 稼働照合バッチ（PK-SPEC-P4 §5）。**Queue コンシューマ。**
 *
 * task:  docs/tasks/P4-05.md
 * ルール: .claude/rules/architecture.md §4・§5 / testing.md §4
 *
 * ```
 * cron（02:00 JST）        → 全アクティブ施設 → QUEUE_RECONCILIATION
 * POST /api/v1/reconciliation/runs（1 施設・1 業務日 / §5.4）
 *                                            ← ここで 3 系統を突き合わせる
 * ```
 *
 * ── 二重起動を DO で断る（§5.2）──────────────────────────
 * `ReconciliationLock`（施設 × 業務日）を取ってから読み始める。取れなければ
 * **`SKIPPED` として閉じて ack する。** retry にすると、走っている実行が
 * 終わるまで再送が続き、終わった頃に同じ日をもう一度読むことになる。
 *
 * ── 冪等（§10.2 / testing.md §4）─────────────────────────
 * 3 回実行しても差異が重複しない。効いているのは 3 つ。
 *   ① `evaluate()` が決定性を持つ（`packages/engine` は純粋関数）。
 *   ② `startReconciliationRun()` が `(施設, 業務日, engineVersion)` で
 *      1 行に畳む。走るたびに Run が増えない。
 *   ③ `insertFindings()` が既にある差異に**一切触らない**（§5.3 MUST）。
 *      人が動かした `status` が再実行で戻らない。
 *
 * ── 稼働記録が無くても完走する（§0.3）──────────────────
 * A 系統が 1 件も無い施設でも走り切る。**その日の `availableSources` に
 * `occupancy` が載らないだけ**で、B だけで判定できるルールは動く。
 * 3 系統が揃っていることを前提にした早期 return を書かないこと。
 *
 * ── rollup へ投げる（§5.3 の手順 9）─────────────────────
 * P4-05 の時点では `rollup-update` にコンシューマが無く、この手順を
 * 飛ばしていた。**P5-14 が繋いだ。** 照合が終わったら 1 施設 × 1 業務日を
 * 数え直させる（`consumers/rollup.ts`）。失敗しても照合は成立している。
 */

import {
  countPhotosByTask,
  findPropertyById,
  hasOccupancySnapshotsInRange,
  insertFindings,
  finishReconciliationRun,
  listAuditLogs,
  listBaselines,
  listObservations,
  listOccupancyInRange,
  listOccupancySnapshots,
  listPhysicalSignals,
  listRecentFalsePositives,
  listRoomAccessLogs,
  listRooms,
  listRuleConfigs,
  listTasks,
  startReconciliationRun,
  type Env,
  type FindingInput,
  type RuleCode,
  type TenantContext,
} from "@pk/db";
import {
  RECONCILIATION_ENGINE_VERSION,
  RULES,
  businessDateDiff,
  evaluate,
  type BaselineFact,
  type EvaluationOptions,
  type ObservationFact,
  type OccupancyFact,
  type OccupancyRevocationFact,
  type ReconciliationSource,
  type RuleContext,
  type StatusOverrideFact,
} from "@pk/engine";

import {
  RECONCILIATION_LOCK_ORIGIN,
  reconciliationLockName,
  type ReconciliationAcquireResult,
} from "../durable/ReconciliationLock.js";
import { businessDateOf, localClockOf, shiftBusinessDate } from "../lib/businessDate.js";

import { enqueueRollupUpdate } from "./rollup.js";

import { resolveRuleSettings, rulesetHashOf } from "../lib/reconciliation/ruleset.js";

/**
 * 「稼働記録の連携がある施設か」を見る窓（日数）。
 *
 * **当日だけを見ない**（DECISIONS #110）。当日の取込が丸ごと落ちた日に
 * 「連携なし」と読むと、それを拾うための R006（§3.7）が黙る。
 */
export const OCCUPANCY_LINK_WINDOW_DAYS = 30;

/** 誤検知の学習が見る窓（§4.2 の「直近 30 日」）。 */
export const FALSE_POSITIVE_WINDOW_DAYS = 30;

/** R010 が数える窓（§3.8 の「直近 7 日」）。 */
export const STATUS_OVERRIDE_WINDOW_DAYS = 7;

/**
 * R004 が遡って稼働記録を確かめる幅（§3.5 の「その間に他の稼働記録がない」）。
 *
 * **無制限に遡らない。** 退室から何か月も空いた客室（長期の販売停止）で
 * 数十日ぶんを読むことになる。ここを超えて空いている場合は
 * `occupancyBetweenCheckOutAndToday` を `null`（分からない）にして、
 * R004 を立てない（§1.2「分からないものを『無かった』に倒さない」）。
 */
export const CHECKOUT_GAP_MAX_DAYS = 14;

/** キューへ載せるメッセージ。**組織の解決に要る値を全部持たせる。** */
export interface ReconciliationMessage {
  kind: "RECONCILIATION";
  organizationId: string;
  orgShortId: string;
  propertyId: string;
  /** 照合する業務日（`YYYY-MM-DD`）。 */
  businessDate: string;
  /** `AUTO` は夜間バッチ、`MANUAL` は §5.4 の手動実行。 */
  mode: "AUTO" | "MANUAL";
  /** 手動実行した `membership.id`。**`AUTO` では `null`。** */
  requestedById: string | null;
  /** 要求した時刻（ミリ秒）。**再送でも変わらない**（冪等の土台）。 */
  requestedAtMs: number;
}

/** メッセージの形を確かめる。**Zod を使わない**（contracts は API の入出力の定義）。 */
export function isReconciliationMessage(value: unknown): value is ReconciliationMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  const requestedById = message["requestedById"];
  return (
    message["kind"] === "RECONCILIATION" &&
    typeof message["organizationId"] === "string" &&
    typeof message["orgShortId"] === "string" &&
    typeof message["propertyId"] === "string" &&
    typeof message["businessDate"] === "string" &&
    (message["mode"] === "AUTO" || message["mode"] === "MANUAL") &&
    (requestedById === null || typeof requestedById === "string") &&
    typeof message["requestedAtMs"] === "number"
  );
}

/** 1 件の処理結果。**呼び出し側（`queue()`）が ack / retry を決める。** */
export type ReconciliationOutcome =
  | {
      kind: "OK";
      roomsEvaluated: number;
      rulesEvaluated: number;
      findingsCreated: number;
      findingsSuppressed: number;
      availableSources: readonly ReconciliationSource[];
    }
  /** 別の実行が走っていた（§5.2）。**再送しない。** */
  | { kind: "SKIPPED"; reason: string }
  /** D1 / DO の失敗など。**直しうる**ので retry する。 */
  | { kind: "FAILED"; reason: string };

/**
 * 稼働記録の取込元の優先順位（DECISIONS #111）。
 *
 * 同じ客室・同じ業務日に複数の取込元があれば（DECISIONS #106）、
 * **人が入れた記録が最優先。** 連携の誤りを人が直したものを、次の自動
 * 取込で上書きされた側の値で判定しない。次が PMS の一次情報、最後が CSV。
 */
const SOURCE_PRIORITY: Readonly<Record<string, number>> = {
  MANUAL: 0,
  PMS_API: 1,
  CSV_IMPORT: 2,
};

/** 客室 1 つぶんの評価に要る行をまとめた入れ物。 */
interface RoomFacts {
  occupancy: OccupancyFact | null;
  observation: ObservationFact | null;
}

/**
 * 施設 1 つ・業務日 1 つを照合する（§5.3 の処理フロー）。
 *
 * @returns ack / retry の判断に使う結果。**差異そのものは返さない**
 *   （件数だけをログに出す / architecture.md §1）。
 */
export async function runReconciliation(
  env: Env,
  message: ReconciliationMessage,
): Promise<ReconciliationOutcome> {
  const ctx: TenantContext = {
    organizationId: message.organizationId,
    orgShortId: message.orgShortId,
    // バッチと同じ扱い（`consumers/baselineLearning.ts` の注記 / OPEN_QUESTIONS #033）。
    // **`assertPermission()` は呼ばない。** 認可は投入した API 側で済んでいる。
    role: "ORG_ADMIN",
    allowedPropertyIds: [],
    now: new Date(message.requestedAtMs),
  };

  const runKey = `${message.businessDate}:${String(message.requestedAtMs)}`;
  const lock = env.RECONCILIATION_LOCK.get(
    env.RECONCILIATION_LOCK.idFromName(
      reconciliationLockName(message.organizationId, message.propertyId, message.businessDate),
    ),
  );

  let acquired: ReconciliationAcquireResult;
  try {
    const response = await lock.fetch(`${RECONCILIATION_LOCK_ORIGIN}/acquire`, {
      method: "POST",
      body: JSON.stringify({
        runKey,
        engineVersion: RECONCILIATION_ENGINE_VERSION,
        nowMs: message.requestedAtMs,
      }),
    });
    acquired = await response.json<ReconciliationAcquireResult>();
  } catch {
    // DO へ届かない。**読み始めない**（排他が効いていない状態で走らせない）。
    return { kind: "FAILED", reason: "LOCK_UNAVAILABLE" };
  }

  if (!acquired.acquired) {
    console.log(`reconciliation-skipped date=${message.businessDate} reason=ALREADY_RUNNING`);
    return { kind: "SKIPPED", reason: "ALREADY_RUNNING" };
  }

  try {
    return await reconcile(env, ctx, message);
  } catch (error) {
    // **中身をログへ流さない。** 例外の名前と業務日だけ（architecture.md §1）。
    const reason = error instanceof Error ? error.name : "UNKNOWN";
    console.error(`reconciliation-failed date=${message.businessDate} reason=${reason}`);
    return { kind: "FAILED", reason };
  } finally {
    // **必ず手放す。** 失敗しても保持を残さない（貸出期限に頼らない）。
    try {
      await lock.fetch(`${RECONCILIATION_LOCK_ORIGIN}/release`, {
        method: "POST",
        body: JSON.stringify({ runKey }),
      });
    } catch {
      // 解放に失敗しても実行は終わっている。期限（15 分）が拾う。
      console.error("reconciliation-release-failed");
    }
  }
}

/** 排他を取ったあとの本体。**例外は呼び出し側が受ける。** */
async function reconcile(
  env: Env,
  ctx: TenantContext,
  message: ReconciliationMessage,
): Promise<ReconciliationOutcome> {
  const { propertyId, businessDate } = message;

  const property = await findPropertyById(env, ctx, propertyId);
  if (property === undefined) {
    // 施設が消えた・無効化された。**再送しても直らない。**
    return { kind: "SKIPPED", reason: "PROPERTY_NOT_FOUND" };
  }

  // ── ① 3 系統と付帯情報を読む（§5.3 の手順 1〜3）────────────────
  const [rooms, occupancyRows, observationRows, taskRows, signalRows, accessRows, configRows] =
    await Promise.all([
      // **清掃専用の場所を外す。** 稼働記録が無いのが正常な場所
      //（PK-SPEC-P0 §24.3 の `isSellable = false`）。
      listRooms(env, ctx, { propertyId, isSellable: true, isActive: true }),
      listOccupancySnapshots(env, ctx, { propertyId, businessDate }),
      listObservations(env, ctx, { propertyId, from: businessDate, to: businessDate }),
      listTasks(env, ctx, { propertyId, businessDate }),
      listPhysicalSignals(env, ctx, { propertyId, businessDate }),
      listRoomAccessLogs(env, ctx, { propertyId, businessDate }),
      listRuleConfigs(env, ctx, propertyId),
    ]);

  // ── ①' P4-11 / P4-12 のルールが要る付帯情報 ────────────────────
  // **前日ぶん**（R005 の「2 日連続」）。当日と同じ形で読む。
  const previousDate = shiftBusinessDate(businessDate, -1);
  const [previousOccupancyRows, previousObservationRows, baselineRows, auditRows] =
    await Promise.all([
      listOccupancySnapshots(env, ctx, { propertyId, businessDate: previousDate }),
      listObservations(env, ctx, { propertyId, from: previousDate, to: previousDate }),
      // R003（§3.4）が読む。**信頼性の絞りはリポジトリに無い**
      // （W-21 は `isReliable = false` もグレーで出すため / `listBaselines()`
      // の注記）。engine へ渡す前に `baselinesFor()` が落とす。
      listBaselines(env, ctx, { propertyId }),
      // R010（§3.8）と R014（§3.10）の根拠。**監査ログにしか無い。**
      listAuditLogs(env, ctx, {
        propertyId,
        actions: ["room.statusOverridden", "occupancy.imported"],
        from: new Date(ctx.now.getTime() - STATUS_OVERRIDE_WINDOW_DAYS * DAY_MS),
        to: ctx.now,
      }),
    ]);

  const previousFacts = groupRoomFacts(previousOccupancyRows, previousObservationRows, []);
  const statusOverrides = statusOverridesOf(auditRows);
  const revocations = occupancyRevocationsOf(auditRows, businessDate);

  // ── ② 施設の属性（OPEN_QUESTIONS #063 / DECISIONS #110）──────
  const occupancyLinked = await hasOccupancySnapshotsInRange(env, ctx, {
    propertyId,
    from: shiftBusinessDate(businessDate, -OCCUPANCY_LINK_WINDOW_DAYS),
    to: businessDate,
  });
  const daysSinceOperationStart = daysBetween(property.createdAt, ctx.now);

  // ── ③ 揃っている系統を判定する（§5.3 の手順 1）─────────────
  // **施設ぶんで判定する。** 客室ごとに判定すると、記録が届いていない
  // 客室だけ「系統が無い」ことになり、まさにそれを拾う R006 が黙る。
  const availableSources: ReconciliationSource[] = [];
  if (occupancyRows.length > 0) availableSources.push("occupancy");
  if (observationRows.length > 0 || taskRows.length > 0) availableSources.push("observation");
  if (signalRows.length > 0) availableSources.push("signal");

  // ── ④ ルールセットを組み立てる（§5.3 の手順 4）──────────────
  const settings = resolveRuleSettings(configRows, propertyId);
  const rulesetHash = rulesetHashOf(settings);

  const run = await startReconciliationRun(env, ctx, {
    propertyId,
    businessDate,
    engineVersion: RECONCILIATION_ENGINE_VERSION,
    rulesetHash,
    availableSources,
  });

  // ── ⑤ 誤検知の履歴（§4.2）────────────────────────────────
  const falsePositives = await listRecentFalsePositives(env, ctx, {
    propertyId,
    from: new Date(ctx.now.getTime() - FALSE_POSITIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000),
  });

  const byRoom = groupRoomFacts(occupancyRows, observationRows, taskRows);

  // 写真の枚数（R012）。**タスクごとに 1 クエリにしない**（§10.6 の応答時間）。
  const photoCounts = await countPhotosByTask(
    env,
    ctx,
    taskRows.map((row) => row.id),
  );

  // R004（§3.5）の「その間に他の稼働記録がない」。**退室が空いている
  // 客室だけを調べる**（全客室ぶんを毎回読まない）。
  const occupancyBetween = await collectOccupancyBetween(env, ctx, {
    propertyId,
    businessDate,
    property,
    rooms: rooms.map((room) => ({ id: room.id, occupancy: byRoom.get(room.id)?.occupancy ?? null })),
  });

  const findings: FindingInput[] = [];
  let rulesEvaluated = 0;
  let findingsSuppressed = 0;
  let roomsEvaluated = 0;

  // ── ⑥ 客室ごとに評価する（§5.3 の手順 5〜6）──────────────────
  for (const room of rooms) {
    const facts = byRoom.get(room.id);
    const task = taskRows.find((row) => row.roomId === room.id) ?? null;
    // その客室に 3 系統も清掃も無ければ、評価する対象が無い。
    if (facts === undefined && task === null) continue;

    roomsEvaluated += 1;

    const context: RuleContext = {
      now: ctx.now,
      businessDate,
      property: {
        id: property.id,
        occupancyLinked,
        daysSinceOperationStart,
      },
      room: {
        id: room.id,
        number: room.roomNumber,
        roomTypeId: room.roomTypeId ?? "",
        saleStatus: saleStatusOf(room.saleStatus, room.housekeepingStatus),
      },
      occupancy: facts?.occupancy ?? null,
      observation: facts?.observation ?? null,
      task:
        task === null
          ? null
          : {
              taskType: task.taskType,
              isCompleted: task.status === "COMPLETED",
              // PK-SPEC-P6 §4.4 の除外窓（前後 10 分）が読む。**清掃スタッフの
              // 入室を解錠の記録から外すのに、開始時刻が要る**（P6-08）。
              startedAt: task.startedAt?.getTime() ?? null,
              completedAt: task.completedAt?.getTime() ?? null,
              actualMinutes: task.actualMinutes,
              // R012（§3.1「写真未添付での完了」）が見る。**0 を固定で
              // 渡していた P4-05 の暫定をここで解いた。**
              photoCount: photoCounts.get(task.id) ?? 0,
            },
      signals: signalRows
        .filter((row) => row.roomId === room.id)
        .map((row) => ({
          signalType: row.signalType,
          occurredAt: row.occurredAt.getTime(),
          actorType: row.actorType,
          // **深夜帯（§3.3 / §3.9）は施設の地域時刻で決まる。** engine は
          // 時差を解けない（純粋関数）ので、ここで変換して渡す。
          localHour: localHourOf(row.occurredAt, property.timezone),
        })),
      accessLogs: accessRows
        .filter((row) => row.roomId === room.id)
        .map((row) => ({
          purpose: row.purpose,
          enteredAt: row.enteredAt.getTime(),
          exitedAt: row.exitedAt?.getTime() ?? null,
        })),
      // R003（§3.4）が読む。**信頼できる統計だけが入っている**（読み出し時に
      // 絞ってある）。客室タイプ × 人数 × 作業種別で更に絞る。
      baselines: baselinesFor(baselineRows, {
        roomTypeId: room.roomTypeId ?? "",
        guestCount: facts?.occupancy?.guestCount ?? null,
        taskType: task?.taskType ?? null,
      }),
      previousObservation: previousFacts.get(room.id)?.observation ?? null,
      previousOccupancy: previousFacts.get(room.id)?.occupancy ?? null,
      checkOutBusinessDate: checkOutBusinessDateOf(facts?.occupancy ?? null, property),
      occupancyBetweenCheckOutAndToday: occupancyBetween.get(room.id) ?? null,
      statusOverrides,
      occupancyRevokedAfterCleaning: revocationFor(
        revocations,
        room.id,
        task?.completedAt?.getTime() ?? null,
      ),
      thresholds: {},
    };

    const options: EvaluationOptions = {
      availableSources,
      settings,
      falsePositiveCounts: falsePositiveCountsOf(falsePositives, room.id),
    };

    const result = evaluate(context, options);
    rulesEvaluated += result.rulesEvaluated;
    findingsSuppressed += result.suppressed.length;

    for (const draft of result.findings) {
      findings.push({
        roomId: room.id,
        ruleCode: draft.ruleCode as RuleCode,
        ruleVersion: ruleVersionOf(draft.ruleCode),
        severity: draft.severity,
        confidence: draft.confidence,
        title: draft.title,
        summary: draft.summary,
        evidence: { ...draft.evidence },
        matchedSignals: [...draft.matchedSignals],
      });
    }
  }

  // ── ⑦⑧ 既存と突合して差分だけ足す（§5.3 の手順 7〜8）────────
  const inserted = await insertFindings(
    env,
    ctx,
    { runId: run.id, propertyId, businessDate },
    findings,
  );

  // ── ⑨ 日次集計を数え直す（§5.3 の手順 9 / P5-14）─────────────
  // **P4-05 が飛ばしていた手順。** `rollup-update` にコンシューマが
  // 無かったため。P5-14 が入れたので繋ぐ。差異の件数（`findingsHigh`）が
  // 組織ダッシュボード（PK-SPEC-P5 §7.1）の右端の列になる。
  await enqueueRollupUpdate(env, ctx, { propertyId, businessDate, reason: "RECONCILIATION" });

  // ── ⑩ Run を閉じる（§5.3 の手順 10）─────────────────────────
  await finishReconciliationRun(env, ctx, {
    runId: run.id,
    status: "COMPLETED",
    roomsEvaluated,
    rulesEvaluated,
    findingsCreated: inserted.created,
    findingsSuppressed,
    availableSources,
  });

  return {
    kind: "OK",
    roomsEvaluated,
    rulesEvaluated,
    findingsCreated: inserted.created,
    findingsSuppressed,
    availableSources,
  };
}

/**
 * 客室ごとに A 系統・B 系統を畳む。
 *
 * **観察が無くても、清掃タスクがスキップを持っていれば観察系統として扱う。**
 * 「今回は記録しない」は現場が選べる正当な操作（PK-SPEC-P3 §1.3）で、
 * 系統の欠落ではない。
 */
function groupRoomFacts(
  occupancyRows: readonly {
    roomId: string;
    source: string;
    isOccupied: boolean;
    guestCount: number;
    reservationRef: string | null;
    checkInAt: Date | null;
    checkOutAt: Date | null;
    isStayover: boolean;
    nightsTotal: number | null;
    nightIndex: number | null;
    isComplimentary: boolean;
    isHouseUse: boolean;
    importedAt: Date;
  }[],
  observationRows: readonly {
    roomId: string;
    bedsUsed: number;
    trashLevel: "NONE" | "LOW" | "NORMAL" | "HIGH";
    bathTowelUsed: number;
    faceTowelUsed: number;
    handTowelUsed: number;
    bathMatUsed: number;
    slippersUsed: number;
    cupsUsed: number;
    extraFutonUsed: number;
    amenitiesUsed: Record<string, number | boolean>;
    usedDefaults: boolean;
    recordedAt: Date;
    recordedById: string;
  }[],
  taskRows: readonly { roomId: string; observationSkipped: boolean }[],
): Map<string, RoomFacts> {
  const facts = new Map<string, RoomFacts>();

  const put = (roomId: string, patch: Partial<RoomFacts>): void => {
    const current = facts.get(roomId) ?? { occupancy: null, observation: null };
    facts.set(roomId, { ...current, ...patch });
  };

  // 取込元が複数あれば優先順位で 1 つ選ぶ（DECISIONS #111）。
  const chosen = new Map<string, (typeof occupancyRows)[number]>();
  for (const row of occupancyRows) {
    const current = chosen.get(row.roomId);
    const rank = SOURCE_PRIORITY[row.source] ?? Number.MAX_SAFE_INTEGER;
    const currentRank =
      current === undefined
        ? Number.MAX_SAFE_INTEGER
        : (SOURCE_PRIORITY[current.source] ?? Number.MAX_SAFE_INTEGER);
    if (current === undefined || rank < currentRank) chosen.set(row.roomId, row);
  }

  for (const [roomId, row] of chosen) {
    put(roomId, {
      occupancy: {
        isOccupied: row.isOccupied,
        guestCount: row.guestCount,
        reservationRef: row.reservationRef,
        source: row.source as OccupancyFact["source"],
        importedAt: row.importedAt.getTime(),
        checkInAt: row.checkInAt?.getTime() ?? null,
        checkOutAt: row.checkOutAt?.getTime() ?? null,
        isStayover: row.isStayover,
        nightsTotal: row.nightsTotal,
        nightIndex: row.nightIndex,
        isComplimentary: row.isComplimentary,
        isHouseUse: row.isHouseUse,
      },
    });
  }

  for (const row of observationRows) {
    put(row.roomId, {
      observation: {
        skipped: false,
        bedsUsed: row.bedsUsed,
        trashLevel: row.trashLevel,
        bathTowelUsed: row.bathTowelUsed,
        faceTowelUsed: row.faceTowelUsed,
        handTowelUsed: row.handTowelUsed,
        bathMatUsed: row.bathMatUsed,
        slippersUsed: row.slippersUsed,
        cupsUsed: row.cupsUsed,
        extraFutonUsed: row.extraFutonUsed,
        amenitiesUsed: row.amenitiesUsed,
        usedDefaults: row.usedDefaults,
        recordedAt: row.recordedAt.getTime(),
        recordedById: row.recordedById,
      },
    });
  }

  for (const row of taskRows) {
    if (!row.observationSkipped) continue;
    if (facts.get(row.roomId)?.observation != null) continue;
    put(row.roomId, { observation: skippedObservation() });
  }

  return facts;
}

/** 「今回は記録しない」を選んだ観察。**数は 0 だが、記録が無いのとは違う。** */
function skippedObservation(): ObservationFact {
  return {
    skipped: true,
    bedsUsed: 0,
    trashLevel: "NONE",
    bathTowelUsed: 0,
    faceTowelUsed: 0,
    handTowelUsed: 0,
    bathMatUsed: 0,
    slippersUsed: 0,
    cupsUsed: 0,
    extraFutonUsed: 0,
    amenitiesUsed: {},
    usedDefaults: false,
    recordedAt: 0,
    recordedById: "",
  };
}

/**
 * 客室の販売状態を engine の語彙へ写す。**テストのために公開している。**
 *
 * **`MAINTENANCE` に対応する列が DB に無い**（`room.saleStatus` は
 * `AVAILABLE` / `OUT_OF_ORDER` の 2 値）。清掃ステータスの `BLOCKED` を
 * `MAINTENANCE` として渡す（DECISIONS #112）。どちらも §4.1 では
 * 同じ扱い（抑制する）なので、判定は変わらない。
 */
export function saleStatusOf(
  saleStatus: "AVAILABLE" | "OUT_OF_ORDER",
  housekeepingStatus: string,
): RuleContext["room"]["saleStatus"] {
  if (saleStatus === "OUT_OF_ORDER") return "OUT_OF_ORDER";
  if (housekeepingStatus === "BLOCKED") return "MAINTENANCE";
  return "ON_SALE";
}

/**
 * その客室・そのルールの誤検知件数（§4.2）。
 *
 * **施設全体として記録された行（`roomId = null`）も数える。** 「この施設では
 * このルールが当たらない」という判断は、どの客室にも効く。
 */
export function falsePositiveCountsOf(
  rows: readonly { roomId: string | null; ruleCode: string }[],
  roomId: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (row.roomId !== null && row.roomId !== roomId) continue;
    counts[row.ruleCode] = (counts[row.ruleCode] ?? 0) + 1;
  }
  return counts;
}

/** 登録済みルールの版（`auditFinding.ruleVersion`）。**未登録なら `0`。** */
const RULE_VERSIONS: ReadonlyMap<string, string> = new Map(
  RULES.map((rule) => [rule.code, rule.version]),
);

function ruleVersionOf(ruleCode: string): string {
  return RULE_VERSIONS.get(ruleCode) ?? "0";
}

/** 日数の差（切り捨て）。**負にならない。** */
export function daysBetween(from: Date, to: Date): number {
  const diff = to.getTime() - from.getTime();
  return Math.max(0, Math.floor(diff / DAY_MS));
}

/** 1 日のミリ秒。 */
const DAY_MS = 24 * 60 * 60 * 1000;

// ────────────────────────────────────────────────────────────
// P4-11 / P4-12 のルールが要る事実の組み立て
// ────────────────────────────────────────────────────────────

/**
 * 施設の地域時刻での「時」（0〜23）。**engine へ渡す値**（§3.3 / §3.9）。
 *
 * `localClockOf()` は `HH:MM` を返すので、時だけを取り出す。
 * **`Date` の地域変換を engine へ持ち込まない**ための境界がここ。
 */
export function localHourOf(at: Date, timezone: string): number | null {
  const clock = localClockOf(at, timezone);
  const hour = Number.parseInt(clock.slice(0, 2), 10);
  return Number.isFinite(hour) ? hour : null;
}

/**
 * その客室に効くベースラインを選ぶ（R003 / §3.4）。
 *
 * ── 客室タイプ × 人数 × 作業種別で絞る ──────────────────
 * PK-SPEC-P3 §5.2 の集計キー。**人数か作業種別が分からなければ空を返す。**
 * 別の人数の基準値を当てると、2 名の部屋を 1 名の基準で見ることになる。
 *
 * ── 信頼できない統計を engine へ渡さない ────────────────
 * PK-SPEC-P3 §2.4 MUST。**渡さないことが第一の防御**（ルール側の
 * 早期 return は、ルール単体で呼んだときのための二重の守り）。
 */
export function baselinesFor(
  rows: readonly {
    roomTypeId: string;
    guestCount: number;
    taskType: string;
    itemCode: string;
    sampleSize: number;
    medianQty: number;
    p90Qty: number;
    manualOverride: number | null;
    isReliable: boolean;
  }[],
  key: { roomTypeId: string; guestCount: number | null; taskType: string | null },
): BaselineFact[] {
  if (key.roomTypeId === "" || key.guestCount === null || key.taskType === null) return [];
  return rows
    .filter(
      (row) =>
        row.isReliable &&
        row.roomTypeId === key.roomTypeId &&
        row.guestCount === key.guestCount &&
        row.taskType === key.taskType,
    )
    .map((row) => ({
      itemCode: row.itemCode,
      sampleSize: row.sampleSize,
      medianQty: row.medianQty,
      // **手動上書きがあればそちらを使う**（PK-SPEC-P3 §5.5）。
      // 上書きは「うちの実態はこう」という運用の宣言で、算出値より優先する。
      p90Qty: row.manualOverride ?? row.p90Qty,
      isReliable: row.isReliable,
    }));
}

/** 監査ログの `after` を読む。**壊れていたら `null`**（例外にしない）。 */
function parseAuditPayload(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 監査ログの 1 行（`listAuditLogs()` が返す形の必要な部分）。 */
type AuditRow = {
  actorId: string;
  action: string;
  targetId: string | null;
  after: string | null;
  at: Date;
};

/**
 * 客室ステータスの手動上書きを取り出す（R010 / §3.8）。
 *
 * 元は `room.statusOverridden`（security.md §6）。`targetId` が客室 ID で、
 * `after` に更新後の状態が入る。**形が読めない行は落とす**
 * （監査ログの形は書き手が決めており、ここで例外にすると照合全体が止まる）。
 */
export function statusOverridesOf(rows: readonly AuditRow[]): StatusOverrideFact[] {
  const overrides: StatusOverrideFact[] = [];
  for (const row of rows) {
    if (row.action !== "room.statusOverridden" || row.targetId === null) continue;
    const after = parseAuditPayload(row.after);
    const toStatus = after?.["housekeepingStatus"];
    if (typeof toStatus !== "string") continue;
    overrides.push({ roomId: row.targetId, actorId: row.actorId, at: row.at.getTime(), toStatus });
  }
  return overrides;
}

/**
 * 稼働記録の取消を取り出す（R014 / §3.10）。
 *
 * 元は `occupancy.imported` の `after.changes[]`
 * （`{ roomId, field, before, after }` / `repositories/occupancy.ts`）。
 * **`isOccupied` が `true → false` になった行だけ**を拾う。
 *
 * @returns 客室 ID → 取消の時刻（複数あれば最後の 1 つ）。
 */
export function occupancyRevocationsOf(
  rows: readonly AuditRow[],
  businessDate: string,
): Map<string, number> {
  const revoked = new Map<string, number>();
  for (const row of rows) {
    if (row.action !== "occupancy.imported") continue;
    const after = parseAuditPayload(row.after);
    // **その業務日ぶんの取込だけ。** 別の日の取込で同じ客室が変わっても関係ない。
    if (after?.["businessDate"] !== businessDate) continue;

    const changes = after["changes"];
    if (!Array.isArray(changes)) continue;
    for (const change of changes as { roomId?: unknown; field?: unknown; before?: unknown; after?: unknown }[]) {
      if (change.field !== "isOccupied") continue;
      if (change.before !== true || change.after !== false) continue;
      if (typeof change.roomId !== "string") continue;
      revoked.set(change.roomId, row.at.getTime());
    }
  }
  return revoked;
}

/**
 * その客室の取消を engine の形へ（R014）。
 *
 * **清掃が完了していなければ `null`。** §3.10 の条件は「清掃完了後に」で、
 * 完了時刻が無ければ「後」を判定できない。
 */
export function revocationFor(
  revocations: ReadonlyMap<string, number>,
  roomId: string,
  cleaningCompletedAt: number | null,
): OccupancyRevocationFact | null {
  const at = revocations.get(roomId);
  if (at === undefined || cleaningCompletedAt === null) return null;
  return { at, cleaningCompletedAt };
}

/** `occupancy.checkOutAt` を業務日へ（R004 / §3.5）。**無ければ `null`。** */
export function checkOutBusinessDateOf(
  occupancy: OccupancyFact | null,
  property: { timezone: string; dayCutoffTime: string },
): string | null {
  if (occupancy?.checkOutAt == null) return null;
  return businessDateOf(new Date(occupancy.checkOutAt), property.timezone, property.dayCutoffTime);
}

/**
 * 退室日と当日の間に他の稼働記録があったか（R004 / §3.5）。
 *
 * ── 読むのは「空いている客室」だけ ──────────────────────
 * 退室が当日か前日の客室（＝通常の運用）は調べない。**1 施設ぶんの
 * 稼働記録を日数ぶん読むのは高い**（§10.6 の応答時間）ので、
 * 該当する客室が 1 室も無ければクエリを 1 本も出さない。
 *
 * @returns 客室 ID → `true`（間に稼働があった）/ `false`（無かった）。
 *   **調べなかった客室は Map に載せない**（呼び出し側で `null` になる）。
 */
async function collectOccupancyBetween(
  env: Env,
  ctx: TenantContext,
  input: {
    propertyId: string;
    businessDate: string;
    property: { timezone: string; dayCutoffTime: string };
    rooms: readonly { id: string; occupancy: OccupancyFact | null }[];
  },
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();

  const candidates = input.rooms.flatMap((room) => {
    const checkOutDate = checkOutBusinessDateOf(room.occupancy, input.property);
    if (checkOutDate === null) return [];
    const gap = businessDateDiff(checkOutDate, input.businessDate);
    // 「翌営業日以降」＝ 2 日以上。**遠すぎるものは調べない**（冒頭の注記）。
    if (gap === null || gap < 2 || gap > CHECKOUT_GAP_MAX_DAYS) return [];
    return [{ roomId: room.id, checkOutDate }];
  });
  if (candidates.length === 0) return result;

  // 対象の中で最も古い退室日から前日までを 1 回で読む。
  const earliest = candidates.reduce(
    (oldest, row) => (row.checkOutDate < oldest ? row.checkOutDate : oldest),
    candidates[0]?.checkOutDate ?? input.businessDate,
  );
  const rows = await listOccupancyInRange(env, ctx, {
    propertyId: input.propertyId,
    from: shiftBusinessDate(earliest, 1),
    to: shiftBusinessDate(input.businessDate, -1),
  });

  for (const candidate of candidates) {
    const between = rows.some(
      (row) =>
        row.roomId === candidate.roomId &&
        row.businessDate > candidate.checkOutDate &&
        row.businessDate < input.businessDate &&
        row.isOccupied,
    );
    result.set(candidate.roomId, between);
  }
  return result;
}

/**
 * `reconciliation` キューのハンドラ。
 *
 * **1 件ずつ ack / retry を決める。** バッチ全体を retry にすると、
 * 成功した施設まで照合し直すことになる。
 */
export async function handleReconciliationBatch(env: Env, batch: MessageBatch): Promise<void> {
  for (const message of batch.messages) {
    if (!isReconciliationMessage(message.body)) {
      // 形が違うものは**再送しても直らない。** ack して落とす。
      console.error("reconciliation-invalid-message");
      message.ack();
      continue;
    }
    const outcome = await runReconciliation(env, message.body);
    if (outcome.kind === "FAILED") message.retry();
    else message.ack();
  }
}
