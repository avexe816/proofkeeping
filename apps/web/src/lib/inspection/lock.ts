/**
 * `InspectionLock`（Durable Object）の呼び出し口。
 *
 * task:  docs/tasks/P2-04.md
 * ルール: .claude/rules/architecture.md §4
 *
 * **検査を開始する経路は必ずここを通す。** `env.INSPECTION_LOCK` を各所で
 * 直に叩くと、インスタンス名の組み立てが分かれて「同じタスクなのに別の錠」
 * が生まれる（`lib/document/sequencer.ts` と同じ理由）。
 *
 * ── 錠が取れないことと、行が作れないことは別 ─────────────
 * DO は**速い断り方**であって唯一の防波堤ではない。`inspection` の
 * 一意制約 `(organizationId, taskId, round)` を外さないこと
 * （`durable/InspectionLock.ts` の注記）。
 */

import type { Env } from "@pk/db";

import {
  INSPECTION_LOCK_ORIGIN,
  inspectionLockName,
  type AcquireResult,
  type InspectionHolder,
} from "../../durable/InspectionLock.js";

/** 保持を取る要求。**時刻はサーバー時刻を渡すこと**（端末の時計を使わない）。 */
export interface AcquireInspectionInput {
  organizationId: string;
  taskId: string;
  round: number;
  /** 検査担当者の `membership.id`。 */
  inspectorId: string;
  now: Date;
}

/** DO のスタブを引く。名前の組み立てを 1 か所に閉じる。 */
function stubFor(env: Env, organizationId: string, taskId: string): DurableObjectStub {
  const name = inspectionLockName(organizationId, taskId);
  return env.INSPECTION_LOCK.get(env.INSPECTION_LOCK.idFromName(name));
}

/**
 * 検査の保持を取る（§4.2 の「他の検査者による同時開始を排他制御する」）。
 *
 * 断られたら呼び出し側が `INSPECTION_ALREADY_STARTED` へ写す。
 * **同じ検査者の再要求は通る**（オフラインの再送・画面の再読み込み）。
 */
export async function acquireInspectionLock(
  env: Env,
  input: AcquireInspectionInput,
): Promise<AcquireResult> {
  const response = await stubFor(env, input.organizationId, input.taskId).fetch(
    `${INSPECTION_LOCK_ORIGIN}/acquire`,
    {
      method: "POST",
      body: JSON.stringify({
        round: input.round,
        inspectorId: input.inspectorId,
        nowMs: input.now.getTime(),
      }),
    },
  );

  // 200 と 409 のどちらも本文は `AcquireResult`。それ以外は障害。
  if (response.status !== 200 && response.status !== 409) {
    throw new Error("INSPECTION_LOCK_UNAVAILABLE");
  }
  return response.json<AcquireResult>();
}

/**
 * 保持を手放す。**検査の確定後に呼ぶ。**
 *
 * 失敗しても検査そのものは成立している（次のラウンドは `round` が
 * 進むので、残った保持に塞がれない / `InspectionLock.acquire()` の注記）。
 * **例外を投げない。** 完了処理を錠の後片付けで落とさない。
 */
export async function releaseInspectionLock(
  env: Env,
  organizationId: string,
  taskId: string,
  round: number,
): Promise<void> {
  try {
    await stubFor(env, organizationId, taskId).fetch(`${INSPECTION_LOCK_ORIGIN}/release`, {
      method: "POST",
      body: JSON.stringify({ round }),
    });
  } catch {
    // 握りつぶす。**ログにも組織 ID を出さない**（architecture.md §1）。
  }
}

/** いま保持している検査。**取らない。** 画面の表示に使う。 */
export async function peekInspectionLock(
  env: Env,
  organizationId: string,
  taskId: string,
): Promise<InspectionHolder | null> {
  const response = await stubFor(env, organizationId, taskId).fetch(
    `${INSPECTION_LOCK_ORIGIN}/peek`,
  );
  if (!response.ok) throw new Error("INSPECTION_LOCK_UNAVAILABLE");
  const body = await response.json<{ holder: InspectionHolder | null }>();
  return body.holder;
}
