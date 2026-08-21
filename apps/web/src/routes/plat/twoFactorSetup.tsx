import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { clientIp, consumeRateLimit } from "../../lib/auth/rateLimit.js";
import { t } from "../../lib/i18n.js";
import { encodeQr, qrPath } from "../../lib/qr/encode.js";
import { requirePlatformSecondFactorStage } from "../../lib/platform/requireOperator.js";
import {
  buildPlatformSessionCookie,
  destroyPlatformSession,
} from "../../lib/platform/session.js";
import { beginTotpEnrollment, confirmTotpEnrollment } from "../../lib/platform/twoFactor.js";
import { getEnv } from "../../lib/ui/cloudflare.js";

/**
 * TOTP の登録（PF-17）。運営担当者は**必須** — 飛ばす経路は無い。
 *
 *   /plat/2fa/setup
 *
 * task: docs/tasks/PF-17.md
 * 決定: docs/DECISIONS.md #241
 *
 * ── 入れるのは「パスワード段階の札」×「未登録」だけ ─────
 * 札が無ければ 404。登録済みの担当者は `/plat/2fa`（検証）へ送り、
 * **この画面から 2FA を掛け替えさせない**（パスワードを盗んだだけの
 * 相手が秘密を差し替えられる形にしない）。
 *
 * ── 秘密の見せ方 ────────────────────────────────────────
 * QR（otpauth URI）と手入力用の base32 キーを**この画面にだけ**出す。
 * どちらも秘密そのもの。ログ・監査ログへは載せない（完了条件）。
 *
 * ── 復旧コードは 1 回だけ表示 ───────────────────────────
 * 確認が通った action の応答でだけ平文を返す（DB はハッシュのみ）。
 * リロードすると二度と出ない。**再表示の経路を作らない**
 * （公開 API キーと同じ扱い / security.md §7）。
 */

type Failure = "REJECTED" | "RATE_LIMITED" | "INVALID";

type ActionData = { failure: Failure } | { recoveryCodes: string[] };

const FAILURE_MESSAGE: Record<Failure, Parameters<typeof t>[0]> = {
  REJECTED: "plat.twofa.rejected",
  RATE_LIMITED: "plat.login.rateLimited",
  INVALID: "plat.login.invalid",
};

interface SetupData {
  otpauthUri: string;
  secret: string;
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<SetupData> {
  const env = getEnv(context);
  const now = new Date();
  const stage = await requirePlatformSecondFactorStage(env, request, now);
  if (stage === null) throw redirect("/plat/status");
  if (stage.operator.twoFactorConfirmedAt !== null) throw redirect("/plat/2fa");

  // 未確認の秘密が残っていればそれを使い回す（確認に失敗して戻るたびに
  // 秘密が変わると、アプリへ読み込んだ QR が二度と通らない）。
  const enrollment = await beginTotpEnrollment(env, { operator: stage.operator, now });
  if (enrollment === null) throw redirect("/plat/2fa");
  return { otpauthUri: enrollment.otpauthUri, secret: enrollment.secret };
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = getEnv(context);
  const now = new Date();
  const ip = clientIp(request);

  const rate = await consumeRateLimit(env, "login", ip, now);
  if (!rate.allowed) return { failure: "RATE_LIMITED" } satisfies ActionData;

  const stage = await requirePlatformSecondFactorStage(env, request, now);
  if (stage === null) throw redirect("/plat/status");
  if (stage.operator.twoFactorConfirmedAt !== null) throw redirect("/plat/2fa");

  const form = await request.formData();
  const code = form.get("code");
  if (typeof code !== "string" || code.trim() === "") {
    return { failure: "INVALID" } satisfies ActionData;
  }

  const result = await confirmTotpEnrollment(env, {
    operator: stage.operator,
    code: code.trim(),
    now,
    ip,
  });
  if (!result.ok) return { failure: "REJECTED" } satisfies ActionData;

  // 登録の確定はログインの成立でもある。パスワード段階の札を破棄し、
  // `COMPLETE` の札に載せ替えたうえで**復旧コードを 1 回だけ**見せる。
  await destroyPlatformSession(env, stage.cookieValue);
  return data({ recoveryCodes: result.recoveryCodes } satisfies ActionData, {
    headers: {
      "Set-Cookie": buildPlatformSessionCookie(
        result.session.cookieValue,
        result.session.maxAgeSeconds,
      ),
    },
  });
}

export default function PlatformTwoFactorSetup() {
  const setup = useLoaderData<SetupData>();
  const actionData = useActionData<ActionData>();

  if (actionData !== undefined && "recoveryCodes" in actionData) {
    return <RecoveryCodesOnce codes={actionData.recoveryCodes} />;
  }

  const qr = encodeQr(setup.otpauthUri);

  return (
    <main className="pk-login">
      <div className="pk-login__panel">
        <p className="pk-login__brand">
          {t("app.brand")} <span className="pk-plat-badge">{t("plat.badge")}</span>
        </p>
        <h1 className="pk-login__title">{t("plat.twofa.setup.title")}</h1>
        <p className="pk-login__subtitle">{t("plat.twofa.setup.subtitle")}</p>

        {actionData !== undefined && "failure" in actionData ? (
          <p className="pk-login__notice" role="alert">
            {t(FAILURE_MESSAGE[actionData.failure])}
          </p>
        ) : null}

        <p className="pk-login__subtitle">{t("plat.twofa.setup.scan")}</p>
        <svg
          className="pk-totp-qr"
          viewBox={`0 0 ${String(qr.size)} ${String(qr.size)}`}
          role="img"
          aria-label={t("plat.twofa.setup.qrAlt")}
        >
          <rect width={qr.size} height={qr.size} fill="#fff" />
          <path d={qrPath(qr)} fill="#000" />
        </svg>

        <p className="pk-login__subtitle">{t("plat.twofa.setup.manual")}</p>
        {/* 手入力用のキー。**この画面以外に出さない。** */}
        <p className="pk-totp-secret">{setup.secret}</p>

        <Form className="pk-login__form" method="post">
          <label className="pk-field" htmlFor="plat-totp-setup-code">
            <span className="pk-field__label">{t("plat.twofa.setup.confirm")}</span>
            <input
              autoComplete="one-time-code"
              className="pk-field__input"
              id="plat-totp-setup-code"
              inputMode="numeric"
              name="code"
              required
              spellCheck={false}
              type="text"
            />
          </label>

          <button className="pk-button pk-button--primary" type="submit">
            {t("plat.twofa.setup.submit")}
          </button>
        </Form>
      </div>
    </main>
  );
}

/** 復旧コードの 1 回だけの表示。リロードすると出ない（保存もしない）。 */
function RecoveryCodesOnce({ codes }: { codes: string[] }) {
  return (
    <main className="pk-login">
      <div className="pk-login__panel">
        <p className="pk-login__brand">
          {t("app.brand")} <span className="pk-plat-badge">{t("plat.badge")}</span>
        </p>
        <h1 className="pk-login__title">{t("plat.twofa.codes.title")}</h1>
        <p className="pk-login__subtitle">{t("plat.twofa.codes.notice")}</p>
        <p className="pk-login__subtitle">{t("plat.twofa.codes.onetime")}</p>

        <ul className="pk-recovery-codes">
          {codes.map((code) => (
            <li className="pk-recovery-codes__item" key={code}>
              {code}
            </li>
          ))}
        </ul>

        <Link className="pk-button pk-button--primary" to="/plat/status">
          {t("plat.twofa.codes.continue")}
        </Link>
      </div>
    </main>
  );
}
