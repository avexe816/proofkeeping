/**
 * 通知イベントの定義（PK-SPEC-P6 §5.1 の 10 イベント）。**純粋。**
 *
 * task:  docs/tasks/P6-09.md
 * ルール: .claude/rules/ui-writing.md §6 / .claude/rules/security.md §1
 *
 * ── 通知は補助機能（§1.3 MUST）────────────────────────
 * **通知が届かなくても全業務が成立すること。** P1 で定めた
 * 「画面を開けば分かる」原則を崩さない。この表は「誰に何を送るか」を
 * 決めるだけで、**業務が進む条件をここに置かない。**
 *
 * ── `IN_APP` に配信の実体が無い ─────────────────────────
 * §2 のデータモデルに**アプリ内通知を貯める表が無い**（あるのは
 * `push_subscription` と `notification_preference` の 2 つ）。
 * §5.2 MUST が「通知が届かないことを前提に、必ず画面内でも同じ情報を
 * 提示する」と定めていることと合わせて読むと、`IN_APP` は
 * **既存の画面がすでに出しているもの**を指す：
 *
 *   `task.rework_assigned`    → M-02 の「再清掃」バッジ（P2-07）
 *   `inspection.sla_exceeded` → M-08 検査待ち一覧（P2-05）
 *   `room.urgent`             → W-03 / M-10 客室ボード
 *   `lostitem.retention_due`  → 忘れ物一覧（P2-13）
 *
 * したがって配信側が実際に外へ出すのは `PUSH` / `EMAIL` / `LINE` の
 * 3 つで、**`IN_APP` は「外へは送らない」を意味する。**
 * 表に残してあるのは、`PUSH` の条件を満たさない端末が `IN_APP` へ
 * 落ちる（§5.2）ことを型として表せるようにするため。
 * 通知センターの画面を作るかは docs/OPEN_QUESTIONS.md #089。
 *
 * ── 「取引先」はロールではない ──────────────────────────
 * §5.1 の `period.review_requested` の対象は「取引先」で、
 * security.md §1 の 7 ロールのどれでもない。**組織の外の相手**なので
 * `COUNTERPARTY` という別の宛先種別にした。ロールの表に混ぜると、
 * `assertPermission()` が扱えない値が権限判定へ流れ込む。
 */

import type { NotificationChannel, NotificationEventCode, Role } from "@pk/db";

/**
 * 宛先の種別。
 *
 * 7 ロール＋`COUNTERPARTY`（組織の外の取引先）。
 */
export type NotificationAudience = Role | "COUNTERPARTY";

/** イベント 1 件の定義。 */
export interface NotificationEventDefinition {
  code: NotificationEventCode;
  /** §5.1 の「既定チャネル」。利用者が `notification_preference` で上書きできる。 */
  defaultChannels: readonly NotificationChannel[];
  /** §5.1 の「対象ロール」。**ここに無い相手へは送らない。** */
  audience: readonly NotificationAudience[];
  /**
   * 静音時間（22:00-07:00）を無視するか（§5.3）。
   *
   * **例外は `issue.critical` だけ。** 他を無視させたくなったら、
   * それは通知を業務の必須要素にし始めた合図（§1.3 MUST）。
   */
  ignoresQuietHours: boolean;
}

/**
 * §5.1 の表と、そこに無い 2 件。**12 件。§5.1 のぶんは順序も仕様のまま。**
 *
 * **`photo.retention_due`（#163）と `archive.restore_ready`（#166）が
 * §5.1 に無い。** どちらも P7 の MUST が通知を要求しているのに、
 * §5.1 の表が P7 を織り込んでいないため。仕様の版上げで §5.1 へ
 * 入れること（OPEN_QUESTIONS #097）。
 *
 * 語彙（`NOTIFICATION_EVENT_CODES`）は `packages/db` にある。
 * ここが持つのは「どのチャネルへ、誰へ」という配信の方針。
 */
