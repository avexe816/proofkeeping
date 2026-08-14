/**
 * 汎用 Webhook で受けた物理シグナルの取込（PK-SPEC-P6 §4.2 / P6-04）。
 * **Queue コンシューマ。**
 *
 * task:  docs/tasks/P6-04.md
 * ルール: .claude/rules/architecture.md §5 / .claude/rules/security.md §3・§7
 *
 * ```
 * POST /api/v1/integrations/webhook/:integrationId（署名検証・200 即返し）
 *   → QUEUE_RECONCILIATION（kind: "SIGNAL_INGEST"）
 *     → ここ: マッピング解決 → physical_signal へ UPSERT → sync_log
 * ```
 *
 * ── なぜ専用キューを作らないのか ────────────────────────
 * architecture.md §5 のキューは 7 本で、`wrangler.toml` に静的宣言してある
 * （`tests/toolchain/wrangler.spec.ts` が本数を固定する）。8 本目を足すと
 * 4 環境ぶんの Cloudflare リソース作成が必要になり、**人手を待つ間
 * P6-04 が動かせない。** 物理シグナルは照合（C 系統）の入力そのもので、
 * `pk-reconciliation` に相乗りさせても宛先が散らからない。
 * メッセージは `kind` で判別する（`ReconciliationMessage` と同じ形）。
 * docs/DECISIONS.md #140。
 *
 * ── 冪等（testing.md §4）────────────────────────────────
 * 同じメッセージを 3 回処理しても `physical_signal` は増えない。効くのは
 * `insertPhysicalSignals()` の重複排除（`(deviceId, type, occurredAt)` /
 * §4.2 MUST）と `uq_signal`。**`sync_log` は毎回 1 行増える**が、これは
 * 受信の履歴であって業務データではない。3 回受けたことが見えるのが正しい。
 *
 * ── 落とすものと落とさないもの ──────────────────────────
 *   未知の `type` / 形が違うイベント → `recordsFailed`。**受信は成功。**
 *   未マッピングの機器             → `recordsSkipped`（§2.3 MUST）。
 *   連携が無い・組織が引けない      → ack して捨てる（再送しても直らない）。
 *   D1 が落ちている                → retry（呼び出し側が決める）。
 *
 * ── 個人情報 ────────────────────────────────────────────
 * `rawSample` に載せるのは先頭 3 件だけ。**`maskSensitive()` を通す**
 * （security.md §3）。`actorRef` は鍵・カードの識別子で個人名ではないが、
 * 顧客が何を入れてくるかはこちらで決められないので、マスクを通してから
 * 保存する。保持 7 日の掃除は `purgeSyncLogRawSamples()`。
 */

import {
  finishSyncLog,
  findIntegrationById,
  findPropertyById,
  insertPhysicalSignals,
  listRooms,
  lookupOrganizationId,
  markIntegrationSynced,
  maskSensitive,
  openIntegrationCircuit,
  resolveExternalIds,
  startSyncLog,
  type Env,
  type PhysicalSignalInput,
  type TenantContext,
} from "@pk/db";
import { MAX_WEBHOOK_EVENTS, webhookSignalEventSchema } from "@pk/contracts";
import { retryDelaySeconds, shouldOpenCircuit } from "@pk/integrations";

import { businessDateOf } from "../lib/businessDate.js";

/** 鍵の種別。**schema の語彙をそのまま使う**（`@pk/contracts` と一致する）。 */
type SignalActorTypeValue = NonNullable<PhysicalSignalInput["actorType"]>;

/** キューへ載せるメッセージ。**組織の解決に要る値を全部持たせる。** */
export interface SignalIngestMessage {
  kind: "SIGNAL_INGEST";
  /** 組織短縮 ID。**`organizationId` はコンシューマが引く**（受信口は D1 を触らない）。 */
  orgShortId: string;
  integrationId: string;
  /** 未検証のイベント。**1 件ずつここで検証する。** */
  events: readonly unknown[];
  /** 受信時刻（ミリ秒）。**再送でも変わらない。** */
  receivedAtMs: number;
}

/** メッセージの形を確かめる。**Zod を使わない**（contracts は API の入出力の定義）。 */
export function isSignalIngestMessage(value: unknown): value is SignalIngestMessage {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Record<string, unknown>;
  return (
    body["kind"] === "SIGNAL_INGEST" &&
    typeof body["orgShortId"] === "string" &&
    body["orgShortId"].length > 0 &&
    typeof body["integrationId"] === "string" &&
    body["integrationId"].length > 0 &&
    Array.isArray(body["events"]) &&
    body["events"].length <= MAX_WEBHOOK_EVENTS &&
    typeof body["receivedAtMs"] === "number"
  );
}

