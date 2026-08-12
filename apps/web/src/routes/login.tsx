import { loginRequestSchema } from "@pk/contracts";
import {
  Form,
  redirect,
  useActionData,
  useSearchParams,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { buildSessionCookie } from "../lib/auth/cookie.js";
import { login } from "../lib/auth/login.js";
import { clientIp, consumeRateLimit } from "../lib/auth/rateLimit.js";
import { t } from "../lib/i18n.js";
import { getEnv } from "../lib/ui/cloudflare.js";
import { readOptionalSession, safeNextPath } from "../lib/ui/requireSession.js";

/**
 * ログイン画面（最小）。
 *
 * task:  docs/tasks/P0-14.md
 * ルール: .claude/rules/security.md §2, §8
 *
 * ── 識別子は 3 フィールド固定 ───────────────────────────
 * `orgShortId` + スタッフ番号 + パスワード。**メールアドレスは使わない**
 * （security.md §2 / DECISIONS #018）。プロトタイプ
 * （ui-prototypes/owner/pkown-v3-A-login-daily.html）はメール欄・SSO・
 * 二要素認証を描いているが、**実装のある認証は P0-08 のこれだけ**なので
 * 見た目だけ先に作らない。
 *
 * ── 失敗の理由を分けない ────────────────────────────────
 * 識別子が無い・認証情報が違う・ロック中・無効化済みを区別できる応答を
 * 返さない（security.md §2）。画面の文言も 1 種類だけ。
 *
 * ── レート制限は API と同じバケツ ───────────────────────
 * `/api/v1/auth/login`（P0-08）と同じ `consumeRateLimit(env, "login", ip)` を
 * 通す。画面経由なら 10 req/分/IP を回避できる、という抜け道を作らない。
 *
 * ── 言語切替をここに置いていない ────────────────────────
 * PK-SPEC-UI-A01 §3.4 は「ログイン前は横並びで置く」と定めるが、
 * **切り替える先の言語が無い**（P0-15 が `en` を作る）。器だけ先に置かない。
 */

/** 画面に出す結果。**理由を分けない**ので種類は 3 つだけ。 */
type LoginFailure = "REJECTED" | "RATE_LIMITED" | "INVALID";

interface ActionData {
  failure: LoginFailure;
}

const FAILURE_MESSAGE: Record<LoginFailure, Parameters<typeof t>[0]> = {
  REJECTED: "login.rejected",
  RATE_LIMITED: "login.rateLimited",
  INVALID: "login.invalid",
};

export async function loader({ request, context }: LoaderFunctionArgs) {
  // すでに入っているなら入り口に留めない。
  const session = await readOptionalSession(getEnv(context), request, new Date());
  if (session !== null) {
    const next = safeNextPath(new URL(request.url).searchParams.get("next"));
    return redirect(next);
  }
  return null;
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = getEnv(context);
  const now = new Date();

  const rate = await consumeRateLimit(env, "login", clientIp(request), now);
  if (!rate.allowed) return { failure: "RATE_LIMITED" } satisfies ActionData;

  const form = await request.formData();
  const parsed = loginRequestSchema.safeParse({
    orgShortId: form.get("orgShortId"),
    staffNumber: form.get("staffNumber"),
    password: form.get("password"),
  });
  if (!parsed.success) return { failure: "INVALID" } satisfies ActionData;

  const result = await login(env, { credentials: parsed.data, now, ip: clientIp(request) });
  if (!result.ok) return { failure: "REJECTED" } satisfies ActionData;

  const next = safeNextPath(form.get("next") as string | null);
  return redirect(next, {
    headers: {
      "Set-Cookie": buildSessionCookie(result.session.cookieValue, result.session.maxAgeSeconds),
    },
  });
}

export default function LoginRoute() {
  const actionData = useActionData<ActionData>();
  const [searchParams] = useSearchParams();
  const next = safeNextPath(searchParams.get("next"));

  return (
    <main className="pk-login">
      <div className="pk-login__panel">
        <p className="pk-login__brand">{t("app.brand")}</p>
        <h1 className="pk-login__title">{t("login.title")}</h1>
        <p className="pk-login__subtitle">{t("login.subtitle")}</p>

        {actionData === undefined ? null : (
          <p className="pk-login__notice" role="alert">
            {t(FAILURE_MESSAGE[actionData.failure])}
          </p>
        )}

        <Form method="post" className="pk-login__form">
          <input type="hidden" name="next" value={next} />

          <label className="pk-field" htmlFor="orgShortId">
            <span className="pk-field__label">{t("login.orgShortId")}</span>
            <input
              className="pk-field__input"
              id="orgShortId"
              name="orgShortId"
              autoComplete="organization"
              inputMode="text"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
            <span className="pk-field__hint">{t("login.orgShortId.hint")}</span>
          </label>

          <label className="pk-field" htmlFor="staffNumber">
            <span className="pk-field__label">{t("login.staffNumber")}</span>
            <input
              className="pk-field__input"
              id="staffNumber"
              name="staffNumber"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          </label>

          <label className="pk-field" htmlFor="password">
            <span className="pk-field__label">{t("login.password")}</span>
            <input
              className="pk-field__input"
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </label>

          <button className="pk-button pk-button--primary" type="submit">
            {t("login.submit")}
          </button>
        </Form>

        <p className="pk-login__foot">{t("login.forCleaner")}</p>
      </div>
    </main>
  );
}
