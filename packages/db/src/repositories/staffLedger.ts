/**
 * スタッフ台帳のリポジトリ（P8-01 / PK-SPEC-P8 §1.3）。
 *
 * task: docs/tasks/P8-01.md
 * 決定: docs/DECISIONS.md **#223**
 * ルール: .claude/rules/security.md §3 / §5
 *
 * ── 表は `staff_pay_profile`、関心はここで分ける ──────────
 * 台帳は新しい表を作らず `staff_pay_profile` に列を足した（#223）。
 * ただし**読む相手が違う。** 支払（`payout.read` = OWNER / ORG_ADMIN）と
 * 台帳（`user.read` = ほぼ全ロール）は別の門なので、
 * **関数を同じファイルに混ぜない。** 混ぜると「支払の関数を触った
 * つもりが台帳の門を通っていた」が起きる。
 *
 * ── 単価を返さない ──────────────────────────────────────
 * `payRule` は引かない。**プロトタイプ ops 07 の一覧に単価の列が無い**
 * （DECISIONS #221）。ここに単価を混ぜると `PROPERTY_MANAGER` の
 * 画面へそのまま流れる（PK-SPEC-P8 §1.3 MUST が禁じている）。
 *
 * ── 施設スコープを掛けない ──────────────────────────────
 * スタッフは組織に属し、施設には `propertyAssignment` で紐づく。
 * `NO_PROPERTY_SCOPE`。担当施設での絞りは呼び出し側が行う。
 */

import { eq, inArray } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant } from "../id.js";
import { getTenantDb, type TenantContext } from "../router.js";
import { staffPayProfile, type WorkStatus } from "../schema/payout.js";

import { NO_PROPERTY_SCOPE, withTenantScope } from "./base.js";

/**
 * スタッフ台帳の 1 行（P8-01）。**単価も雇用区分も含めない。**
 *
 * 単価は `payRule`（`payout.read` = OWNER / ORG_ADMIN のみ）が持ち、
 * **プロトタイプ ops 07 の一覧に単価の列が無い**（DECISIONS #221）。
 * 名前とスタッフ番号は `user` の側にあるので、ここで返すのは台帳の列だけ。
 */
export interface StaffLedgerRow {
  id: string;
  membershipId: string;
  hiredOn: string | null;
  resignedOn: string | null;
  workStatus: WorkStatus;
  languages: string[];
  skills: string[];
  note: string | null;
}

/** `listStaffLedger()` の絞り込み。プロトタイプ 07 の「全員 / 稼働中 / 研修中」。 */
export interface StaffLedgerFilter {
  workStatus?: readonly WorkStatus[] | undefined;
}

/**
 * スタッフ台帳（P8-01 / プロトタイプ ops 07）。
 *
 * **`user` と JOIN しない。** 表示名は呼び出し側が `listUsers()` で引いて
 * `membershipId` で突き合わせる。JOIN を足すと、名前を出せない相手
 * （INV-06）にも同じクエリが使われたときに列ごと漏れる。
 */
export async function listStaffLedger(
  env: Env,
  ctx: TenantContext,
  filter: StaffLedgerFilter = {},
): Promise<StaffLedgerRow[]> {
  const db = await getTenantDb(env, ctx);
  return db
    .select({
      id: staffPayProfile.id,
      membershipId: staffPayProfile.membershipId,
      hiredOn: staffPayProfile.hiredOn,
      resignedOn: staffPayProfile.resignedOn,
      workStatus: staffPayProfile.workStatus,
      languages: staffPayProfile.languages,
      skills: staffPayProfile.skills,
      note: staffPayProfile.note,
    })
    .from(staffPayProfile)
    .where(
      withTenantScope(
        staffPayProfile,
        ctx,
        NO_PROPERTY_SCOPE,
        filter.workStatus === undefined
          ? undefined
          : inArray(staffPayProfile.workStatus, [...filter.workStatus]),
      ),
    )
    .orderBy(staffPayProfile.membershipId);
}

/** `updateStaffLedger()` の入力。**渡した列だけを書き換える。** */
export interface UpdateStaffLedgerInput {
  membershipId: string;
  hiredOn?: string | null;
  resignedOn?: string | null;
  workStatus?: WorkStatus;
  languages?: string[];
  skills?: string[];
  note?: string | null;
}

/**
 * 台帳の列を更新する（P8-01）。**行が無ければ何もしない。**
 *
 * 行を作るのは `upsertStaffPayProfile()`（雇用区分が要る）。ここで
 * 作れるようにすると、雇用区分の無いスタッフが生まれる。
 *
 * **`isActive` を触らない。** あれは「支払の対象か」で、`workStatus`
 * （いま働いているか）とは別（DECISIONS #223）。
 */
export async function updateStaffLedger(
  env: Env,
  ctx: TenantContext,
  input: UpdateStaffLedgerInput,
): Promise<{ updated: boolean }> {
  assertIdBelongsToTenant(input.membershipId, ctx);
  const db = await getTenantDb(env, ctx);

  const set: Record<string, unknown> = { updatedAt: ctx.now };
  if (input.hiredOn !== undefined) set["hiredOn"] = input.hiredOn;
  if (input.resignedOn !== undefined) set["resignedOn"] = input.resignedOn;
  if (input.workStatus !== undefined) set["workStatus"] = input.workStatus;
  if (input.languages !== undefined) set["languages"] = input.languages;
  if (input.skills !== undefined) set["skills"] = input.skills;
  if (input.note !== undefined) set["note"] = input.note;

  const result = await db
    .update(staffPayProfile)
    .set(set)
    .where(
      withTenantScope(
        staffPayProfile,
        ctx,
        NO_PROPERTY_SCOPE,
        eq(staffPayProfile.membershipId, input.membershipId),
      ),
    )
    .returning({ id: staffPayProfile.id });

  return { updated: result.length > 0 };
}
