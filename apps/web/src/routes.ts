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
 * ── P1-02 / P1-04 / P1-06 の未達分（PC 管理画面）─────────
 *   /app/p/:propertyId/plan       W-05 当日の客室状況入力
 *   /app/settings/checklists      W-16 チェックリスト定義
 *   /app/settings/standard-times  W-17 標準時間設定
 *
 * ── P1-24（P1 の後・P2 の前）───────────────────────────
 *   /app/settings/room-types      W-25 客室タイプ管理
 *
 * ── P2-05 / P2-06 が足した検査の画面 ────────────────────
 *   /m/inspections                M-08 検査待ち一覧
 *   /m/inspection/:inspectionId   M-09 検査実施
 *
 * ── P2-07 が足した再清掃の画面 ──────────────────────────
 *   /m/task/:taskId/rework        M-12 再清掃
 *
 * ── P2-13 が足した報告の画面 ────────────────────────────
 *   /m/report?taskId=...          M-13 報告（忘れ物 / 不具合の 2 択）
 *
 * **`?taskId=` で客室を解決する。** 現場は「いまいる部屋」で報告するので
 * 客室を選ばせない（`routes/m/report.tsx` の loader の注記）。
 *
 * ── P3-03〜P3-06 / P3-11 が足した観察の画面 ────────────
 *   /m/task/:taskId/observation   M-05 入室時の記録（M-05b は同じ画面の 2/2）
 *   /m/task/:taskId/linen         M-06 リネン枚数（退室前）
 *   /app/settings/observation     W-20 観察項目の設定
 *
 * **M-05 は `start` の直後にここへ来る**（§3.2）。M-02 の「開始」を押すと
 * 遷移する。清掃後に入力させると値が変わり、データとして無意味になる。
 *
 * ── P3-10 / P3-12 が足したベースラインの画面 ────────────
 *   /app/settings/baseline           W-21 ベースライン確認・上書き
 *   /app/p/:propertyId/data-quality  W-22 データ品質ダッシュボード
 *
 * **W-21 は設定、W-22 は施設の画面。** ベースラインは施設ごとの値だが、
 * 上書きは `ORG_ADMIN` の操作（§5.5）で、表示中の施設に対して行う。
 * 入力品質は施設と月で見るので `:propertyId` を URL に持つ。
 *
 * ── P2-09 が足した証跡の画面 ────────────────────────────
 *   /app/p/:propertyId/evidence          W-06 証跡一覧（1 業務日ぶん）
 *   /app/p/:propertyId/evidence/:taskId  W-07 証跡詳細（§12.2 の表示順）
 *
 * **`taskId` で開く。** 清掃者は差戻しの ID を知らない（M-02 の一覧から
 * 部屋を押して入る）。`/m/rework/:reworkCycleId` にしない理由は
 * `routes/m/rework.tsx` の loader の注記。
 *
 * 上の 3 画面が読む `room_type` に**書く経路が一つも無かった。** seed の
 * 無い組織では W-17 が 0 行、W-16 の第 3 階層が作れない状態だった。
 *
 * 3 task はいずれも API だけを実装し、画面を「Batch 2/3 の担当」として
 * 残していた。Batch 2/3（P1-07〜P1-18）は現場画面（`/m/*`）を作って
 * 通り過ぎており、**§10.1 の PC 5 画面のうち W-03 / W-04 しか無かった。**
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
    route("m/task/:taskId/rework", "routes/m/rework.tsx"),
    route("m/task/:taskId/observation", "routes/m/observation.tsx"),
    route("m/task/:taskId/linen", "routes/m/linen.tsx"),
    route("m/report", "routes/m/report.tsx"),
    route("m/board", "routes/m/board.tsx"),
    route("m/me", "routes/m/me.tsx"),
    route("m/inspections", "routes/m/inspections.tsx"),
    route("m/inspection/:inspectionId", "routes/m/inspection.tsx"),
  ]),
  layout("routes/app/layout.tsx", [
    route("app/dashboard", "routes/app/dashboard.tsx"),
    route("app/p/:propertyId/board", "routes/app/propertyBoard.tsx"),
    route("app/p/:propertyId/tasks", "routes/app/propertyTasks.tsx"),
    route("app/p/:propertyId/plan", "routes/app/propertyPlan.tsx"),
    route("app/p/:propertyId/evidence", "routes/app/evidenceList.tsx"),
    route("app/p/:propertyId/evidence/:taskId", "routes/app/evidenceDetail.tsx"),
    route("app/org/dashboard", "routes/app/orgDashboard.tsx"),
    route("app/settings/rooms", "routes/app/rooms.tsx"),
    route("app/settings/room-types", "routes/app/roomTypes.tsx"),
    route("app/settings/checklists", "routes/app/checklists.tsx"),
    route("app/settings/standard-times", "routes/app/standardTimes.tsx"),
    route("app/settings/tax", "routes/app/taxProfile.tsx"),
    route("app/settings/observation", "routes/app/observationSettings.tsx"),
    route("app/settings/baseline", "routes/app/baselineSettings.tsx"),
    route("app/p/:propertyId/data-quality", "routes/app/dataQuality.tsx"),
  ]),
  // シェルの外に置く。POST のたびにシェルの loader を動かす必要が無い
  // （切替後のリダイレクトで、どのみち loader は動き直す）。
  route("app/switch-property", "routes/app/switchProperty.ts"),
] satisfies RouteConfig;
