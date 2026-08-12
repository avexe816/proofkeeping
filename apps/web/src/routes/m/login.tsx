/**
 * M-01 PIN ログイン（PK-SPEC-P1 §9.1）。
 *
 * task:  docs/tasks/P1-07.md
 * ルール: .claude/rules/security.md §2, §8 / .claude/rules/ui-writing.md §3
 * 参照:  ui-prototypes/mobile/pk-01-pin-login.html
 *
 * ── 識別子は 3 フィールド固定 ───────────────────────────
 * `orgShortId` + スタッフ番号 + PIN（security.md §2 / DECISIONS #018）。
 * **プロトタイプの「施設コード」はこの `orgShortId` のこと。** 実装のある
 * 認証（P0-09）は組織で解決するので、画面の見出しも「組織 ID」にした。
 * 施設ごとのコードで入る認証は存在しない（作らないこと）。
 *
 * ── 数字はテンキーで入れる ──────────────────────────────
 * PIN は画面内のテンキーで入力し、OS のキーボードを出さない
 * （ui-writing.md §3 / プロトタイプの設計意図）。伏せ字のまま入るので
 * 覗き見にも強い。**表示切替ボタンを置かない。**
 *
 * ── レート制限は API と同じバケツ ───────────────────────
 * `/api/v1/auth/pin-login`（20 req/分/IP · security.md §8）と同じ
 * `consumeRateLimit(env, "pinLogin", ip)` を通す。画面経由なら回避できる、
 * という抜け道を作らない（`routes/login.tsx` と同じ方針）。
 *
 * ── 失敗の理由を分けない ────────────────────────────────
 * 識別子が無い・PIN が違う・ロック中・無効化済みを区別できる応答を
 * 返さない（security.md §2）。画面の文言も 1 種類だけ。
 *
 * ── 言語切替をここに置いていない ────────────────────────
 * プロトタイプは 7 言語の切替を最上部に常設するが、**翻訳が揃っているのは
 * `ja` だけ**（`locales/en.json` は管理画面ぶんの部分集合）。切り替える先の
 * 無い器を先に置かない。M-15 相当の言語切替は P1-18 の担当。
 */

import { pinLoginRequestSchema } from "@pk/contracts";
import { useState } from "react";
import {
  Form,
  redirect,
  useActionData,
  useSearchParams,
  type ActionFunctionArgs,
  type LinksFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { buildSessionCookie } from "../../lib/auth/cookie.js";
import { pinLogin } from "../../lib/auth/pinLogin.js";
import { clientIp, consumeRateLimit } from "../../lib/auth/rateLimit.js";
import { t } from "../../lib/i18n.js";
import { safeMobileNextPath } from "../../lib/mobile/session.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { readOptionalSession } from "../../lib/ui/requireSession.js";
import mobileStylesHref from "../../styles/mobile.css?url";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: mobileStylesHref }];

/** 画面に出す結果。**理由を分けない**ので種類は 3 つだけ。 */
type LoginFailure = "REJECTED" | "RATE_LIMITED" | "INVALID";

interface ActionData {
  failure: LoginFailure;
}

const FAILURE_MESSAGE: Record<LoginFailure, Parameters<typeof t>[0]> = {
  REJECTED: "m.login.rejected",
  RATE_LIMITED: "m.login.rateLimited",
  INVALID: "m.login.invalid",
};

/** PIN の桁数（security.md §2）。 */
const PIN_LENGTH = 4;

export async function loader({ request, context }: LoaderFunctionArgs) {
  // すでに入っているなら入り口に留めない。
  const session = await readOptionalSession(getEnv(context), request, new Date());
  if (session !== null) {
    return redirect(safeMobileNextPath(new URL(request.url).searchParams.get("next")));
  }
  return null;
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = getEnv(context);
  const now = new Date();

  const rate = await consumeRateLimit(env, "pinLogin", clientIp(request), now);
  if (!rate.allowed) return { failure: "RATE_LIMITED" } satisfies ActionData;

  const form = await request.formData();
  const parsed = pinLoginRequestSchema.safeParse({
    orgShortId: form.get("orgShortId"),
    staffNumber: form.get("staffNumber"),
    pin: form.get("pin"),
  });
  if (!parsed.success) return { failure: "INVALID" } satisfies ActionData;

  const result = await pinLogin(env, { credentials: parsed.data, now });
  if (!result.ok) return { failure: "REJECTED" } satisfies ActionData;

  // `pinMustChange`（security.md §2「初回変更を強制」）はここでは扱わない。
  // **PIN 変更画面が P1 の task に無い。** 画面ができるまで、初回の利用者も
  // そのまま入れる。docs/PROGRESS.md の申し送りに残してある。
  const next = safeMobileNextPath(form.get("next") as string | null);
  return redirect(next, {
    headers: {
      "Set-Cookie": buildSessionCookie(result.session.cookieValue, result.session.maxAgeSeconds),
    },
  });
}

