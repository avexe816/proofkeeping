/**
 * 通知の配信（PK-SPEC-P6 §5.1〜§5.3 / P6-09）。**Queue コンシューマ。**
 *
 * task:  docs/tasks/P6-09.md
 * ルール: .claude/rules/ui-writing.md §6 / .claude/rules/security.md §1・§5
 *
 * ```
 * 業務イベント（差戻し・連携の失敗・…）
 *   → notify()（呼び出し側は投げるだけ。失敗を握りつぶす）
 *     → QUEUE_NOTIFICATION（kind: "NOTIFY"）
 *       → ここ: 宛先の解決 → チャネルの解決 → EMAIL 送信
 * ```
 *
 * ── 通知は補助機能（§1.3 MUST）────────────────────────
 * **通知が届かなくても全業務が成立すること。** 投入する側は
 * `notify()` の失敗を握りつぶし、業務の処理を止めない。ここが
 * 全滅しても、同じ情報は画面が出している（§5.2 MUST）。
 *
 * ── `IN_APP` は外へ送らない ─────────────────────────────
 * §2 に「アプリ内通知を貯める表」が無く、§5.2 MUST が「画面内でも同じ
 * 情報を提示する」と定める。したがって `IN_APP` は**既存の画面が
 * すでに出しているもの**を指し、この配信器は何もしない
 * （`lib/notification/events.ts` の注記 / OPEN_QUESTIONS #089）。
 * 実際に外へ出るのは `EMAIL` だけ。**`PUSH` は P6-10、`LINE` は P6-11。**
 *
 * ── 本文に詳細を入れない（ui-writing.md §6）──────────────
 * 件名と 1 行要約とリンクだけ。**差異の内容・金額・客室の状況・
 * 個人名を本文へ書かない。** 投入する側が `subject` / `summary` を
 * 作るので、そちらでも同じ制約が掛かる。
 *
 * ── 冪等（testing.md §4）─────────────────────────────────
 * 同じメッセージを 3 回処理しても**送信は 1 回だけ。** `dedupeKey` を
 * `CONFIG` KV に 24 時間置き、既にあれば送らない。
 *
 * **`CONFIG` に置いてよい理由。** architecture.md §1 は `CONFIG` が
 * 一括更新・一括削除・TTL 失効の対象だと注意するが、ここで困るのは
 * 「鍵が消えて同じ通知がもう 1 通届く」ことだけで、業務データは壊れない。
 * TTL の失効はむしろ望んだ挙動。`SHARD_MAP` を分けた理由（消えると
 * データが分裂する）はここには当てはまらない。
 */

import {
  findPropertyById,
  listNotificationPreferences,
  listNotificationRecipients,
  lookupOrganizationId,
  type Env,
  type NotificationEventCode,
  type Role,
  type TenantContext,
} from "@pk/db";

import { DEFAULT_TIMEZONE, localClockOf } from "../lib/businessDate.js";
import { audienceOf, findNotificationEvent } from "../lib/notification/events.js";
import { outboundChannelsOf, resolveChannels } from "../lib/notification/routing.js";

/** キューへ載せるメッセージ。 */
export interface NotifyMessage {
  kind: "NOTIFY";
  orgShortId: string;
  eventCode: NotificationEventCode;
  /**
   * 施設スコープのイベントなら施設 ID。組織全体なら `null`。
   *
   * **静音時間の判定にも効く。** 施設のタイムゾーンで「いま何時か」を
   * 決めるため（architecture.md §7）。`null` なら Asia/Tokyo で見る。
   */
  propertyId: string | null;
  /** 件名。**金額・個人名・差異の詳細を入れない**（ui-writing.md §6）。 */
  subject: string;
  /** 1 行要約。同上。 */
  summary: string;
  /** ProofKeeping 内のリンク先（`/app/...`）。**絶対 URL にしない。** */
  linkPath: string;
  /** 同じ通知を二度送らないための鍵。**投入側が決める。** */
  dedupeKey: string;
  /** 要求した時刻（ミリ秒）。**再送でも変わらない。** */
  requestedAtMs: number;
}

