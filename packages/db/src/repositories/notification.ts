/**
 * 通知（`notificationPreference` / `pushSubscription`）のリポジトリ。
 *
 * task: docs/tasks/P6-09.md
 * 仕様: docs/PK-SPEC-P6.md §2.4 / §2.5 / §5
 * ルール: .claude/rules/ui-writing.md §6 / .claude/rules/security.md §5
 *
 * ── 行が無いことが「既定のまま」を表す ──────────────────
 * `notificationPreference` は全員ぶんを事前に作らない（`schema/integration.ts`
 * の注記）。**引けなかった `membershipId` は既定チャネルで扱う**のが
 * 呼び出し側の責務で、この層は `null` を返すだけ。
 *
 * ── 誰に何を送ったかを個人の評価に使わない ──────────────
 * security.md §5。ここが返すのは配信に要る宛先だけで、
 * **「誰が通知を開いたか」を集計する関数を置かない。**
 */

import { eq, inArray, lt } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant, generateId } from "../id.js";
import { getTenantDb, type TenantContext } from "../router.js";
import {
  notificationPreference,
  pushSubscription,
  type NotificationChannel,
  type NotificationEventCode,
} from "../schema/integration.js";
import { membership, propertyAssignment, user, type Role } from "../schema/user.js";

import { NO_PROPERTY_SCOPE, withTenantScope } from "./base.js";

/** 通知の宛先 1 件。 */
export interface NotificationRecipient {
  membershipId: string;
  role: Role;
  /** **通知の送信先としてだけ持つ**（security.md §2）。未設定なら `null`。 */
  email: string | null;
  /** 表示言語。本文の言語に使う。 */
  locale: string;
}

/** `listNotificationRecipients()` の絞り込み。 */
export interface NotificationRecipientFilter {
  /** 対象ロール（PK-SPEC-P6 §5.1 の「対象ロール」）。**空なら 1 件も返さない。** */
  roles: readonly Role[];
  /**
   * 施設で絞るか。`null` なら組織全体。
   *
   * **施設スコープのイベント**（`room.urgent` など）は、その施設に
   * 割り当てられている人だけへ送る。組織全体のイベント
   * （`integration.error` など）は `null` を渡す。
   */
  propertyId: string | null;
}

/**
 * 通知の宛先を引く（§5.1）。
 *
 * **無効化されたユーザー・membership・施設割当を除く。** 退職者へ
 * 通知が飛び続ける状態を作らない。
 *
 * `email` が `null` の宛先も返す。**落とすのは配信側の責務**で、
 * ここで落とすと「対象は 3 人だが 1 人はメール未登録」という状況が
 * 呼び出し側から見えなくなる。
 */
export async function listNotificationRecipients(
  env: Env,
  ctx: TenantContext,
  filter: NotificationRecipientFilter,
): Promise<NotificationRecipient[]> {
  if (filter.roles.length === 0) return [];
  if (filter.propertyId !== null) assertIdBelongsToTenant(filter.propertyId, ctx);

  const db = await getTenantDb(env, ctx);
  const columns = {
    membershipId: membership.id,
    role: membership.role,
    email: user.email,
    locale: user.locale,
  };

  if (filter.propertyId === null) {
    const rows = await db
      .select(columns)
      .from(membership)
      .innerJoin(user, eq(user.id, membership.userId))
      .where(
        withTenantScope(
          membership,
          ctx,
          NO_PROPERTY_SCOPE,
          inArray(membership.role, [...filter.roles]),
          eq(membership.isActive, true),
          eq(user.isActive, true),
        ),
      )
      .orderBy(membership.id);
    return rows;
  }

  // 施設スコープ。**`property_assignment` を起点に引く**（`listPropertyStaff()`
  // と同じ形）。1 人が複数の割当を持つことは無い（`uq` が効く）。
  const rows = await db
    .select(columns)
    .from(propertyAssignment)
    .innerJoin(membership, eq(membership.id, propertyAssignment.membershipId))
    .innerJoin(user, eq(user.id, membership.userId))
    .where(
      withTenantScope(
        propertyAssignment,
        ctx,
        propertyAssignment.propertyId,
        eq(propertyAssignment.propertyId, filter.propertyId),
        eq(propertyAssignment.isActive, true),
        inArray(membership.role, [...filter.roles]),
        eq(membership.isActive, true),
        eq(user.isActive, true),
      ),
    )
    .orderBy(membership.id);
  return rows;
}

/** 利用者ごとの通知設定 1 件（§2.5）。 */
export interface NotificationPreferenceRow {
  membershipId: string;
  channels: NotificationChannel[];
  quietHoursFrom: string | null;
  quietHoursTo: string | null;
}

