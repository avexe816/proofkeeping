import {
  Form,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { findPlatformOperatorById } from "@pk/db";

import { clientIp, consumeRateLimit } from "../../lib/auth/rateLimit.js";
import { t } from "../../lib/i18n.js";
import { requirePlatformOperator } from "../../lib/platform/requireOperator.js";
import { countActiveRecoveryCodes, regenerateRecoveryCodes } from "../../lib/platform/twoFactor.js";
import { getEnv } from "../../lib/ui/cloudflare.js";

/**
 * 復旧コードの残数と再発行（PF-17）。
 *
 *   /plat/2fa/recovery
 *
 * task: docs/tasks/PF-17.md
 * 決定: docs/DECISIONS.md #241
 *
 * ── ログイン後の領域 ────────────────────────────────────
 * `requirePlatformOperator()`（`COMPLETE` の札）を通る。復旧コードで
 * 入ったログインの直後にここへ着地する（残数が減った直後が、刷り直しを
 * 判断する場所だから）。
 *
 * ── 再発行には現在の TOTP コードを要求する ──────────────
 * 札を盗んだだけの相手に、有効な復旧コード一式を刷り直させない。
 * 再発行すると**未使用の既存コードはすべて失効**し、新しい平文は
 * この応答で 1 回だけ表示する（DB はハッシュのみ / security.md §7）。
 */

type Failure = "REJECTED" | "RATE_LIMITED" | "INVALID";

type ActionData = { failure: Failure } | { recoveryCodes: string[] };

const FAILURE_MESSAGE: Record<Failure, Parameters<typeof t>[0]> = {
  REJECTED: "plat.twofa.rejected",
  RATE_LIMITED: "plat.login.rateLimited",
  INVALID: "plat.login.invalid",
};

interface RecoveryPageData {
  remaining: number;
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<RecoveryPageData> {
  const env = getEnv(context);
  const operator = await requirePlatformOperator(env, request, new Date());
  return { remaining: await countActiveRecoveryCodes(env, operator.operatorId) };
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = getEnv(context);
  const now = new Date();
  const ip = clientIp(request);

  const platformContext = await requirePlatformOperator(env, request, now);

  const rate = await consumeRateLimit(env, "login", ip, now);
  if (!rate.allowed) return { failure: "RATE_LIMITED" } satisfies ActionData;

  const form = await request.formData();
  const code = form.get("code");
  if (typeof code !== "string" || code.trim() === "") {
    return { failure: "INVALID" } satisfies ActionData;
  }

  // `requirePlatformOperator()` は表示用の最小限しか返さない。
  // 再発行の検証には行そのもの（秘密・ロック状態）が要るので引き直す。
  const operator = await findPlatformOperatorById(env, platformContext.operatorId);
  if (operator === null) return { failure: "REJECTED" } satisfies ActionData;

  const result = await regenerateRecoveryCodes(env, {
    operator,
    code: code.trim(),
    now,
    ip,
  });
  if (!result.ok) return { failure: "REJECTED" } satisfies ActionData;
  return { recoveryCodes: result.recoveryCodes } satisfies ActionData;
}

export default function PlatformRecoveryCodes() {
  const page = useLoaderData<RecoveryPageData>();
  const actionData = useActionData<ActionData>();
  const issued = actionData !== undefined && "recoveryCodes" in actionData;

  return (
    <div className="pk-page">
      <header className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("plat.twofa.recovery.title")}</h1>
      </header>

      <section className="pk-panel">
        <div className="pk-panel__body">
          <p>
            <span>{t("plat.twofa.recovery.remainingLabel")}</span>{" "}
            <strong>{issued ? actionData.recoveryCodes.length : page.remaining}</strong>
          </p>

          {actionData !== undefined && "failure" in actionData ? (
            <p className="pk-login__notice" role="alert">
              {t(FAILURE_MESSAGE[actionData.failure])}
            </p>
          ) : null}

          {issued ? (
            <>
              <p>{t("plat.twofa.recovery.done")}</p>
              <p>{t("plat.twofa.codes.notice")}</p>
              <ul className="pk-recovery-codes">
                {actionData.recoveryCodes.map((code) => (
                  <li className="pk-recovery-codes__item" key={code}>
                    {code}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <p>{t("plat.twofa.recovery.regenerateNote")}</p>
              <Form method="post">
                <label className="pk-field" htmlFor="plat-recovery-code">
                  <span className="pk-field__label">{t("plat.twofa.recovery.codeLabel")}</span>
                  <input
                    autoComplete="one-time-code"
                    className="pk-field__input"
                    id="plat-recovery-code"
                    inputMode="numeric"
                    name="code"
                    required
                    spellCheck={false}
                    type="text"
                  />
                </label>
                <button className="pk-button pk-button--primary" type="submit">
                  {t("plat.twofa.recovery.regenerate")}
                </button>
              </Form>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
