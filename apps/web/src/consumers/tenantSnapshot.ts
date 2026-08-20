/**
 * テナントのスナップショット（PF-02 / DECISIONS #220 の 2）。**Queue コンシューマ。**
 *
 * task:  docs/tasks/PF-02.md
 * ルール: .claude/rules/architecture.md §3・§5 / testing.md §4
 *
 * ```
 * 02:00 JST → 全組織を QUEUE_ROLLUP_UPDATE へ（1 テナント 1 通）
 *           → ここで**その 1 テナントだけ**を読み、SHARD_00 へ 1 行書く
 *           → 運営画面はその表だけを読む
 * ```
 *
 * ── 1 通が触るテナントは 1 つ（完了条件）───────────────
 * `lookupOrganizationId()` で 1 組織を解決し、その `ctx` でしか読まない。
 * **複数テナントを 1 通に詰めない。** 詰めると部分的に失敗したときの
 * 再送で、成功したテナントまで数え直す。
 *
 * ── 再計算方式（architecture.md §3）─────────────────────
 * 受け取るのは「どのテナントの、どの業務日か」だけ。差分を持たせない。
 * **3 回流しても結果が変わらない**（`upsertTenantSnapshot()` の `id` が
 * 組織と業務日から決まるので、行が増えることもない）。
 *
 * ── 集計の元は rollup と既存の口 ────────────────────────
 * 完了タスク数は `daily_property_rollup` の施設合計。**タスク表を直に
 * 数えない**（architecture.md §3 / PK-SPEC-P0 §26）。
 *
 * ── 運営面へ個人を渡さない（INV-10）─────────────────────
 * 数えるのは人数まで。氏名・メール・端末 ID・記録者は 1 つも載せない
 * （`summarizeObservationInput()` が `recordedById` を選ばない）。
 *
 * ── 判定をここでしない ──────────────────────────────────
 * 「要支援」は読むときに閾値と突き合わせて出す（`judgeTenantQuality()`）。
 * 閾値は PF-14 の「運用（変更可）」から来るので、**焼き込むと値を変えた
 * 瞬間に過去の行と食い違う。**
 */

import { medianDurationMs } from "@pk/engine";
import {
  countActiveMembersByLocale,
  countActiveMembershipsByRole,
  countRooms,
  countSellableRoomsByProperty,
  countSkippedObservations,
  countTaskPhotosByBusinessDate,
  findOrganization,
  findSubscription,
  listProperties,
  listPropertyRollups,
  lookupOrganizationId,
  summarizeObservationInput,
  upsertTenantSnapshot,
  type Env,
  type TenantContext,
} from "@pk/db";

import { businessDateOf } from "../lib/businessDate.js";

/**
 * キューへ載せるメッセージ。
 *
 * **`pk-rollup-update` に相乗りしている**（DECISIONS #140 / #160 と同じ判断 —
 * 8 本目のキューを作ると 4 環境ぶんの Cloudflare リソース作成が要る）。
 * `kind` で `ROLLUP_UPDATE` と分ける。
 */
export interface TenantSnapshotMessage {
  kind: "TENANT_SNAPSHOT";
  orgShortId: string;
  /** 要求した時刻（ミリ秒）。**再送でも変わらない。** */
  requestedAtMs: number;
}

const BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** メッセージの形を確かめる。**ROLLUP_UPDATE と相乗りしているので `kind` が要。** */
export function isTenantSnapshotMessage(value: unknown): value is TenantSnapshotMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message["kind"] === "TENANT_SNAPSHOT" &&
    typeof message["orgShortId"] === "string" &&
    message["orgShortId"].length > 0 &&
    typeof message["requestedAtMs"] === "number" &&
    Number.isFinite(message["requestedAtMs"])
  );
}

/** 1 件の処理結果。 */
export type TenantSnapshotOutcome =
  | { kind: "OK"; businessDate: string }
  /** 再送しても直らない。**ack して落とす。** */
  | { kind: "DROPPED"; reason: string }
  /** D1 の失敗。**retry。** */
  | { kind: "FAILED"; reason: string };

/** `timestamp_ms` を業務日の文字列にする。**時刻を落とす。** */
function dateOnly(value: Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const iso = value.toISOString();
  return iso.slice(0, 10);
}

/**
 * 1 テナントぶんのスナップショットを作る。
 *
 * @param message `requestedAtMs` から時刻を作る。**`Date.now()` を呼ばない。**
 */
