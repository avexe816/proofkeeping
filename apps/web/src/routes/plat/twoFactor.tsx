import {
  Form,
  redirect,
  useActionData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { clientIp, consumeRateLimit } from "../../lib/auth/rateLimit.js";
import { t } from "../../lib/i18n.js";
import { requirePlatformSecondFactorStage } from "../../lib/platform/requireOperator.js";
import {
  buildPlatformSessionCookie,
  destroyPlatformSession,
} from "../../lib/platform/session.js";
import { verifySecondFactor } from "../../lib/platform/twoFactor.js";
import { getEnv } from "../../lib/ui/cloudflare.js";

/**
 * 第 2 要素の入力（PF-17）。
 *
 *   /plat/2fa
 *
 * task: docs/tasks/PF-17.md
 * 決定: docs/DECISIONS.md #241
 *
 * ── 入れるのはパスワード段階の札だけ ────────────────────
 * 札が無ければ **404**（運営面の門と同じ — 画面の存在を教えない）。
 * `COMPLETE` の札で来たらログイン後の画面へ送り返す。
 * TOTP 未登録の担当者は登録（`/plat/2fa/setup`）へ。**未登録のまま
 * ログイン後の画面へ到達する経路は無い**（完了条件）。
 *
 * ── レート制限はログインと同じバケツ ────────────────────
 * `consumeRateLimit(env, "login", ip)`。専用のバケツを増やさないのは
 * `/plat/login` と同じ判断。アカウント単位の締めはロック
 * （5 回で 15 分 / `lib/platform/twoFactor.ts`）が担う。
 *
 * ── 失敗の理由を分けない ────────────────────────────────
 * コードが違う・ロック中・使用済みの復旧コード — すべて同じ文言。
 */

type Failure = "REJECTED" | "RATE_LIMITED" | "INVALID";

interface ActionData {
  failure: Failure;
}

const FAILURE_MESSAGE: Record<Failure, Parameters<typeof t>[0]> = {
  REJECTED: "plat.twofa.rejected",
  RATE_LIMITED: "plat.login.rateLimited",
  INVALID: "plat.login.invalid",
};

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const stage = await requirePlatformSecondFactorStage(env, request, new Date());
  if (stage === null) throw redirect("/plat/status");
  if (stage.operator.twoFactorConfirmedAt === null) throw redirect("/plat/2fa/setup");
  return null;
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = getEnv(context);
  const now = new Date();
  const ip = clientIp(request);

  const rate = await consumeRateLimit(env, "login", ip, now);
  if (!rate.allowed) return { failure: "RATE_LIMITED" } satisfies ActionData;

  const stage = await requirePlatformSecondFactorStage(env, request, now);
  if (stage === null) throw redirect("/plat/status");
  if (stage.operator.twoFactorConfirmedAt === null) throw redirect("/plat/2fa/setup");

  const form = await request.formData();
  const code = form.get("code");
  if (typeof code !== "string" || code.trim() === "") {
    return { failure: "INVALID" } satisfies ActionData;
  }

  const result = await verifySecondFactor(env, {
    operator: stage.operator,
    code: code.trim(),
    now,
    ip,
  });
  if (!result.ok) return { failure: "REJECTED" } satisfies ActionData;

  // パスワード段階の札は使い終わり。**KV の実体ごと消す。**
  await destroyPlatformSession(env, stage.cookieValue);

  // 復旧コードで入ったときは残数の画面へ（再発行の判断をその場でできる）。
  return redirect(result.method === "RECOVERY" ? "/plat/2fa/recovery" : "/plat/status", {
    headers: {
      "Set-Cookie": buildPlatformSessionCookie(
        result.session.cookieValue,
        result.session.maxAgeSeconds,
      ),
    },
  });
}

export default function PlatformTwoFactor() {
  const actionData = useActionData<ActionData>();

  return (
    <main className="pk-login">
      <div className="pk-login__panel">
        <p className="pk-login__brand">
          {t("app.brand")} <span className="pk-plat-badge">{t("plat.badge")}</span>
        </p>
        <h1 className="pk-login__title">{t("plat.twofa.title")}</h1>
        <p className="pk-login__subtitle">{t("plat.twofa.subtitle")}</p>

        {actionData === undefined ? null : (
          <p className="pk-login__notice" role="alert">
            {t(FAILURE_MESSAGE[actionData.failure])}
          </p>
        )}

        <Form className="pk-login__form" method="post">
          <label className="pk-field" htmlFor="plat-totp-code">
            <span className="pk-field__label">{t("plat.twofa.code")}</span>
            <input
              autoComplete="one-time-code"
              className="pk-field__input"
              id="plat-totp-code"
              inputMode="numeric"
              name="code"
              required
              spellCheck={false}
              type="text"
            />
          </label>

          <button className="pk-button pk-button--primary" type="submit">
            {t("plat.twofa.submit")}
          </button>
        </Form>

        {/* 認証アプリが手元に無いときの経路。同じ action に投げ、
            サーバー側が形（6 桁か否か）で TOTP と復旧コードを見分ける。 */}
        <p className="pk-login__subtitle">{t("plat.twofa.recoveryHint")}</p>
      </div>
    </main>
  );
}
