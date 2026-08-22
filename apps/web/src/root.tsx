import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteError,
  type LinksFunction,
  type MetaFunction,
} from "react-router";

import { t } from "./lib/i18n.js";
import { documentTitle } from "./lib/ui/pageTitle.js";
import appStylesHref from "./styles/app.css?url";

/**
 * アプリの外枠。
 *
 * task:  docs/tasks/P0-14.md
 * ルール: .claude/rules/ui-writing.md §1（JSX に文言を直書きしない）
 *
 * ── 言語は `ja` 固定 ────────────────────────────────────
 * **ブラウザの言語設定を参照しない**（共用端末で誤動作する）。
 * 言語の選択と保持は P0-15 の担当。ここは既定の日本語だけを宣言する。
 */

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: appStylesHref },
  // ブランドマーク（銀杏の葉 / 人間の指示 2026-08-22）。**`public/` に置く。**
  // HTML の中の図形はタブのアイコンにできないので、`ui/Logo.tsx` と
  // **同じ絵が 2 か所にある**（`Logo.tsx` の注記）。
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
];

/**
 * タブの題名。**画面ごとに `meta` を書かず、ここ 1 か所で経路から引く**
 * （`lib/ui/pageTitle.ts` の注記 / 人間の指示 2026-08-22）。
 *
 * 出すのはサイドバーのリンクと同じ文字。**別表を作らない。**
 */
export const meta: MetaFunction = ({ location }) => [{ title: documentTitle(location.pathname) }];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        {/* 現場は iPhone SE の小画面まで含む（testing.md §6）。拡大操作を止めない。 */}
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

/**
 * 例外の表示。**内部の詳細を画面に出さない。**
 *
 * シャード番号・スタックトレース・DB の文言が利用者に見えないようにする
 * （architecture.md §1 / `middleware/resourceGuard.ts` と同じ方針）。
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const message =
    isRouteErrorResponse(error) && error.status === 404 ? t("page.notFound") : t("page.unexpected");

  return (
    <main className="pk-message">
      <p>{message}</p>
    </main>
  );
}