/** `rawSample` に残す件数（§2.2 の「先頭 3 件のみ」）。 */
export const RAW_SAMPLE_SIZE = 3;

/** 1 件の処理結果。**呼び出し側（`queue()`）が ack / retry を決める。** */
export type SignalIngestOutcome =
  | {
      kind: "OK";
      received: number;
      applied: number;
      skipped: number;
      failed: number;
      duplicate: number;
    }
  /** 再送しても直らない。**ack して落とす。** */
  | { kind: "DROPPED"; reason: string }
  /** 一時的な失敗。**retry。** */
  | {
      kind: "FAILED";
      reason: string;
      /** この回でサーキットブレーカーが開いたか（§3.4 / P6-07）。 */
      circuitOpened: boolean;
    };

/**
 * 1 メッセージぶんを処理する。
 *
 * **`ctx.now` を受信時刻にする。** 取込の記録（`receivedAt` / `syncLog`）は
 * 「いつ受けたか」で、Queue が再送するまでの遅れを混ぜない。
 */
export async function runSignalIngest(
  env: Env,
  message: SignalIngestMessage,
): Promise<SignalIngestOutcome> {
  const organizationId = await lookupOrganizationId(env, message.orgShortId);
  if (organizationId === null) {
    // 組織が存在しない。**署名は通っているので、消された組織の連携が
    // まだ送り続けている状態。** 再送しても直らない。
    return { kind: "DROPPED", reason: "ORGANIZATION_NOT_FOUND" };
  }

  const now = new Date(message.receivedAtMs);
  const ctx: TenantContext = {
    organizationId,
    orgShortId: message.orgShortId,
    // バッチはセッションを持たない。**組織全体ロールで動く**
    // （`consumers/rollup.ts` と同じ）。施設スコープは掛からない。
    role: "ORG_ADMIN",
    allowedPropertyIds: [],
    now,
  };

  // **越境 ID は `NotFoundError` で落ちる**（第 2 層）。受信口が
  // `integrationId` から組織を導いているので通常は起きないが、
  // 起きたときに retry へ倒すと同じメッセージが延々と再送される。
  let integration;
  try {
    integration = await findIntegrationById(env, ctx, message.integrationId);
  } catch {
    return { kind: "DROPPED", reason: "INTEGRATION_NOT_FOUND" };
  }
  if (integration === undefined) {
    return { kind: "DROPPED", reason: "INTEGRATION_NOT_FOUND" };
  }
  if (integration.status === "SUSPENDED") {
    // 止められている連携。**受け取らない**が、再送しても直らないので ack。
    return { kind: "DROPPED", reason: "INTEGRATION_SUSPENDED" };
  }

  const log = await startSyncLog(env, ctx, {
    integrationId: message.integrationId,
    direction: "INBOUND",
    trigger: "WEBHOOK",
  });

  try {
    const result = await applyEvents(env, ctx, message, integration.propertyId);

    await finishSyncLog(env, ctx, {
      syncLogId: log.id,
      // **未マッピングは失敗ではない**（§2.3 MUST）。1 件でも落ちたら
      // `PARTIAL`、**全件が形不正だったときだけ** `FAILED`。
      // 「全件が未マッピング」を `FAILED` にすると、W-24 に並ぶのが
      // 「連携が壊れている」に見えてしまう。直すべきは対応表であって
      // 連携ではない（W-13 が「未マッピング N 件」として別に見せる）。
      status:
        result.failed + result.skipped === 0
          ? "SUCCESS"
          : result.failed === result.received
            ? "FAILED"
            : "PARTIAL",
      recordsReceived: result.received,
      recordsApplied: result.applied,
      recordsSkipped: result.skipped,
      recordsFailed: result.failed,
      rawSample: result.rawSample,
      startedAt: log.startedAt,
    });
    // 受信できた時点で連携は生きている。**1 件も適用できなくても成功扱い。**
    // 未マッピングは連携の失敗ではなく設定の未完（W-13 が別に見せる）。
    await markIntegrationSynced(env, ctx, { integrationId: message.integrationId, ok: true });

    return { kind: "OK", ...result };
  } catch (error) {
    // D1 が落ちている等。**`syncLog` は `FAILED` のまま残る**（開始時の既定）。
    const reason = error instanceof Error ? error.message : "UNKNOWN";
    await markIntegrationSynced(env, ctx, {
      integrationId: message.integrationId,
      ok: false,
      // **外部システムの応答をそのまま入れない。** 内部の例外名まで。
      errorMessage: reason.slice(0, 200),
    });
    // §3.4: 5 回連続で失敗したらサーキットブレーカーを開く（P6-07）。
    // **`markIntegrationSynced()` の直後に読み直す。** あの関数は
    // `consecutiveFailures` を SQL で 1 増やすので、増えた後の値は
    // 引き直さないと分からない。
    const opened = await openCircuitIfNeeded(env, ctx, message.integrationId, reason);
    return { kind: "FAILED", reason, circuitOpened: opened };
  }
}