export default function MobileLoginRoute(): React.ReactElement {
  const actionData = useActionData<ActionData>();
  const [searchParams] = useSearchParams();
  const next = safeMobileNextPath(searchParams.get("next"));
  const [pin, setPin] = useState("");

  const appendDigit = (digit: string): void => {
    setPin((current) => (current.length >= PIN_LENGTH ? current : current + digit));
  };

  return (
    <main className="pk-m">
      <div className="pk-m-login">
        <p className="pk-m-login__brand">{t("app.brand")}</p>
        <h1 className="pk-m-login__title">{t("m.login.title")}</h1>
        <p className="pk-m-login__sub">{t("m.login.subtitle")}</p>

        {actionData === undefined ? null : (
          <p className="pk-m-alert" role="alert">
            {t(FAILURE_MESSAGE[actionData.failure])}
          </p>
        )}

        <Form method="post" className="pk-m-login">
          <input type="hidden" name="next" value={next} />
          {/* テンキーで組み立てた PIN。**画面には伏せ字しか出さない。** */}
          <input type="hidden" name="pin" value={pin} />

          <label className="pk-m-field" htmlFor="orgShortId">
            <span className="pk-m-field__label">{t("m.login.orgShortId")}</span>
            <input
              className="pk-m-field__input"
              id="orgShortId"
              name="orgShortId"
              autoComplete="organization"
              inputMode="text"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
            <span className="pk-m-field__hint">{t("m.login.orgShortId.hint")}</span>
          </label>

          <label className="pk-m-field" htmlFor="staffNumber">
            <span className="pk-m-field__label">{t("m.login.staffNumber")}</span>
            <input
              className="pk-m-field__input"
              id="staffNumber"
              name="staffNumber"
              autoComplete="username"
              inputMode="numeric"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          </label>

          <div className="pk-m-field">
            <span className="pk-m-field__label">
              {t("m.login.pin")} · {t("m.login.pin.hint")}
            </span>
            <div className="pk-m-pin" aria-label={t("m.login.pin")}>
              {Array.from({ length: PIN_LENGTH }, (_, index) => (
                <span
                  key={index}
                  className={`pk-m-pin__dot ${index < pin.length ? "pk-m-pin__dot--on" : ""}`}
                />
              ))}
            </div>
          </div>

          <div className="pk-m-keypad">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => (
              <button
                key={digit}
                type="button"
                className="pk-m-keypad__key"
                onClick={() => {
                  appendDigit(digit);
                }}
              >
                {digit}
              </button>
            ))}
            <button
              type="button"
              className="pk-m-keypad__key pk-m-keypad__key--function"
              onClick={() => {
                setPin("");
              }}
            >
              {t("m.login.keypad.clear")}
            </button>
            <button
              type="button"
              className="pk-m-keypad__key"
              onClick={() => {
                appendDigit("0");
              }}
            >
              0
            </button>
            <button
              type="button"
              className="pk-m-keypad__key pk-m-keypad__key--function"
              onClick={() => {
                setPin((current) => current.slice(0, -1));
              }}
              aria-label={t("m.login.keypad.delete")}
            >
              ⌫
            </button>
          </div>

          <button
            className="pk-m-button"
            type="submit"
            disabled={pin.length !== PIN_LENGTH}
          >
            {t("m.login.submit")}
          </button>
        </Form>

        <p className="pk-m-note pk-m-note--center">{t("m.login.help")}</p>
        {/* ログインには通信が要る（§8.4 の対象外）。先に伝えておく。 */}
        <p className="pk-m-note pk-m-note--center">{t("m.login.offline")}</p>
      </div>
    </main>
  );
}
