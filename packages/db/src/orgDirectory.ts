/**
 * `orgShortId` の全局レジストリ。
 *
 * task: docs/tasks/P0-06.md
 * 決定: docs/DECISIONS.md #014（OPEN_QUESTIONS #009 への回答）
 *
 * ── 何を解いているか ────────────────────────────────────
 * `orgShortId` が 2 組織で重複すると、両者の ID が
 * `assertIdBelongsToTenant()` を相互に通過し、テナント分離の第 2 層が破れる。
 * 組織は 16 シャードへ分散するため単一シャードの UNIQUE では足りない。
 * そこで採番済みの 6 桁だけを SHARD_00 の `org_directory` に集約し、
 * 主キー制約で全局一意を担保する。
 *
 * ── 使い方（組織作成の手順）────────────────────────────
 *   1. `generateOrgShortId(createOrgShortIdTaken(env))` で候補を採番する
 *   2. `reserveOrgShortId()` で SHARD_00 へ予約を INSERT する
 *   3. 予約が成功してから、組織本体を自分のシャードへ INSERT する
 *
 * **順序を入れ替えないこと。** シャードをまたぐトランザクションは張れない
 * （architecture.md §1）ため、2 と 3 は別々の書き込みになる。
 * 3 が失敗すると予約行だけが残るが、これは「使われていない 6 桁が 1 つ減る」
 * だけで破損にはならない。逆順にすると、予約前に組織が生まれた瞬間に
 * 別の組織が同じ 6 桁を採番でき、分離が破れる方向に倒れる。
 *
 * ── 競合 ────────────────────────────────────────────────
 * `isTaken` の読み取りと予約の INSERT の間には隙間がある。同じ 6 桁を
 * 同時に採番した 2 つのリクエストのうち、**後から INSERT した側は主キー違反で
 * 落ちる。** 呼び出し側は失敗を握りつぶさず、採番からやり直すこと。
 */

import { eq } from "drizzle-orm";

import type { Env } from "./env.js";
import type { OrgShortIdTaken } from "./id.js";
import { getGlobalDb } from "./router.js";
import { orgDirectory } from "./schema/global.js";

/**
 * `generateOrgShortId()` に渡す衝突チェックを作る。
 *
 * SHARD_00 の `org_directory` に同じ 6 桁が既にあれば `true`。
 */
export function createOrgShortIdTaken(env: Env): OrgShortIdTaken {
  return async (candidate: string): Promise<boolean> => {
    const rows = await getGlobalDb(env)
      .select({ orgShortId: orgDirectory.orgShortId })
      .from(orgDirectory)
      .where(eq(orgDirectory.orgShortId, candidate))
      .limit(1);
    return rows.length > 0;
  };
}

/** 予約に必要な値。`now` は注入する（`Date.now()` を直接呼ばない）。 */
export interface ReserveOrgShortIdInput {
  orgShortId: string;
  organizationId: string;
  now: Date;
}

/**
 * 採番した 6 桁を予約する。**組織本体を作る前に呼ぶこと。**
 *
 * 既に同じ 6 桁が予約されていれば主キー違反で例外になる。
 * 握りつぶすと 2 組織が同じ `orgShortId` を持つため、**捕捉して無視しない。**
 */
export async function reserveOrgShortId(
  env: Env,
  input: ReserveOrgShortIdInput,
): Promise<void> {
  await getGlobalDb(env).insert(orgDirectory).values({
    orgShortId: input.orgShortId,
    organizationId: input.organizationId,
    createdAt: input.now,
  });
}

/**
 * 予約済みの 6 桁から組織 ID を引く。
 *
 * 用途は運用調査と、組織の存在確認のみ。**ここから業務データへ辿らないこと。**
 * 業務データの取得は必ず `getTenantDb()` を通す（architecture.md §2 第 1 層）。
 */
export async function lookupOrganizationId(
  env: Env,
  orgShortId: string,
): Promise<string | null> {
  const rows = await getGlobalDb(env)
    .select({ organizationId: orgDirectory.organizationId })
    .from(orgDirectory)
    .where(eq(orgDirectory.orgShortId, orgShortId))
    .limit(1);
  return rows[0]?.organizationId ?? null;
}
