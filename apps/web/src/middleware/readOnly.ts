/**
 * トライアル終了後の**読み取り専用モード**（PK-SPEC-P7 §2.5）。
 *
 * task:  docs/tasks/P7-03.md
 * 決定:  docs/DECISIONS.md #182 / #183
 *
 * ── 1 か所に置く ────────────────────────────────────────
 * 書き込み経路ごとに `if` を撒くと**必ず漏れる。**
 * `assertPermission()`（404）と `assertEntitlement()`（402）は
 * 「その資源に触れてよいか」を資源ごとに見るが、こちらは
 * **組織全体の状態**なので、経路の手前で 1 回見れば足りる。
 *
 * ── 優先度 1 の書き込みだけ通す（DECISIONS #183）────────
 * §2.5 は「読み取り専用モードへ移行」と書く。だが 402 は 4xx で、
 * オフラインキューは 4xx を `GIVE_UP` にする（`lib/offline/policy.ts`）。
 * **夜中に期限が切れると、その勤務で記録した完了が捨てられる。**
 *
 * PK-SPEC-P7 §5.2 は優先度 1（清掃タスクの参照・開始・完了）を
 * 「**何があっても維持する**」と定め、MUST で「D1 の書き込みが失敗しても
 * オフラインキューに保持し、復旧後に送信する」と書く。
 * **記録済みの作業を落とさない方を採った。**
 *
 * 通すのは `start` / `pause` / `resume` / `complete` の 4 つだけ。
 * **タスクの自動生成も、新しい客室も、帳票の発行も止まる。**
 * 手元の作業が終われば、システムは静かになる。
 *
 * ── 契約を毎リクエスト引く ──────────────────────────────
 * 書き込み（GET 以外）のときだけ `findSubscription()` を 1 回引く。
 * 読み取りには掛からない。**キャッシュしていない。** 期限切れの反映が
 * 遅れる方が、キャッシュの取りこぼしで書けなくなるより軽い。
 * 重くなったら KV へ寄せること（`schemaVersion` の 503 と同じ設計課題）。
 */

import { PaymentRequiredError, findSubscription, type Env, type TenantContext } from "@pk/db";
import type { MiddlewareHandler } from "hono";

import { isPriorityOneWrite } from "../lib/degradation/priority.js";
import { isReadOnly, trialPhaseOf } from "../lib/plan/trial.js";

import { ContextMissingError, type AppEnv } from "./context.js";

/** 状態を変えない HTTP メソッド。**`HEAD` と `OPTIONS` を忘れない。** */
const SAFE_METHODS: readonly string[] = ["GET", "HEAD", "OPTIONS"];

/** 契約の読み取り。**テストで差し替える**（`useTenantMiddleware` の `deps`）。 */
export interface TrialReadOnlyDeps {
  findSubscription: (
    env: Env,
    ctx: TenantContext,
  ) => Promise<{ status?: string | null; trialEndsAt?: Date | null } | undefined>;
}

const DEFAULT_DEPS: TrialReadOnlyDeps = { findSubscription };

/**
 * トライアルが終わっていたら書き込みを 402 で止める。
 *
 * **`tenant` middleware の後に置くこと。** 組織が解決していないと
 * 契約を引けない（`ContextMissingError` を投げる）。
 */
export function withTrialReadOnly(
  deps: TrialReadOnlyDeps = DEFAULT_DEPS,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (SAFE_METHODS.includes(c.req.method)) return next();
    // 優先度 1（§5.2）。**ここを狭めないこと。**
    // **パスだけを渡す。** `isPriorityOneWrite()` は区切りの数を数えるので、
    // `http://host/...` をそのまま渡すと `http:` と host が段に入って外れる。
    if (isPriorityOneWrite(new URL(c.req.url).pathname)) return next();

    const tenant = c.get("tenant");
    if (tenant === undefined) throw new ContextMissingError("TENANT");

    const subscription = await deps.findSubscription(c.env, tenant);
    const phase = trialPhaseOf(
      {
        status: subscription?.status,
        trialEndsAt: subscription?.trialEndsAt ?? null,
      },
      tenant.now,
    );
    if (isReadOnly(phase)) throw new PaymentRequiredError("TRIAL_ENDED");

    return next();
  };
}
