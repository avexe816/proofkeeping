import {
  Form,
  redirect,
  useActionData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { clientIp, consumeRateLimit } from "../../lib/auth/rateLimit.js";
import { t } from "../../lib/i18n.js";
import { platformLogin } from "../../lib/platform/login.js";
import {
  buildPlatformSessionCookie,
  readPlatformSession,
  readPlatformSessionCookie,
} from "../../lib/platform/session.js";
import { getEnv } from "../../lib/ui/cloudflare.js";

/**
 * プラットフォーム運営のログイン（PF-01）。
 *
 *   /plat/login
 *
 * task: docs/tasks/PF-01.md
 *
 * ── ここだけ門を通さない ────────────────────────────────
 * `/plat/*` の他は `requirePlatformOperator()` が 404 を返す。
 * **入口は 1 本だけ**にして、運営面へ入る道を数えられる状態にする。
 *
 * ── メール＋パスワード（PK-IMPL-CONTRACT §3.5）────────────
 * テナントの 3 フィールド（orgShortId＋スタッフ番号）を使わない —
 * 運営担当者はどの組織にも属さず、組織を解決できない。
 * パスワードが通っても発行されるのは `PASSWORD_ONLY` の札で、
 * **第 2 要素（TOTP / PF-17・DECISIONS #241）を通って初めて入れる。**
 *
 * ── レート制限はテナントのログインと同じバケツ ───────────
 * `consumeRateLimit(env, "login", ip)`（10 req/分/IP / security.md §8）。
 * 運営のログインは頻度が低く、専用のバケツを増やす理由が無い。
 * **`platformLogin()` の外で掛ける**のは `routes/login.tsx` と同じ形
 * （API とブラウザで別の抜け道を作らない）。
 *
 * ── 失敗の理由を分けない ────────────────────────────────
 * security.md §2。存在しない・違う・ロック中・無効化済みを区別しない。
 */

/** 画面に出す結果。**理由を分けない**ので種類は 3 つだけ。 */
type LoginFailure = "REJECTED" | "RATE_LIMITED" | "INVALID";

interface ActionData {
  failure: LoginFailure;
}

const FAILURE_MESSAGE: Record<LoginFailure, Parameters<typeof t>[0]> = {
  REJECTED: "plat.login.rejected",
  RATE_LIMITED: "plat.login.rateLimited",
  INVALID: "plat.login.invalid",
};

export async function loader({ request, context }: LoaderFunctionArgs) {
  // すでに入っているなら入り口に留めない。第 2 要素の途中なら 2FA へ（PF-17）。
  const env = getEnv(context);
  const cookieValue = readPlatformSessionCookie(request.headers.get("Cookie"));
  const session = await readPlatformSession(env, cookieValue, new Date());
  if (session !== null) {
    throw redirect(session.state === "COMPLETE" ? "/plat/status" : "/plat/2fa");
  }
  return null;
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = getEnv(context);
  const now = new Date();
  const ip = clientIp(request);

  const rate = await consumeRateLimit(env, "login", ip, now);
  if (!rate.allowed) return { failure: "RATE_LIMITED" } satisfies ActionData;

  const form = await request.formData();
  const email = form.get("email");
  const password = form.get("password");
  if (typeof email !== "string" || typeof password !== "string") {
    return { failure: "INVALID" } satisfies ActionData;
  }
  const trimmedEmail = email.trim();
  if (trimmedEmail === "" || password === "") {
    return { failure: "INVALID" } satisfies ActionData;
  }

  const result = await platformLogin(env, { email: trimmedEmail, password, now, ip });
  if (!result.ok) return { failure: "REJECTED" } satisfies ActionData;

  // パスワードだけではまだ入れない（PF-17）。第 2 要素へ。
  // 未登録なら登録から（TOTP は必須 — 任意にしない / DECISIONS #241）。
  return redirect(result.requiresEnrollment ? "/plat/2fa/setup" : "/plat/2fa", {
    headers: {
      "Set-Cookie": buildPlatformSessionCookie(
        result.session.cookieValue,
        result.session.maxAgeSeconds,
      ),
    },
  });
}

export default function PlatformLogin() {
  const actionData = useActionData<ActionData>();

  return (
    <main className="pk-login">
      <div className="pk-login__panel">
        <p className="pk-login__brand">
          {t("app.brand")} <span className="pk-plat-badge">{t("plat.badge")}</span>
        </p>
        <h1 className="pk-login__title">{t("plat.login.title")}</h1>
        <p className="pk-login__subtitle">{t("plat.login.subtitle")}</p>

        {actionData === undefined ? null : (
          <p className="pk-login__notice" role="alert">
            {t(FAILURE_MESSAGE[actionData.failure])}
          </p>
        )}

        <Form className="pk-login__form" method="post">
          <label className="pk-field" htmlFor="plat-email">
            <span className="pk-field__label">{t("plat.login.email")}</span>
            <input
              autoCapitalize="none"
              autoComplete="username"
              className="pk-field__input"
              id="plat-email"
              name="email"
              required
              spellCheck={false}
              type="email"
            />
          </label>

          <label className="pk-field" htmlFor="plat-password">
            <span className="pk-field__label">{t("plat.login.password")}</span>
            <input
              autoComplete="current-password"
              className="pk-field__input"
              id="plat-password"
              name="password"
              required
              type="password"
            />
          </label>

          <button className="pk-button pk-button--primary" type="submit">
            {t("plat.login.submit")}
          </button>
        </Form>
      </div>
    </main>
  );
}
