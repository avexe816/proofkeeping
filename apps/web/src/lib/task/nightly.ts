/**
 * 日次のタスク自動生成バッチ（PK-SPEC-P1 §3.2）。**Cron Trigger の入口。**
 *
 * task: docs/tasks/P1-03.md
 *
 * ```
 * 02:00 Asia/Tokyo  全アクティブ施設について翌業務日のタスクを生成
 * ```
 *
 * ── セッションを持たない経路 ────────────────────────────
 * `TenantContext` は本来セッションから組み立てる（PK-SPEC-P0 §19.4）。
 * Cron にはセッションが無いので、**組織の一覧を `org_directory` から取り、
 * 組織ごとに文脈を組み立てる。** 越えていない線については
 * `packages/db/src/orgDirectory.ts` の `listOrganizationDirectory()` を読むこと。
 *
 * ── role に `ORG_ADMIN` を使っている ────────────────────
 * バッチは人ではないが、`TenantContext.role` は必須で、
 * `scopeToProperties()` が組織全体か施設スコープかを決めるのに使う。
 * バッチは組織全体を対象にするため、組織全体ロールのいずれかが要る。
 * **`ROLES` に `SYSTEM` を足していない。** 7 ロールは security.md §1 が
 * 定めた語彙で、増やすと権限マトリクスの全セル（7 列）が動く。
 * バッチは `assertPermission()` を一度も呼ばないので、ロールが認可に
 * 効くことはない。この選択の是非は docs/OPEN_QUESTIONS.md #033。
 *
 * ── 失敗しても次の組織へ進む ────────────────────────────
 * 1 組織の生成が落ちたときに残り全部を止めない。**どの組織で落ちたかを
 * 数えて返す。** 黙って握りつぶすと、翌朝タスクが無い施設が出ても
 * 気づけない。
 */

import {
  listOrganizationDirectory,
  listProperties,
  type Env,
  type TenantContext,
} from "@pk/db";

import { businessDateOf } from "../businessDate.js";

import { generateTasksForProperty } from "./generate.js";

/**
 * 1 回のバッチで扱う組織数の上限。
 *
 * Cron の CPU 予算に対する歯止め。**超えたことを結果で示す**ので、
 * 上限に達したら Queue へ移す（P4-14 が `reconciliation` で採る形）判断ができる。
 */
export const NIGHTLY_ORGANIZATION_LIMIT = 200;

/** バッチの結果。**件数だけ。組織 ID を返さない**（ログに載せないため）。 */
export interface NightlyResult {
  businessDate: string;
  organizations: number;
  properties: number;
  created: number;
  /** 生成に失敗した施設の数。0 でなければ調査が要る。 */
  failedProperties: number;
  /** 組織数が上限に達したか。真なら取りこぼしている可能性がある。 */
  truncated: boolean;
}

/**
 * 翌業務日のタスクを全組織・全アクティブ施設ぶん生成する。
 *
 * @param now Cron の発火時刻。**`Date.now()` をこの関数の中で呼ばない**
 *   （テストから時刻を固定できるようにする / CLAUDE.md §5）。
 */
export async function runNightlyGeneration(env: Env, now: Date): Promise<NightlyResult> {
  const organizations = await listOrganizationDirectory(env, NIGHTLY_ORGANIZATION_LIMIT);

  // 02:00 に走らせるので、既定の日締め（05:00）ではまだ前日の業務日にいる。
  // **生成するのは「これから始まる業務日」**なので、発火時刻の業務日を使う。
  // 施設ごとの日締め時刻は施設の設定で決まるため、施設ごとに求め直す。
  const result: NightlyResult = {
    businessDate: businessDateOf(now),
    organizations: organizations.length,
    properties: 0,
    created: 0,
    failedProperties: 0,
    truncated: organizations.length >= NIGHTLY_ORGANIZATION_LIMIT,
  };

  for (const organization of organizations) {
    const ctx: TenantContext = {
      organizationId: organization.organizationId,
      orgShortId: organization.orgShortId,
      role: "ORG_ADMIN",
      allowedPropertyIds: [],
      now,
    };

    let properties: Awaited<ReturnType<typeof listProperties>>;
    try {
      properties = await listProperties(env, ctx, { isActive: true });
    } catch {
      // 組織ごと落ちた（シャード未適用など）。次の組織へ進む。
      result.failedProperties += 1;
      continue;
    }

    for (const property of properties) {
      result.properties += 1;
      const businessDate = businessDateOf(now, property.timezone, property.dayCutoffTime);
      try {
        const generated = await generateTasksForProperty(env, ctx, property.id, businessDate);
        result.created += generated.created;
      } catch {
        result.failedProperties += 1;
      }
    }
  }

  return result;
}