/** メッセージの形を確かめる。**Zod を使わない**（contracts は API の入出力の定義）。 */
export function isNotifyMessage(value: unknown): value is NotifyMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message["kind"] === "NOTIFY" &&
    typeof message["orgShortId"] === "string" &&
    message["orgShortId"].length > 0 &&
    typeof message["eventCode"] === "string" &&
    findNotificationEvent(message["eventCode"]) !== undefined &&
    (message["propertyId"] === null || typeof message["propertyId"] === "string") &&
    typeof message["subject"] === "string" &&
    typeof message["summary"] === "string" &&
    typeof message["linkPath"] === "string" &&
    typeof message["dedupeKey"] === "string" &&
    message["dedupeKey"].length > 0 &&
    typeof message["requestedAtMs"] === "number"
  );
}

/** 1 件の処理結果。**呼び出し側（`queue()`）が ack / retry を決める。** */
export type NotifyOutcome =
  | {
      kind: "OK";
      /** 実際に外へ送った通数。**`IN_APP` だけなら 0。** */
      sent: number;
      /** 宛先はいたが送らなかった数（設定・静音時間・メール未登録）。 */
      withheld: number;
    }
  /** 再送しても直らない。**ack して落とす。** */
  | { kind: "DROPPED"; reason: string }
  /** 一時的な失敗。**retry。** */
  | { kind: "FAILED"; reason: string };

/** 重複を止める鍵の保持時間（秒）。 */
export const DEDUPE_TTL_SECONDS = 24 * 60 * 60;

/** 既定のタイムゾーン。**施設が引けないときだけ使う**（architecture.md §7）。 */
const FALLBACK_TIMEZONE = DEFAULT_TIMEZONE;

/** `CONFIG` KV の鍵。**組織短縮 ID を前置して他組織と混ざらないようにする。** */
export function dedupeKvKey(orgShortId: string, dedupeKey: string): string {
  return `notify:${orgShortId}:${dedupeKey}`;
}

/**
 * 通知を 1 件配信する。
 *
 * **宛先が 0 人でも成功。** 対象ロールの在籍者がいない組織は普通にある。
 */
export async function runNotify(env: Env, message: NotifyMessage): Promise<NotifyOutcome> {
  const event = findNotificationEvent(message.eventCode);
  if (event === undefined) return { kind: "DROPPED", reason: "UNKNOWN_EVENT" };

  // 冪等（冒頭の注記）。**D1 を引く前に見る。** 再送は珍しくないので、
  // 重複と分かっているメッセージのためにシャードを 1 回引かない。
  const kvKey = dedupeKvKey(message.orgShortId, message.dedupeKey);
  try {
    if ((await env.CONFIG.get(kvKey)) !== null) {
      return { kind: "OK", sent: 0, withheld: 0 };
    }
  } catch {
    // KV が読めない。**送る側へ倒す。** 通知が 1 通重複するより、
    // 届かない方が困る（§1.3 の「補助機能」は「無くてよい」ではない）。
  }

  const organizationId = await lookupOrganizationId(env, message.orgShortId);
  if (organizationId === null) return { kind: "DROPPED", reason: "ORGANIZATION_NOT_FOUND" };

  const ctx: TenantContext = {
    organizationId,
    orgShortId: message.orgShortId,
    // バッチはセッションを持たない。**組織全体ロールで動く**
    // （`consumers/rollup.ts` と同じ）。施設スコープは掛からない。
    role: "ORG_ADMIN",
    allowedPropertyIds: [],
    now: new Date(message.requestedAtMs),
  };

  // 宛先のロール。**`COUNTERPARTY` はここでは扱えない**（組織の外で、
  // `membership` を持たない）。`period.review_requested` の宛先解決は
  // 取引先の連絡先を引く経路が要る（OPEN_QUESTIONS #090）。
  const roles = audienceOf(message.eventCode).filter(
    (audience): audience is Role => audience !== "COUNTERPARTY",
  );
  if (roles.length === 0) return { kind: "DROPPED", reason: "NO_INTERNAL_AUDIENCE" };

  try {
    const result = await deliver(env, ctx, message, roles);
    // 送り終えてから鍵を置く。**先に置くと、途中で落ちたときに
    // 1 通も送らないまま「送った」ことになる。**
    try {
      await env.CONFIG.put(kvKey, "1", { expirationTtl: DEDUPE_TTL_SECONDS });
    } catch {
      // 置けなくても配信は済んでいる。**再送で重複しうる**が、
      // 通知が 2 通届くのは業務を壊さない。
    }
    return { kind: "OK", ...result };
  } catch (error) {
    return { kind: "FAILED", reason: error instanceof Error ? error.name : "UNKNOWN" };
  }
}

