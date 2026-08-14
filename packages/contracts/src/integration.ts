/**
 * 汎用 Webhook 受信口の入力（PK-SPEC-P6 §4.2 / P6-04）。
 *
 * task:  docs/tasks/P6-04.md
 * ルール: .claude/rules/security.md §7
 *
 * ── 受け取らないもの ────────────────────────────────────
 * **宿泊者に関する欄が 1 つも無い**（security.md §3）。ロックが返すのは
 * 「いつ・どの機器が・どんな操作をされたか」だけで、誰が泊まっているかは
 * 照合に要らない。`actorRef` は鍵・カードの識別子で、**個人名を入れない。**
 *
 * **`organizationId` を受け取らない**（CLAUDE.md §4 / INV-32）。この経路は
 * セッションを持たないが、組織は URL の `integrationId`（自己記述 ID）から
 * 解決する。ボディからは受け取らない。
 *
 * ── 未知の `type` を落とす場所 ──────────────────────────
 * `signalType` は語彙で縛る。**知らない種類が来たら 1 件だけ落として、
 * 受信そのものは成功させる**（連携が 1 種類の未知イベントで全部止まらない
 * ようにする / §1.2）。落とした件数は `syncLog.recordsSkipped` に出る。
 * そのためこのスキーマは**イベント 1 件ずつに掛ける**（配列全体で
 * `parse()` しない）。
 */

import { z } from "zod";

/** 物理シグナルの種類。`packages/db` の `SIGNAL_TYPES` と同じ並び。 */
export const SIGNAL_TYPES = [
  "DOOR_UNLOCK",
  "DOOR_OPEN",
  "KEY_ISSUE",
  "POWER_ON",
  "WIFI_JOIN",
  "SELF_CHECKIN",
  "SAFE_USE",
  "MINIBAR_SENSOR",
] as const;

export const signalTypeSchema = z.enum(SIGNAL_TYPES);

export type SignalTypeValue = (typeof SIGNAL_TYPES)[number];

/**
 * 鍵の種別。`packages/db` の `SIGNAL_ACTOR_TYPES` と同じ並び。
 *
 * **省略と `UNKNOWN` を区別しない**（§4.3）。どちらも「取得できていない」で、
 * 差異詳細画面には「鍵の種別は取得できていません」と出る。
 */
export const SIGNAL_ACTOR_TYPES = [
  "GUEST_KEY",
  "STAFF_KEY",
  "MASTER_KEY",
  "MOBILE_KEY",
  "UNKNOWN",
] as const;

export const signalActorTypeSchema = z.enum(SIGNAL_ACTOR_TYPES);

/** 機器 ID の長さ。 */
export const MAX_DEVICE_ID_LENGTH = 128;

/** 鍵・カード識別子の長さ。 */
export const MAX_ACTOR_REF_LENGTH = 128;

/**
 * 1 回の受信で受け取るイベントの上限。
 *
 * §8 のレート制限（1200 req/分/integration）と合わせて、1 分あたりの
 * 上限を有限にする。**超えた本文は 413 で拒む。** 巨大な本文で
 * リクエストハンドラの CPU 予算（50ms）を焼かせない。
 */
export const MAX_WEBHOOK_EVENTS = 500;

/** 本文の上限（バイト）。署名の対象は生の本文なので、読む前に切る。 */
export const MAX_WEBHOOK_BODY_BYTES = 512 * 1024;

/**
 * イベント 1 件（§4.2 のボディ）。
 *
 * `occurredAt` は ISO 8601。**受信時刻で代用しない。** ロックの記録と
 * 受信の間には数分の遅れがあり、代用すると業務日がずれる
 * （architecture.md §7）。
 */
export const webhookSignalEventSchema = z.object({
  deviceId: z.string().min(1).max(MAX_DEVICE_ID_LENGTH),
  type: signalTypeSchema,
  occurredAt: z.iso.datetime({ offset: true }),
  actorType: signalActorTypeSchema.optional(),
  /** 鍵・端末の識別子。**個人名を入れない**（security.md §3）。 */
  actorRef: z.string().min(1).max(MAX_ACTOR_REF_LENGTH).optional(),
});

export type WebhookSignalEvent = z.infer<typeof webhookSignalEventSchema>;

/**
 * 受信本文の外枠。
 *
 * 中身のイベントは `z.unknown()` で受けて**1 件ずつ**
 * `webhookSignalEventSchema` に掛ける（上の注記）。
 */
export const webhookSignalBodySchema = z.object({
  events: z.array(z.unknown()).min(1).max(MAX_WEBHOOK_EVENTS),
});

export type WebhookSignalBody = z.infer<typeof webhookSignalBodySchema>;

/**
 * 受信の応答。
 *
 * **件数を返さない。** 処理は Queue へ渡した時点で応答するので（§4.2 MUST）、
 * 適用件数はまだ決まっていない。返すと「送った側が信じる嘘」になる。
 * 結果は W-24（同期ログ）で見る。
 */
export const webhookAcceptedSchema = z.object({
  received: z.literal(true),
});

export type WebhookAccepted = z.infer<typeof webhookAcceptedSchema>;
