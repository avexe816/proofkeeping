import { index, layout, route, type RouteConfig } from "@react-router/dev/routes";

/**
 * UI のルート定義。**ファイル規約を使わず、ここに明示する。**
 *
 * task: docs/tasks/P0-14.md
 *
 * 規約（`@react-router/fs-routes`）にすると `src/routes/api/v1/*.ts`
 * （Hono のハンドラ）まで UI のルートとして拾われる。API は Hono が
 * `src/index.ts` で先に受けるので、ここには現れない。
 *
 * ── P0-14 が置く画面 ────────────────────────────────────
 *   /                     → /app/dashboard へ寄せる
 *   /login                最小のログイン（P0-08 の 3 フィールド）
 *   /logout               action のみ
 *   /app/*                認証必須のシェル（topbar + sidebar）
 *   /app/dashboard        レイアウト確認用の空の画面
 *   /app/switch-property  施設の切替（action のみ）
 *
 * 各画面の中身は後続 task。**URL に施設 ID を含める形
 * （`/app/p/{propertyId}/board` — PK-SPEC-P0 §23.5）は P0-21 が入れる。**
 */
export default [
  index("routes/home.ts"),
  route("login", "routes/login.tsx"),
  route("logout", "routes/logout.ts"),
  layout("routes/app/layout.tsx", [route("app/dashboard", "routes/app/dashboard.tsx")]),
  // シェルの外に置く。POST のたびにシェルの loader を動かす必要が無い
  // （切替後のリダイレクトで、どのみち loader は動き直す）。
  route("app/switch-property", "routes/app/switchProperty.ts"),
] satisfies RouteConfig;