export const NOTIFICATION_EVENTS: readonly NotificationEventDefinition[] = [
  {
    code: "task.rework_assigned",
    defaultChannels: ["IN_APP"],
    // **`CLEANER` に届いてよい唯一のイベント**（§5.1 MUST / security.md §1）。
    audience: ["CLEANER"],
    ignoresQuietHours: false,
  },
  {
    code: "inspection.sla_exceeded",
    defaultChannels: ["IN_APP"],
    audience: ["PROPERTY_MANAGER"],
    ignoresQuietHours: false,
  },
  {
    code: "room.urgent",
    defaultChannels: ["IN_APP", "PUSH"],
    audience: ["PROPERTY_MANAGER"],
    ignoresQuietHours: false,
  },
  {
    code: "issue.critical",
    defaultChannels: ["IN_APP", "PUSH", "EMAIL"],
    audience: ["PROPERTY_MANAGER"],
    // §5.3 の唯一の例外。
    ignoresQuietHours: true,
  },
  {
    code: "finding.high",
    defaultChannels: ["EMAIL"],
    audience: ["OWNER", "ORG_ADMIN"],
    ignoresQuietHours: false,
  },
  {
    code: "integration.error",
    defaultChannels: ["EMAIL"],
    audience: ["ORG_ADMIN"],
    ignoresQuietHours: false,
  },
  {
    code: "invoice.sent",
    defaultChannels: ["EMAIL"],
    audience: ["ORG_ADMIN"],
    ignoresQuietHours: false,
  },
  {
    code: "invoice.overdue",
    defaultChannels: ["EMAIL"],
    audience: ["ORG_ADMIN"],
    ignoresQuietHours: false,
  },
  {
    code: "period.review_requested",
    defaultChannels: ["EMAIL"],
    // 組織の外。ロールではない（上の注記）。
    audience: ["COUNTERPARTY"],
    ignoresQuietHours: false,
  },
  {
    code: "lostitem.retention_due",
    defaultChannels: ["IN_APP", "EMAIL"],
    audience: ["PROPERTY_MANAGER"],
    ignoresQuietHours: false,
  },
  {
    // P7-10。**§5.1 の 10 件に無い 11 件目**（DECISIONS #163 /
    // OPEN_QUESTIONS #097）。§4.5 MUST が「削除の 30 日前に**管理者へ**
    // 通知し」と定めており、宛先が `PROPERTY_MANAGER` の
    // `lostitem.retention_due` では代用できない。
    code: "photo.retention_due",
    defaultChannels: ["IN_APP", "EMAIL"],
    audience: ["OWNER", "ORG_ADMIN"],
    ignoresQuietHours: false,
  },
  {
    // P7-09。**§5.1 の 10 件に無い 12 件目**（DECISIONS #166）。
    // §9.1 の手順 4 が「完了をメール通知」と定めている。
    // 復元を要求できるのは管理者だけなので、宛先も管理者。
    code: "archive.restore_ready",
    defaultChannels: ["IN_APP", "EMAIL"],
    audience: ["OWNER", "ORG_ADMIN"],
    ignoresQuietHours: false,
  },
];

/** コード → 定義。**同じコードを 2 度書いていないことを読み込み時に落とす。** */
const BY_CODE: ReadonlyMap<NotificationEventCode, NotificationEventDefinition> = (() => {
  const map = new Map<NotificationEventCode, NotificationEventDefinition>();
  for (const event of NOTIFICATION_EVENTS) {
    if (map.has(event.code)) throw new Error(`DUPLICATE_NOTIFICATION_EVENT:${event.code}`);
    map.set(event.code, event);
  }
  return map;
})();

/** 定義を引く。**知らないコードは `undefined`**（例外にしない）。 */
export function findNotificationEvent(
  code: string,
): NotificationEventDefinition | undefined {
  return BY_CODE.get(code as NotificationEventCode);
}

/**
 * `CLEANER` に届いてよい唯一のイベント（§5.1 MUST / security.md §1）。
 *
 * **表とは別に定数で持つ。** `audience` を編集するだけで清掃スタッフへ
 * 通知が流れ始める形にしない。`canReceive()` がこの定数と表の両方を見る。
 */
export const CLEANER_ALLOWED_EVENT: NotificationEventCode = "task.rework_assigned";

/**
 * その宛先がそのイベントを受け取ってよいか（§5.1）。
 *
 * ── `CLEANER` を二重に締める ────────────────────────────
 * 表の `audience` に載っていることに加えて、**`CLEANER` は
 * `task.rework_assigned` 以外を必ず落とす。** 表を書き換えただけでは
 * 清掃スタッフへ通知が流れないようにするための重ね掛けで、
 * 冗長に見えるがこれが security.md §1 の境界そのもの。
 *
 * ── `INSPECTOR` にはどのイベントも向かない ──────────────
 * §5.1 の「対象ロール」に `INSPECTOR` が 1 度も現れない。
 * 表に無い以上、送らない（推測で足さない）。
 */
export function canReceive(audience: NotificationAudience, code: string): boolean {
  const event = findNotificationEvent(code);
  if (event === undefined) return false;
  if (audience === "CLEANER" && event.code !== CLEANER_ALLOWED_EVENT) return false;
  return event.audience.includes(audience);
}

/** そのイベントを受け取りうる宛先。**表のまま。** */
export function audienceOf(code: string): readonly NotificationAudience[] {
  return findNotificationEvent(code)?.audience ?? [];
}
