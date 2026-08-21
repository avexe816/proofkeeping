import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { PASSWORD_POLICY } from "@pk/contracts";

import { clientIp, consumeRateLimit } from "../../lib/auth/rateLimit.js";
import { t } from "../../lib/i18n.js";
import {
  activatePlatformBootstrap,
  findBootstrapInvitation,
} from "../../lib/platform/bootstrap.js";
import { buildPlatformSessionCookie } from "../../lib/platform/session.js";
import { getEnv } from "../../lib/ui/cloudflare.js";

/**
 * 初期開通（PF-16）。**開通リンクを開いてパスワードを決める画面。**
 *
 *   /plat/bootstrap/:token
 *
 * task: docs/tasks/PF-16.md
 * 決定: docs/DECISIONS.md #240・#245
 *
 * ── 門を通さない。代わりに券が門になる ──────────────────
 * `/plat/login` と同じくシェルの外に置く（この時点で運営担当者はまだ
 * 居ないので、`requirePlatformOperator()` は必ず 404 になる）。
 * 通してよいかを決めているのは**券が生きているか**だけ。
 *
 * ── GET では消費しない ──────────────────────────────────
 * メールのリンクはプレビュー・スキャナ・先読みで開かれる。GET で券を
 * 燃やすと、**本人が着く前に無効になる。** 消費は POST の中で 1 回だけ。
 *
 * ── 失敗の見た目を 1 つにする ───────────────────────────
 * 無い・使用済み・失効・期限切れは**すべて 404**（`/plat/*` の既定と同じ /
 * DECISIONS #230）。「期限が切れています」と出すと、**その token が
 * 実在したことを教える。**
 *
 * ── 次は 2 要素認証（PF-17）──────────────────────────────
 * ここで出るのは `PASSWORD_ONLY` の札（10 分）。`/plat/2fa/setup` で
 * 認証アプリを登録し復旧コードを控えるまで、`/plat/*` は 404 のまま。
 */

/** 画面に出す結果。**券の失敗は 404 なので、ここには出てこない。** */
type Failure = "POLICY_VIOLATION" | "MISMATCH" | "RATE_LIMITED" | "INVALID";

interface ActionData {
  failure: Failure;
}

const FAILURE_MESSAGE: Record<Failure, Parameters<typeof t>[0]> = {
  POLICY_VIOLATION: "plat.bootstrap.policyViolation",
  MISMATCH: "plat.bootstrap.mismatch",
  RATE_LIMITED: "plat.login.rateLimited",
  INVALID: "plat.login.invalid",
};

interface BootstrapPageData {
  email: string;
  displayName: string;
}

/**
 * 規約の説明文。**文字数を `ja.json` に書かない**（DECISIONS #242 の
 * 決定 B と同じ向き — 定数を変えた瞬間に説明と検査が食い違う形にしない）。
 */
export function passwordPolicyNote(): string {
  return t("plat.bootstrap.policy").replaceAll(
    "{min}",
    String(PASSWORD_POLICY.minLength),
  );
}

/** 404。**理由を持たせない**（`requireOperator.ts` と同じ）。 */
function notFound(): Response {
  return new Response(null, { status: 404 });
}

export async function loader({
  params,
  request,
  context,
}: LoaderFunctionArgs): Promise<BootstrapPageData> {
  const env = getEnv(context);
  const token = params.token;
  if (typeof token !== "string" || token === "") throw notFound();

  // **数える前に叩かれる余地を塞ぐ。** 券は 1 枚しか無いが、当てに来る
  // 相手には回数を掛けさせない（`/plat/login` と同じバケツ）。
  const rate = await consumeRateLimit(env, "login", clientIp(request), new Date());
  if (!rate.allowed) throw notFound();

  const invitation = await findBootstrapInvitation(env, { token, now: new Date() });
  if (invitation === null) throw notFound();
  return { email: invitation.email, displayName: invitation.displayName };
}

export async function action({ params, request, context }: ActionFunctionArgs) {
  const env = getEnv(context);
  const now = new Date();
  const ip = clientIp(request);
  const token = params.token;
  if (typeof token !== "string" || token === "") throw notFound();

  const rate = await consumeRateLimit(env, "login", ip, now);
  if (!rate.allowed) return { failure: "RATE_LIMITED" } satisfies ActionData;

  const form = await request.formData();
  const password = form.get("password");
  const confirmation = form.get("passwordConfirmation");
  if (typeof password !== "string" || typeof confirmation !== "string") {
    return { failure: "INVALID" } satisfies ActionData;
  }
  // **確認欄の不一致は券を消費する前に見る。** 打ち間違いで 1 回きりの
  // 券を失わせない（`activatePlatformBootstrap()` の規約検査と同じ向き）。
  if (password !== confirmation) return { failure: "MISMATCH" } satisfies ActionData;

  const result = await activatePlatformBootstrap(env, { token, password, now, ip });
  if (!result.ok) {
    // 規約違反だけは画面に返す（本人が直せる）。券の失敗は 404 に倒す。
    if (result.reason === "POLICY_VIOLATION") {
      return { failure: "POLICY_VIOLATION" } satisfies ActionData;
    }
    throw notFound();
  }

  // 次は 2 要素認証の登録（PF-17）。**飛ばす経路は無い。**
  return redirect("/plat/2fa/setup", {
    headers: {
      "Set-Cookie": buildPlatformSessionCookie(
        result.session.cookieValue,
        result.session.maxAgeSeconds,
      ),
    },
  });
}

export default function PlatformBootstrap() {
  const page = useLoaderData<BootstrapPageData>();
  const actionData = useActionData<ActionData>();

  return (
    <main className="pk-login">
      <div className="pk-login__panel">
        <p className="pk-login__brand">
          {t("app.brand")} <span className="pk-plat-badge">{t("plat.badge")}</span>
        </p>
        <h1 className="pk-login__title">{t("plat.bootstrap.title")}</h1>
        <p className="pk-login__subtitle">{t("plat.bootstrap.subtitle")}</p>

        <p className="pk-login__subtitle">
          {page.displayName}（{page.email}）
        </p>

        {actionData === undefined ? null : (
          <p className="pk-login__notice" role="alert">
            {t(FAILURE_MESSAGE[actionData.failure])}
          </p>
        )}

        <p className="pk-login__subtitle">{passwordPolicyNote()}</p>

        <Form className="pk-login__form" method="post">
          <label className="pk-field" htmlFor="plat-bootstrap-password">
            <span className="pk-field__label">{t("plat.bootstrap.password")}</span>
            <input
              autoComplete="new-password"
              className="pk-field__input"
              id="plat-bootstrap-password"
              minLength={PASSWORD_POLICY.minLength}
              name="password"
              required
              type="password"
            />
          </label>

          <label className="pk-field" htmlFor="plat-bootstrap-password-confirm">
            <span className="pk-field__label">{t("plat.bootstrap.passwordConfirm")}</span>
            <input
              autoComplete="new-password"
              className="pk-field__input"
              id="plat-bootstrap-password-confirm"
              minLength={PASSWORD_POLICY.minLength}
              name="passwordConfirmation"
              required
              type="password"
            />
          </label>

          <button className="pk-button pk-button--primary" type="submit">
            {t("plat.bootstrap.submit")}
          </button>
        </Form>

        <p className="pk-login__subtitle">{t("plat.bootstrap.next")}</p>
      </div>
    </main>
  );
}