/** 実際の配信。 */
async function deliver(
  env: Env,
  ctx: TenantContext,
  message: NotifyMessage,
  roles: readonly Role[],
): Promise<{ sent: number; withheld: number }> {
  const recipients = await listNotificationRecipients(env, ctx, {
    roles,
    propertyId: message.propertyId,
  });
  if (recipients.length === 0) return { sent: 0, withheld: 0 };

  const preferences = await listNotificationPreferences(env, ctx, {
    membershipIds: recipients.map((row) => row.membershipId),
    eventCode: message.eventCode,
  });

  // 静音時間は施設の地域時刻で決まる（architecture.md §7）。
  const timezone = await resolveTimezone(env, ctx, message.propertyId);
  const localTime = localClockOf(ctx.now, timezone);

  let sent = 0;
  let withheld = 0;
  for (const recipient of recipients) {
    const channels = resolveChannels({
      eventCode: message.eventCode,
      audience: recipient.role,
      preference: preferences.get(recipient.membershipId) ?? null,
      localTime,
      // **P6-10 まで購読を作る経路が無い。** `PUSH` は必ず `IN_APP` へ
      // 落ちる（§5.2 のフォールバックがそのまま働く）。P6-10 が
      // `listDeliverablePushMembershipIds()` の結果に差し替える。
      pushAvailable: false,
    });

    const outbound = outboundChannelsOf(channels);
    if (outbound.length === 0) {
      withheld += 1;
      continue;
    }

    // **いま外へ出せるのは EMAIL だけ**（`LINE` は P6-11）。
    if (!outbound.includes("EMAIL")) {
      withheld += 1;
      continue;
    }
    if (recipient.email === null) {
      // メール未登録。**エラーにしない**（`email` は任意項目 / security.md §2）。
      withheld += 1;
      continue;
    }

    const ok = await sendNotificationEmail(env, {
      to: recipient.email,
      subject: message.subject,
      body: notificationBody(message),
    });
    if (ok) sent += 1;
    else withheld += 1;
  }

  return { sent, withheld };
}

/** 施設のタイムゾーン。**引けなければ既定**（送らない側へ倒さない）。 */
async function resolveTimezone(
  env: Env,
  ctx: TenantContext,
  propertyId: string | null,
): Promise<string> {
  if (propertyId === null) return FALLBACK_TIMEZONE;
  try {
    const property = await findPropertyById(env, ctx, propertyId);
    return property?.timezone ?? FALLBACK_TIMEZONE;
  } catch {
    return FALLBACK_TIMEZONE;
  }
}

/**
 * 本文（ui-writing.md §6）。**1 行要約とリンクだけ。**
 *
 * 差異の内容・金額・客室の状況・個人名を書かない。
 * リンク先を開けば、権限のある人だけが詳細を見られる。
 */
export function notificationBody(
  message: Pick<NotifyMessage, "summary" | "linkPath">,
): string {
  return [message.summary, "", `ProofKeeping で確認する: ${message.linkPath}`].join("\n");
}

/**
 * Resend で 1 通送る。
 *
 * **例外を投げない。** 1 人への送信の失敗で他の宛先を巻き込まない。
 * `documentDelivery` に記録しないのは、あれが**帳票の送付**の記録で
 * （電帳法 / billing.md §2）、業務通知を混ぜると「いつ請求書を送ったか」
 * が引けなくなるため（OPEN_QUESTIONS #091）。
 */
async function sendNotificationEmail(
  env: Env,
  input: { to: string; subject: string; body: string },
): Promise<boolean> {
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.RESEND_FROM_ADDRESS,
        to: [input.to],
        subject: input.subject,
        text: input.body,
      }),
    });
    return response.ok;
  } catch {
    // **中身をログへ流さない**（宛先は個人情報 / security.md §3）。
    console.error("notify-email-failed");
    return false;
  }
}

/**
 * 通知を投げる（呼び出し側の入口）。
 *
 * **失敗を握りつぶす。** 通知は補助機能で（§1.3 MUST）、投入に失敗しても
 * 業務の処理を止めない。`consumers/rollup.ts` の投入と同じ方針
 * （DECISIONS #134）。
 */
export async function notify(env: Env, message: Omit<NotifyMessage, "kind">): Promise<void> {
  try {
    await env.QUEUE_NOTIFICATION.send({ kind: "NOTIFY", ...message } satisfies NotifyMessage);
  } catch {
    console.error(`notify-enqueue-failed event=${message.eventCode}`);
  }
}
