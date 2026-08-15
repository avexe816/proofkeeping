/**
 * 写真の保持期間の管理（PK-SPEC-P7 §4.5 / security.md §4 / P7-10）。
 * **Queue コンシューマ。**
 *
 * task:  docs/tasks/P7-10.md
 * ルール: .claude/rules/security.md §4
 *
 * ```
 * 日次 cron（02:00 JST に相乗り）
 *   → QUEUE_ARCHIVE_RESTORE（kind: "PHOTO_RETENTION"）
 *     → ここ: 期限切れを消す ＋ 30 日後に切れるぶんを管理者へ通知
 * ```
 *
 * ── これは「退避」ではない。本当に消える ────────────────
 * §19.7 のアーカイブは R2 に写しを残す。**こちらは写しを作らずに消す。**
 * だから `delete` と書く。P7 固有の絶対ルールが言い換えを求めているのは
 * 退避のほうで、ここではない。**消えたことが伝わらなくなる言い換えをしない。**
 *
 * ── 消す順序（いちばん大事）──────────────────────────────
 * **D1 の行を先に消し、R2 の実体を後に消す。** 逆にすると、途中で落ちた
 * ときに行が実体の無い写真を指し、**画面には出るのに開けない写真**ができる。
 * 行を先に消せば、残るのは参照されない R2 オブジェクト（費用だけの問題）。
 * `lib/offline/queue.ts` の `dropItem()` と同じ向き（INV-27）。
 *
 * ── 数えられないときは消さない ──────────────────────────
 * 版数が引けなければ**その回は何もしない。** 「引けないから既定の 6 か月」
 * にすると、上位プランの組織の写真を 7 か月早く消しうる。
 * 消すのは取り返しがつかないので、疑わしいときは消さない。
 *
 * ── 冪等（testing.md §4）─────────────────────────────────
 * 3 回走らせても結果は同じ。1 回目で消えた行は 2 回目の `select` に
 * 出てこない。R2 の `delete` は存在しないキーでも成功する。
 */

import {
  deletePhotoRows,
  findOrganization,
  listPhotosUploadedBefore,
  lookupOrganizationId,
  recordAudit,
  systemActorId,
  type Env,
  type ExpiringPhoto,
  type TenantContext,
} from "@pk/db";

import {
  PHOTO_DELETION_BATCH_LIMIT,
  PHOTO_TABLES,
  photoDeletionCutoffMs,
  photoNoticeCutoffMs,
  photoRetentionStateOf,
  resolvePhotoRetentionMonths,
  type PhotoRetentionPlan,
} from "../lib/photo/retention.js";
import { notify } from "./notify.js";

/** キューへ載せるメッセージ。 */
export interface PhotoRetentionMessage {
  kind: "PHOTO_RETENTION";
  orgShortId: string;
  /** 契約している版数。**dispatch が読んで載せる。** */
  plan: PhotoRetentionPlan;
  /** 要求した時刻（ミリ秒）。**再送でも変わらない。** */
  requestedAtMs: number;
}

const PLANS: readonly string[] = ["BASE", "PRO", "ENT"];

/** メッセージの形を確かめる。 */
export function isPhotoRetentionMessage(value: unknown): value is PhotoRetentionMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message["kind"] === "PHOTO_RETENTION" &&
    typeof message["orgShortId"] === "string" &&
    message["orgShortId"].length > 0 &&
    typeof message["plan"] === "string" &&
    PLANS.includes(message["plan"]) &&
    typeof message["requestedAtMs"] === "number"
  );
}

/** 1 件の処理結果。 */
export type PhotoRetentionOutcome =
  | {
      kind: "OK";
      /** 使った保持期間（月）。 */
      retentionMonths: number;
      /** 消した写真の枚数。 */
      deleted: number;
      /** 30 日以内に期限が来る枚数（通知に載せた値）。 */
      expiringSoon: number;
      /** 1 回の上限に達したか。**真なら消し残しがある。** */
      truncated: boolean;
    }
  /** 再送しても直らない。**ack して落とす。** */
  | { kind: "DROPPED"; reason: string }
  /** D1 / R2 の失敗。**retry。** */
  | { kind: "FAILED"; reason: string };

/**
 * 1 組織ぶんの保持期間管理を行う。
 *
 * @param now `message.requestedAtMs` から作る。**`Date.now()` を呼ばない。**
 */