export async function runTenantSnapshot(
  env: Env,
  message: TenantSnapshotMessage,
): Promise<TenantSnapshotOutcome> {
  const organizationId = await lookupOrganizationId(env, message.orgShortId);
  if (organizationId === null) return { kind: "DROPPED", reason: "ORGANIZATION_NOT_FOUND" };

  const now = new Date(message.requestedAtMs);
  const businessDate = businessDateOf(now);
  if (!BUSINESS_DATE_PATTERN.test(businessDate)) {
    return { kind: "DROPPED", reason: "BUSINESS_DATE_INVALID" };
  }

  const ctx: TenantContext = {
    organizationId,
    orgShortId: message.orgShortId,
    // バッチはセッションを持たない。**組織全体ロールで動く。**
    role: "ORG_ADMIN",
    allowedPropertyIds: [],
    now,
  };

  try {
    const [organization, subscription, properties, roomCount, sellableByProperty, membersByRole] =
      await Promise.all([
        findOrganization(env, ctx),
        findSubscription(env, ctx),
        listProperties(env, ctx),
        countRooms(env, ctx),
        countSellableRoomsByProperty(env, ctx),
        countActiveMembershipsByRole(env, ctx),
      ]);

    if (organization === undefined) return { kind: "DROPPED", reason: "ORGANIZATION_MISSING" };

    // 完了タスク数は rollup の施設合計。**タスク表を直に数えない。**
    const [rollups, observations, skipped, photoCount, localeCounts] = await Promise.all([
      listPropertyRollups(env, ctx, businessDate),
      summarizeObservationInput(env, ctx, businessDate),
      countSkippedObservations(env, ctx, businessDate),
      countTaskPhotosByBusinessDate(env, ctx, businessDate),
      countActiveMembersByLocale(env, ctx),
    ]);

    let completedTasks = 0;
    // 差異は rollup の施設合計（PF-05）。**差異の表を直に数えない。**
    let findingsHigh = 0;
    for (const rollup of rollups) {
      completedTasks += rollup.completedTasks;
      findingsHigh += rollup.findingsHigh;
    }

    let billableRoomCount = 0;
    for (const count of sellableByProperty.values()) billableRoomCount += count;

    let staffCount = 0;
    for (const count of membersByRole.values()) staffCount += count;

    await upsertTenantSnapshot(env, {
      organizationId,
      businessDate,
      name: organization.name,
      plan: subscription?.plan ?? null,
      // **運営面の 4 状態（稼働 / 試用 / 注意 / 停止）へ翻訳しない。**
      // 「注意」は品質の判定から出るもので、契約状態とは別の軸。
      subscriptionStatus: subscription?.status ?? null,
      contractedOn: dateOnly(subscription?.createdAt ?? organization.createdAt),
      trialEndsOn: dateOnly(subscription?.trialEndsAt),
      propertyCount: properties.length,
      roomCount,
      billableRoomCount,
      staffCount,
      completedTasks,
      observationsRecorded: observations.recorded,
      observationsSkipped: skipped,
      observationsUsedDefaults: observations.usedDefaults,
      // 中央値は純粋関数（SQLite に中央値の集約が無い）。
      inputDurationMedianMs: medianDurationMs(observations.durationsMs),
      findingsHigh,
      photoCount,
      // **誰が何語かは持たない。** 言語 → 人数だけ（INV-10）。
      localeCounts: Object.fromEntries(localeCounts),
      now,
    });

    return { kind: "OK", businessDate };
  } catch (error) {
    return { kind: "FAILED", reason: error instanceof Error ? error.name : "UNKNOWN" };
  }
}

/**
 * バッチを処理する。
 *
 * **retry の遅延を付けない。** 日次の実行で、急いで再送する理由が無い。
 * ログに組織 ID を出さない（architecture.md §1）。
 */
export async function handleTenantSnapshotBatch(env: Env, batch: MessageBatch): Promise<void> {
  for (const message of batch.messages) {
    if (!isTenantSnapshotMessage(message.body)) {
      console.error("tenant-snapshot-invalid-message");
      message.ack();
      continue;
    }
    const outcome = await runTenantSnapshot(env, message.body);
    if (outcome.kind === "FAILED") {
      console.error(`tenant-snapshot-failed reason=${outcome.reason}`);
      message.retry();
      continue;
    }
    if (outcome.kind === "DROPPED") {
      console.error(`tenant-snapshot-skipped reason=${outcome.reason}`);
    }
    message.ack();
  }
}