/**
 * 連続失敗が閾値に達していたら自動同期を止める（§3.4 / P6-07）。
 *
 * @returns **この呼び出しで開いたときだけ `true`。** 既に `ERROR` だった
 *   ものは `false`。`integration.error` の通知（§5.1）を毎回の失敗で
 *   送らないための区別で、通知そのものは P6-09。
 *
 * **ここで例外を投げない。** 開けなかったことで受信の処理結果まで
 * 変えると、「連携が失敗した」の上に「失敗の記録に失敗した」が乗る。
 */
export async function openCircuitIfNeeded(
  env: Env,
  ctx: TenantContext,
  integrationId: string,
  reason: string,
): Promise<boolean> {
  try {
    const current = await findIntegrationById(env, ctx, integrationId);
    if (current === undefined) return false;
    if (current.status === "ERROR" || current.status === "SUSPENDED") return false;
    if (!shouldOpenCircuit(current.consecutiveFailures)) return false;
    await openIntegrationCircuit(env, ctx, integrationId, reason);
    // **画面に出るのは W-13 の状態表示。** ここでは記録だけ。
    console.error(`integration-circuit-opened failures=${String(current.consecutiveFailures)}`);
    return true;
  } catch {
    return false;
  }
}

interface ApplyResult {
  received: number;
  applied: number;
  skipped: number;
  failed: number;
  duplicate: number;
  rawSample: unknown[];
}

/**
 * イベントを 1 件ずつ検証して書く。
 *
 * ── 業務日をどう決めるか ────────────────────────────────
 * `businessDate = (現地時刻 - 施設の日締め時刻) の日付`（architecture.md §7）。
 * **受信時刻ではなく `occurredAt` から求める。** ロックの記録と受信の間には
 * 数分の遅れがあり、深夜 0 時前後の解錠が翌業務日へずれる。
 *
 * 施設は**客室から引く**（機器 → 客室 → 施設）。連携が組織全体
 * （`propertyId = null`）でも、客室が施設を知っているので決まる。
 */
