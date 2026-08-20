/**
 * 在留資格の期限アラート（P8-02 / PK-SPEC-P8 §1.4）。**Queue コンシューマ。**
 *
 * task:  docs/tasks/P8-02.md
 * 契約: docs/PK-IMPL-CONTRACT.md INV-08
 * ルール: .claude/rules/ui-writing.md §6 / .claude/rules/security.md §5
 *
 * ```
 * 毎日 07:00 JST（RESIDENCY_ALERT_CRON）
 *   → QUEUE_NOTIFICATION（kind: "RESIDENCY_ALERT"）
 *     → ここ: 台帳と在留資格を読んで数える → notify()（kind: "NOTIFY"）
 * ```
 *
 * **自分のキューへ送り返す形**になっている（NOTIFY も同じキュー）。
 * Cloudflare Queues はこれを許す。判定と配信を分けてあるのは、配信の
 * 冪等化（`dedupeKey`）と宛先の解決を `notify.ts` に一元化するため。
 *
 * ── 本文に個人名を書かない ──────────────────────────────
 * ui-writing.md §6「LINE には件名と 1 行要約＋リンクのみ。個人情報を
 * 含めない」。メールも同じ扱いにする。**載せるのは人数だけ**で、
 * 誰かは画面（/app/settings/staff）で見る。プロトタイプの画面は
 * 名前を出すが、あれは `ORG_ADMIN` しか開けない画面の中の話。
 *
 * ── 1 日 1 通に畳む ─────────────────────────────────────
 * スタッフごとに 1 通ずつ送ると、30 日を切った人数ぶん毎朝届く。
 * `dedupeKey` を組織 × 業務日にして、**毎日最大 1 通**。
 * 「毎日再通知」（§1.4）はこの 1 通が毎朝出続けることで満たす。
 *
 * ── 冪等（testing.md §4）─────────────────────────────────
 * 3 回処理しても送信は 1 回（`notify.ts` の `dedupeKey`）。
 * 読み取りだけなのでデータは変わらない。
 */

import {
  listResidencyRecords,
  listStaffLedger,
  lookupOrganizationId,
  type Env,
  type TenantContext,
} from "@pk/db";

import { businessDateOf } from "../lib/businessDate.js";
import { countResidencyAlerts } from "../lib/staff/residencyAlert.js";

import { notify } from "./notify.js";

/** キューへ載せるメッセージ。 */
export interface ResidencyAlertMessage {
  kind: "RESIDENCY_ALERT";
  orgShortId: string;
  /** 要求した時刻（ミリ秒）。**再送でも変わらない。** */
  requestedAtMs: number;
}

/** メッセージの形を確かめる。**NOTIFY と相乗りしているので `kind` が要。** */
export function isResidencyAlertMessage(value: unknown): value is ResidencyAlertMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message["kind"] === "RESIDENCY_ALERT" &&
    typeof message["orgShortId"] === "string" &&
    message["orgShortId"].length > 0 &&
    typeof message["requestedAtMs"] === "number"
  );
}

/** 1 件の処理結果。 */
export type ResidencyAlertOutcome =
  | { kind: "OK"; total: number; notified: boolean }
  /** 再送しても直らない。**ack して落とす。** */
  | { kind: "DROPPED"; reason: string }
  /** D1 の失敗。**retry。** */
  | { kind: "FAILED"; reason: string };

/**
 * 1 組織ぶんの判定と通知を行う。
 *
 * @param message `requestedAtMs` から時刻を作る。**`Date.now()` を呼ばない。**
 */
export async function runResidencyAlert(
  env: Env,
  message: ResidencyAlertMessage,
): Promise<ResidencyAlertOutcome> {
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
    const businessDate = businessDateOf(now);
    const [ledger, residency] = await Promise.all([
      listStaffLedger(env, ctx),
      listResidencyRecords(env, ctx),
    ]);

    const counts = countResidencyAlerts({ ledger, residency, businessDate });
    // **0 件なら送らない**（§1.4 のアラートは「いる」ときの通知）。
    if (counts.total === 0) return { kind: "OK", total: 0, notified: false };

    await notify(env, {
      orgShortId: ctx.orgShortId,
      eventCode: "residency.expiry_due",
      // 在留資格は組織の事実で、施設に紐づかない。
      propertyId: null,
      // **人数だけ。名前を載せない**（冒頭の注記）。
      subject: "在留資格の期限確認のお願い",
      summary: `期限の確認が必要なスタッフが ${String(counts.total)} 名います`,
      linkPath: "/app/settings/staff",
      // 1 日 1 通（冒頭の注記）。
      dedupeKey: `residency-expiry:${ctx.orgShortId}:${businessDate}`,
      requestedAtMs: message.requestedAtMs,
    });

    return { kind: "OK", total: counts.total, notified: true };
  } catch (error) {
    return { kind: "FAILED", reason: error instanceof Error ? error.name : "UNKNOWN" };
  }
}

/**
 * バッチを処理する。
 *
 * **retry の遅延を付けない。** 日次の実行で、急いで再送する理由が無い。
 */
export async function handleResidencyAlertBatch(env: Env, batch: MessageBatch): Promise<void> {
  for (const message of batch.messages) {
    if (!isResidencyAlertMessage(message.body)) {
      console.error("residency-alert-invalid-message");
      message.ack();
      continue;
    }
    const outcome = await runResidencyAlert(env, message.body);
    if (outcome.kind === "FAILED") {
      console.error(`residency-alert-failed reason=${outcome.reason}`);
      message.retry();
      continue;
    }
    if (outcome.kind === "DROPPED") {
      console.error(`residency-alert-skipped reason=${outcome.reason}`);
    }
    message.ack();
  }
}