/**
 * 1 イベントぶんの通知設定を引く（§2.5）。
 *
 * **引けなかった `membershipId` は結果に現れない。** 行が無いことが
 * 「既定のまま」を表す（冒頭の注記）。呼び出し側は
 * `map.get(membershipId) ?? null` で受ける。
 */
export async function listNotificationPreferences(
  env: Env,
  ctx: TenantContext,
  params: { membershipIds: readonly string[]; eventCode: NotificationEventCode },
): Promise<Map<string, NotificationPreferenceRow>> {
  const unique = [...new Set(params.membershipIds)];
  if (unique.length === 0) return new Map();

  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select({
      membershipId: notificationPreference.membershipId,
      channels: notificationPreference.channels,
      quietHoursFrom: notificationPreference.quietHoursFrom,
      quietHoursTo: notificationPreference.quietHoursTo,
    })
    .from(notificationPreference)
    .where(
      withTenantScope(
        notificationPreference,
        ctx,
        NO_PROPERTY_SCOPE,
        eq(notificationPreference.eventCode, params.eventCode),
        inArray(notificationPreference.membershipId, unique),
      ),
    );
  return new Map(rows.map((row) => [row.membershipId, row]));
}

/** `upsertNotificationPreference()` の入力。 */
export interface UpsertNotificationPreferenceInput {
  membershipId: string;
  eventCode: NotificationEventCode;
  channels: readonly NotificationChannel[];
  /** `"22:00"`。`null` は既定（22:00-07:00 / §5.3）。 */
  quietHoursFrom?: string | null | undefined;
  quietHoursTo?: string | null | undefined;
}

/**
 * 通知設定を保存する（§2.5）。
 *
 * 冪等。**同じ入力を 3 回書いても行は 1 つ**（`uq_notif_pref`）。
 *
 * **消す口を置かない。** 既定へ戻すのは既定チャネルを書くこと。
 * 行を消すと「既定に戻した」と「一度も触っていない」が区別できなくなる
 * （`ruleConfig` と同じ判断 / DECISIONS #118）。
 */
export async function upsertNotificationPreference(
  env: Env,
  ctx: TenantContext,
  input: UpsertNotificationPreferenceInput,
): Promise<void> {
  assertIdBelongsToTenant(input.membershipId, ctx);
  const db = await getTenantDb(env, ctx);
  const values = {
    channels: [...input.channels],
    quietHoursFrom: input.quietHoursFrom ?? null,
    quietHoursTo: input.quietHoursTo ?? null,
    updatedAt: ctx.now,
  };

  const updated = await db
    .update(notificationPreference)
    .set(values)
    .where(
      withTenantScope(
        notificationPreference,
        ctx,
        NO_PROPERTY_SCOPE,
        eq(notificationPreference.membershipId, input.membershipId),
        eq(notificationPreference.eventCode, input.eventCode),
      ),
    );
  if (updated.meta.changes > 0) return;

  await db
    .insert(notificationPreference)
    .values({
      id: generateId(ctx.orgShortId, "npref"),
      organizationId: ctx.organizationId,
      membershipId: input.membershipId,
      eventCode: input.eventCode,
      ...values,
    })
    // **競合したら上書きする。** 先に UPDATE を試し、0 行のときだけここへ
    // 来る。その隙間で別のリクエストが INSERT していても、`uq_notif_pref`
    // が効いて行は 1 つのまま（採番した ULID は捨てられる）。
    .onConflictDoUpdate({
      target: [
        notificationPreference.organizationId,
        notificationPreference.membershipId,
        notificationPreference.eventCode,
      ],
      set: values,
    });
}

/** 購読を無効化する連続失敗回数（§5.2 MUST）。 */
export const PUSH_FAILURE_LIMIT = 3;

/**
 * 送信できる `PUSH` の購読があるか（§5.2）。
 *
 * **`isStandalone` が真の購読だけを数える。** iOS はホーム画面に追加された
 * PWA でしか受信できず、それ以外の購読へ送っても届かない。
 * 3 回連続で失敗した購読も除く（§5.2 MUST の「無効化する」）。
 *
 * **P6-10 まで購読を作る経路が無いので、いまは必ず 0 件。**
 */
export async function listDeliverablePushMembershipIds(
  env: Env,
  ctx: TenantContext,
  membershipIds: readonly string[],
): Promise<Set<string>> {
  const unique = [...new Set(membershipIds)];
  if (unique.length === 0) return new Set();

  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select({ membershipId: pushSubscription.membershipId })
    .from(pushSubscription)
    .where(
      withTenantScope(
        pushSubscription,
        ctx,
        NO_PROPERTY_SCOPE,
        inArray(pushSubscription.membershipId, unique),
        eq(pushSubscription.isStandalone, true),
        lt(pushSubscription.failureCount, PUSH_FAILURE_LIMIT),
      ),
    );
  return new Set(rows.map((row) => row.membershipId));
}
