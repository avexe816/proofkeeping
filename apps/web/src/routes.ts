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
 * ── P0-21 が足した画面 ──────────────────────────────────
 *   /app/p/:propertyId/board  施設 1 件（URL を正としてセッションを更新）
 *   /app/org/dashboard        全社サマリー（全社ビューを持つロールのみ）
 *
 * ── P1-07〜P1-13 が足した現場画面（`/m/*`）───────────────
 *   /m/login                  M-01 PIN ログイン（シェルの外。未認証で開く）
 *   /m/today                  M-02 本日のタスク
 *   /m/task/:taskId           M-03 タスク詳細（写真もここ）
 *   /m/task/:taskId/checklist M-04 チェックリスト
 *
 * ── P1-22 が足した画面 ──────────────────────────────────
 *   /m/select-property        施設選択（担当が 4 施設以上のときだけ通る）
 *
 * ── P1-14〜P1-18 が足した画面 ───────────────────────────
 *   /app/p/:propertyId/tasks  W-04 タスク管理・人員配分
 *   /m/board                  M-10 客室ボード（W-03 と同じ盤面）
 *   /m/me                     M-11 自分の実績・表示言語
 *
 * `/m/*` は `/app/*` と別のシェルを持つ（topbar も sidebar も無い）。
 * **同じ layout に相乗りさせないこと。** 現場の画面は片手・手袋・暗所が
 * 前提で、管理画面と共有できる部品がほとんど無い（ui-writing.md §3）。
 */
export default [
  index("routes/home.ts"),
  route("login", "routes/login.tsx"),
  route("logout", "routes/logout.ts"),
  route("m/login", "routes/m/login.tsx"),
  layout("routes/m/layout.tsx", [
    route("m/today", "routes/m/today.tsx"),
    route("m/select-property", "routes/m/selectProperty.tsx"),
    route("m/task/:taskId", "routes/m/task.tsx"),
    route("m/task/:taskId/checklist", "routes/m/checklist.tsx"),
    route("m/board", "routes/m/board.tsx"),
    route("m/me", "routes/m/me.tsx"),
  ]),
  layout("routes/app/layout.tsx", [
    route("app/dashboard", "routes/app/dashboard.tsx"),
    route("app/p/:propertyId/board", "routes/app/propertyBoard.tsx"),
    route("app/p/:propertyId/tasks", "routes/app/propertyTasks.tsx"),
    route("app/org/dashboard", "routes/app/orgDashboard.tsx"),
    route("app/settings/rooms", "routes/app/rooms.tsx"),
    route("app/settings/tax", "routes/app/taxProfile.tsx"),
  ]),
  // シェルの外に置く。POST のたびにシェルの loader を動かす必要が無い
  // （切替後のリダイレクトで、どのみち loader は動き直す）。
  route("app/switch-property", "routes/app/switchProperty.ts"),
] satisfies RouteConfig;