async function applyEvents(
  env: Env,
  ctx: TenantContext,
  message: SignalIngestMessage,
  integrationPropertyId: string | null,
): Promise<ApplyResult> {
  const received = message.events.length;
  const rawSample = message.events
    .slice(0, RAW_SAMPLE_SIZE)
    .map((event) => maskSensitive(event));

  // ① 形の検証。**未知の種類はここで落ちる**（`recordsFailed`）。
  const valid: ParsedEvent[] = [];
  let failed = 0;
  for (const event of message.events) {
    const parsed = parseEvent(event);
    if (parsed === null) {
      failed += 1;
      continue;
    }
    valid.push(parsed);
  }
  if (valid.length === 0) {
    return { received, applied: 0, skipped: 0, failed, duplicate: 0, rawSample };
  }

  // ② 機器 ID → 客室 ID。**引けない機器は例外にしない**（§2.3 MUST）。
  const mapping = await resolveExternalIds(env, ctx, {
    integrationId: message.integrationId,
    entityType: "ROOM",
    externalIds: valid.map((entry) => entry.deviceId),
  });

  // ③ 客室 → 施設。**照合の入力に施設が要る**（`physical_signal.propertyId`）。
  const roomIds = new Set([...mapping.values()]);
  const rooms = await listRooms(
    env,
    ctx,
    integrationPropertyId === null ? {} : { propertyId: integrationPropertyId },
  );
  const propertyByRoom = new Map(
    rooms.filter((row) => roomIds.has(row.id)).map((row) => [row.id, row.propertyId]),
  );

  // ④ 施設ごとの日締め時刻。**既定に倒さない**（施設ごとに違う / §7）。
  const clockByProperty = new Map<string, { timezone: string; dayCutoffTime: string }>();
  for (const propertyId of new Set(propertyByRoom.values())) {
    const property = await findPropertyById(env, ctx, propertyId);
    if (property === undefined) continue;
    clockByProperty.set(propertyId, {
      timezone: property.timezone,
      dayCutoffTime: property.dayCutoffTime,
    });
  }

  const signals: PhysicalSignalInput[] = [];
  let skipped = 0;
  for (const entry of valid) {
    const roomId = mapping.get(entry.deviceId);
    const propertyId = roomId === undefined ? undefined : propertyByRoom.get(roomId);
    const clock = propertyId === undefined ? undefined : clockByProperty.get(propertyId);
    if (roomId === undefined || propertyId === undefined || clock === undefined) {
      // 未マッピング、あるいは客室が無効化されている。**エラーにしない。**
      skipped += 1;
      continue;
    }
    const occurredAt = new Date(entry.occurredAt);
    signals.push({
      propertyId,
      roomId,
      businessDate: businessDateOf(occurredAt, clock.timezone, clock.dayCutoffTime),
      signalType: entry.type,
      occurredAt,
      // **省略は `null` のまま。`UNKNOWN` へ寄せない**（§4.3 MUST）。
      actorType: entry.actorType ?? null,
      actorRef: entry.actorRef ?? null,
      deviceId: entry.deviceId,
      // `rawPayload` を入れない。**生データは `syncLog.rawSample`（7 日）だけ。**
      // 照合の入力に残すと、保持期間の掛からない場所へ外部の生データが溜まる。
      rawPayload: null,
    });
  }

  const inserted = await insertPhysicalSignals(env, ctx, signals);
  return {
    received,
    applied: inserted.inserted,
    skipped,
    failed,
    duplicate: inserted.duplicate,
    rawSample,
  };
}

/** 検証を通ったイベント 1 件。 */
interface ParsedEvent {
  deviceId: string;
  type: PhysicalSignalInput["signalType"];
  occurredAt: string;
  actorType?: SignalActorTypeValue | undefined;
  actorRef?: string | undefined;
}

/** イベント 1 件を検証する。**形が違えば `null`**（呼び出し側が数える）。 */
function parseEvent(event: unknown): ParsedEvent | null {
  const result = webhookSignalEventSchema.safeParse(event);
  if (!result.success) return null;
  // `z.string().datetime()` は形しか見ない。**実在しない日付を弾く。**
  if (Number.isNaN(new Date(result.data.occurredAt).getTime())) return null;
  return result.data;
}

/**
 * バッチを処理する。
 *
 * **1 件ずつ ack / retry を決める。** バッチ全体を retry にすると、
 * 成功した受信まで取り込み直すことになる。
 *
 * ── リトライの間隔（§3.4 / P6-07）──────────────────────
 * 5 分 → 15 分 → 60 分、最大 3 回（`retryDelaySeconds()`）。
 * **4 回目は ack して落とす。** Cloudflare Queues の既定の再送は
 * 数秒間隔で、外部システムが落ちている間に同じ失敗を数十回積む。
 * `consecutiveFailures` が実際の障害の長さではなく再送の速さを映すと、
 * サーキットブレーカーの 5 回が意味を失う。
 *
 * 落としたイベントは失われるが、**送り側は再送してくる**（webhook の
 * 受信は 200 を返して初めて成功する / §4.2）。ここで無限に抱えるより、
 * `sync_log` に失敗として残して手放す方が復旧の見通しが立つ。
 */
export async function handleSignalIngestBatch(env: Env, batch: MessageBatch): Promise<void> {
  for (const message of batch.messages) {
    if (!isSignalIngestMessage(message.body)) {
      // 形が違うものは**再送しても直らない。** ack して落とす。
      console.error("signal-ingest-invalid-message");
      message.ack();
      continue;
    }
    const outcome = await runSignalIngest(env, message.body);
    if (outcome.kind === "FAILED") {
      console.error(`signal-ingest-failed reason=${outcome.reason}`);
      const delaySeconds = retryDelaySeconds(message.attempts);
      if (delaySeconds === null) {
        console.error("signal-ingest-retries-exhausted");
        message.ack();
      } else {
        message.retry({ delaySeconds });
      }
    } else {
      if (outcome.kind === "DROPPED") console.error(`signal-ingest-dropped reason=${outcome.reason}`);
      message.ack();
    }
  }
}