export async function runPhotoRetention(
  env: Env,
  message: PhotoRetentionMessage,
): Promise<PhotoRetentionOutcome> {
  const organizationId = await lookupOrganizationId(env, message.orgShortId);
  if (organizationId === null) return { kind: "DROPPED", reason: "ORGANIZATION_NOT_FOUND" };

  const now = new Date(message.requestedAtMs);
  const ctx: TenantContext = {
    organizationId,
    orgShortId: message.orgShortId,
    // バッチはセッションを持たない。**組織全体ロールで動く。**
    role: "ORG_ADMIN",
    allowedPropertyIds: [],
    now,
  };

  try {
    const organization = await findOrganization(env, ctx);
    // **組織が引けなければ何もしない。** 保持期間の上書きが読めないまま
    // 消すと、延長した設定を無視して消しうる。
    if (organization === undefined) return { kind: "DROPPED", reason: "ORGANIZATION_NOT_FOUND" };

    const retentionMonths = resolvePhotoRetentionMonths(
      message.plan,
      organization.photoRetentionMonths,
    );
    const deletionCutoff = photoDeletionCutoffMs(now, retentionMonths);
    const noticeCutoff = photoNoticeCutoffMs(now, retentionMonths);

    let deleted = 0;
    let expiringSoon = 0;
    let truncated = false;

    for (const table of PHOTO_TABLES) {
      // **1 回の select で両方を賄う。** 期限切れも「30 日以内」も
      // `noticeCutoff` より前なので、まとめて読んでから振り分ける。
      const candidates = await listPhotosUploadedBefore(env, ctx, {
        table,
        beforeMs: noticeCutoff,
        // 上限に達したかを知るために 1 枚多く読む。
        limit: PHOTO_DELETION_BATCH_LIMIT + 1,
      });
      if (candidates.length > PHOTO_DELETION_BATCH_LIMIT) truncated = true;

      const expired: ExpiringPhoto[] = [];
      for (const photo of candidates.slice(0, PHOTO_DELETION_BATCH_LIMIT)) {
        const state = photoRetentionStateOf(photo.uploadedAtMs, now, retentionMonths);
        if (state === "EXPIRED") expired.push(photo);
        else if (state === "EXPIRING_SOON") expiringSoon += 1;
      }
      if (expired.length === 0) continue;

      // ① D1 の行を先に消す（冒頭の注記）。
      const removed = await deletePhotoRows(env, ctx, {
        table,
        ids: expired.map((photo) => photo.id),
      });
      deleted += removed;

      // ② R2 の実体を後に消す。**失敗しても止めない。**
      // 参照されないオブジェクトが残るだけで、業務は成立する。
      for (const photo of expired) {
        try {
          await env.PHOTOS.delete(photo.storageKey);
        } catch {
          // 掃除は別の回に持ち越す。ここで retry すると行の削除が二重に走る。
        }
      }
    }

    // §4.5「削除件数を監査ログに記録する」。**0 件でも記録する**
    // （「走ったが 0 件」と「走っていない」を区別できるようにする）。
    await recordAudit(env, ctx, {
      actorId: systemActorId(ctx.orgShortId),
      action: "photo.retentionDeleted",
      targetType: "photo",
      after: { deleted, retentionMonths, truncated, cutoffMs: deletionCutoff },
    });

    // §4.5 MUST「削除の 30 日前に管理者へ通知し」。**0 件なら送らない。**
    if (expiringSoon > 0) {
      await notify(env, {
        orgShortId: ctx.orgShortId,
        eventCode: "photo.retention_due",
        // 組織全体の設定の話で、施設に紐づかない。
        propertyId: null,
        // **枚数だけ。** どの写真かは載せない（ui-writing.md §6 と同じ向き）。
        subject: "写真の保持期限のお知らせ",
        summary: `${String(expiringSoon)} 枚が 30 日後に保持期限を迎えます（保持 ${String(retentionMonths)} か月）`,
        linkPath: "/app/settings/organization",
        // **1 日 1 通に畳む。** 日次バッチなので、業務日ごとに 1 つ。
        dedupeKey: `photo-retention:${ctx.orgShortId}:${new Date(message.requestedAtMs).toISOString().slice(0, 10)}`,
        requestedAtMs: message.requestedAtMs,
      });
    }

    return { kind: "OK", retentionMonths, deleted, expiringSoon, truncated };
  } catch (error) {
    return { kind: "FAILED", reason: error instanceof Error ? error.name : "UNKNOWN" };
  }
}

/**
 * バッチを処理する。
 *
 * **retry の遅延を付けない。** 日次の実行で、急いで再送する理由が無い。
 */
export async function handlePhotoRetentionBatch(env: Env, batch: MessageBatch): Promise<void> {
  for (const message of batch.messages) {
    if (!isPhotoRetentionMessage(message.body)) {
      console.error("photo-retention-invalid-message");
      message.ack();
      continue;
    }
    const outcome = await runPhotoRetention(env, message.body);
    if (outcome.kind === "FAILED") {
      console.error(`photo-retention-failed reason=${outcome.reason}`);
      message.retry();
      continue;
    }
    if (outcome.kind === "DROPPED") {
      console.error(`photo-retention-skipped reason=${outcome.reason}`);
    } else if (outcome.truncated) {
      // **黙って打ち切らない**（`retention.ts` の注記）。
      console.log(`photo-retention-truncated deleted=${String(outcome.deleted)}`);
    }
    message.ack();
  }
}
