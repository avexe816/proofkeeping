/**
 * 現場画面（`/m/*`）の文脈。
 *
 * task:  docs/tasks/P1-07.md 〜 P1-10
 * ルール: .claude/rules/security.md §1, §2
 *
 * ── 管理画面と何が違うのか ──────────────────────────────
 * 組み立てる `TenantContext` は同じ。**戻り先だけが違う。**
 * 管理画面は `/login`、現場は `/m/login`（PIN・16 時間）。
 * 判定そのものは `requireAppContext()` を通す。**現場側で緩い判定を
 * 作らないこと**（`lib/ui/requireSession.ts` の注記と同じ）。
 */

import { findOrganization, findUserById, type Env, type TenantContext } from "@pk/db";
import { redirect } from "react-router";

import { createTranslator, resolveLocale, type Locale, type Translator } from "../i18n.js";
import { requireAppContext, type AppContext } from "../ui/requireSession.js";

/** PIN ログイン画面のパス。 */
export const MOBILE_LOGIN_PATH = "/m/login";

/** ログイン後に開く画面（M-02）。 */
export const MOBILE_HOME_PATH = "/m/today";

/** 施設選択画面（§19.4 / P1-22）。**4 施設以上のときだけ通る。** */
export const SELECT_PROPERTY_PATH = "/m/select-property";

/** 現場画面が受け取る文脈。 */
export interface MobileContext extends AppContext {
  tenant: TenantContext;
  /** 表示言語の `t()`。**モバイルは英語対応がある**（ui-writing.md §1）。 */
  t: Translator;
  locale: Locale;
  /** 表示名（M-02 の見出し）。ユーザーが消えていれば空。 */
  displayName: string;
  /**
   * 施設選択画面を挟む担当施設数（PK-SPEC-P1 §19.4 / P1-22）。
   *
   * 組織を引くのは言語の解決で既に行っているので、**ここに載せて
   * クエリを増やさない。** 組織が引けない場合は既定の 4。
   */
  propertySelectionThreshold: number;
}

/** 施設選択画面を挟む担当施設数の既定（§19.4）。 */
const DEFAULT_PROPERTY_SELECTION_THRESHOLD = 4;

/**
 * `next` を安全なパスへ正規化する（`/m/*` 限定）。
 *
 * 管理画面の `safeNextPath()` と分けてあるのは、PIN で入った利用者を
 * `/app/*` へ戻す `next` を通さないため。**画面の外へ出さない。**
 */
export function safeMobileNextPath(next: string | null): string {
  if (next === null || next === "") return MOBILE_HOME_PATH;
  if (!next.startsWith("/m/")) return MOBILE_HOME_PATH;
  if (next.startsWith("//")) return MOBILE_HOME_PATH;
  return next;
}

/** PIN ログイン画面へ戻す 302。戻り先を `next` に載せる。 */
export function redirectToMobileLogin(request: Request): Response {
  const url = new URL(request.url);
  const next = `${url.pathname}${url.search}`;
  if (next.startsWith(MOBILE_LOGIN_PATH)) return redirect(MOBILE_LOGIN_PATH);
  return redirect(`${MOBILE_LOGIN_PATH}?next=${encodeURIComponent(next)}`);
}

/**
 * 現場画面の loader / action から呼ぶ。
 *
 * セッションが無ければ `/m/login` へ 302 を **throw** する。
 *
 * **ロールで画面を弾いていない。** `/m/today` は担当タスクの一覧で、
 * 施設責任者が自分の端末で見ても害が無い（`listTasks({ assigneeId })` は
 * 自分のぶんしか返さない）。到達してよいかの判定は、資源に触る時点で
 * `assertPermission()` が行う（security.md §1「フロントの非表示は
 * 権限制御とみなさない」の裏返しで、フロントで弾くことも権限制御ではない）。
 */
export async function requireMobileContext(
  env: Env,
  request: Request,
  now: Date,
): Promise<MobileContext> {
  // `requireAppContext()` はセッションが無いと `/login` への 302 を throw する。
  // **現場の入口は `/m/login`。** 受け止めて行き先だけ差し替える
  // （React Router は throw された `Response` をそのまま応答に使う）。
  const base: AppContext = await requireAppContext(env, request, now).catch(
    (error: unknown): never => {
      if (error instanceof Response && error.status === 302) {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- React Router の制御フロー
        throw redirectToMobileLogin(request);
      }
      throw error;
    },
  );

  // **ブラウザの言語設定を読まない**（ui-writing.md §1）。
  // ユーザー属性 → 組織の既定 → `ja` の 3 段だけ（`lib/i18n.ts`）。
  const [user, organization] = await Promise.all([
    findUserById(env, base.tenant, base.session.userId),
    findOrganization(env, base.tenant),
  ]);
  const locale = resolveLocale(user?.locale, organization?.locale);

  return {
    ...base,
    t: createTranslator(locale),
    locale,
    displayName: user?.displayName ?? "",
    propertySelectionThreshold:
      organization?.propertySelectionThreshold ?? DEFAULT_PROPERTY_SELECTION_THRESHOLD,
  };
}
