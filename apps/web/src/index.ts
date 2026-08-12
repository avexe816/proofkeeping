import type { Env } from "@pk/db";
import { Hono } from "hono";
import { createRequestHandler, RouterContextProvider } from "react-router";

import { cloudflareContext } from "./lib/ui/cloudflare.js";
import {
  apiErrorHandler,
  apiNotFoundHandler,
  useTenantMiddleware,
  type AppEnv,
} from "./middleware/index.js";
import { runNightlyGeneration } from "./lib/task/nightly.js";
import health from "./routes/api/health.js";
import auth from "./routes/api/v1/auth.js";
import dev from "./routes/api/v1/dev.js";
import checklistTemplates from "./routes/api/v1/checklistTemplates.js";
import files from "./routes/api/v1/files.js";
import organization from "./routes/api/v1/organization.js";
import properties from "./routes/api/v1/properties.js";
import roomPlans from "./routes/api/v1/roomPlans.js";
import session from "./routes/api/v1/session.js";
import standardTimes from "./routes/api/v1/standardTimes.js";
import tasks from "./routes/api/v1/tasks.js";

/**
 * Workers のエントリポイント。**API（Hono）と画面（React Router）が同居する。**
 *
 * - wrangler.toml と bindings: P0-02（完了。binding の型は `Env`）
 * - 認証 API（/api/v1/auth）: P0-08 / P0-09
 * - middleware（session / tenant / resourceGuard）: P0-10
 * - UI シェル（React Router）: P0-14
 * - DocumentSequencer（Durable Object）: P0-17
 * - /api/health: P0-20
 *
 * ── 経路の分かれ方 ──────────────────────────────────────
 *   /api/**   Hono。JSON を返す。応答の形は `packages/contracts` が定義する
 *   それ以外   React Router。HTML と、その画面が使う loader / action
 *
 * 静的アセット（クライアント側の JS / CSS）は Worker より前に
 * `[assets]`（wrangler.toml）が返す。ここには来ない。
 */
const app = new Hono<AppEnv>();

/**
 * 例外と未定義経路の写像は**最上位に置く。**
 *
 * `notFound` は `app.route()` で合成した子アプリからは引き継がれないため
 * （`middleware/index.ts` の冒頭）、ここでしか登録できない。
 * `onError` は子アプリ側にも掛かるが、認証 API（下で先に生やす）を含め
 * 全経路を覆うために最上位にも置く。**素の例外をログへ流さない**
 * （architecture.md §1 — シャード番号を露出しない）。
 */
app.onError(apiErrorHandler());
app.notFound(apiNotFoundHandler());

// ヘルスチェック（P0-20）。**認証を要求しない唯一の API。**
// セッション middleware より前段に置く。監視はセッションを持てない。
app.route("/api/health", health);

// 認証不要の dev 経路（シード投入）。本番では 404。
// **`app` 側（認証 middleware の前）に置く。** 初期データが無いとログインできないため。
app.route("/api/v1/dev", dev);

// 認証だけはセッション middleware（P0-10）より前段に置く。
// セッションを作る経路がセッションを要求すると入口が無くなる。
//
// **この行が下の `app.route("/api/v1", api)` より前にあることが効いている。**
// Hono は登録順に照合するため、先に載せた `/api/v1/auth/login` は
// 後から `/api/v1/*` に付く middleware を通らない。順番を入れ替えないこと。
app.route("/api/v1/auth", auth);

/**
 * 認証を要求する API。**以降の API はこの `api` へ足すこと。**
 *
 * `app` に直接生やすと middleware が掛からず、`TenantContext` の無いまま
 * ハンドラが動く。`getTenant()` が例外にするので静かには壊れないが、
 * そもそも生やせる場所を 1 つにしておく。
 */
const api = new Hono<AppEnv>();
useTenantMiddleware(api);
// 施設の切替（P0-14）。**パスは `/api/v1/auth/switch-property`**（§23.4）だが、
// 認証済みでなければ意味が無いので、上の `auth`（未認証で通る側）ではなく
// こちらへ載せる。
api.route("/auth", session);
// 施設サマリー（P0-21）。rollup からのみ組み立て、60 秒 KV キャッシュ。
api.route("/properties", properties);
// 署名付き URL の受け口（P0-16）。角印だけ。**写真をここへ載せない。**
// **`api` 側に載せてあるのは意図。** 署名に加えてセッションも要求する
// （routes/api/v1/files.ts の注記）。`app` へ直に載せ替えないこと。
api.route("/files", files);
// 清掃タスク（P1-03 / P1-05 / P1-06）。状態変更は `Idempotency-Key` に対応する。
api.route("/tasks", tasks);
// 当日の客室状況（P1-04 / W-05）。CSV 取込と「全室アウト清掃として生成」。
api.route("/room-plans", roomPlans);
// 標準時間マスタ（P1-02 / W-17）。
api.route("/standard-times", standardTimes);
// チェックリスト定義（P1-06 / W-16）。3 階層の継承はタスク生成時に解決する。
api.route("/checklist-templates", checklistTemplates);
// 組織設定（P1-22 / §19.4）。施設選択画面を挟む閾値だけ。
api.route("/organization", organization);
app.route("/api/v1", api);

/**
 * 画面（React Router）。**API に一致しなかったものだけが来る。**
 *
 * `virtual:react-router/server-build` は Vite が組み立てるサーバービルド。
 * `import()` を関数で包んでいるのは、ビルドの読み込みを最初のリクエストまで
 * 遅らせるため（Worker の起動時間に載せない）。
 */
const handleUiRequest = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

app.all("*", async (c) => {
  // API の未定義経路は JSON の 404 のまま。**HTML を返さない**
  // （API の利用者が HTML を受け取ると、原因の切り分けが難しくなる）。
  if (c.req.path.startsWith("/api/")) return c.notFound();

  const context = new RouterContextProvider();
  context.set(cloudflareContext, { env: c.env, ctx: c.executionCtx });
  return handleUiRequest(c.req.raw, context);
});

/**
 * Durable Object クラスの公開。**wrangler.toml の `class_name` と対応する。**
 *
 * ここに現れないクラスは binding から到達できない。逆に、wrangler.toml へ
 * binding だけ足してここへ export を足さないと wrangler が起動しない。
 * 実装した task が両方を同時に足すこと（architecture.md §4 の 4 用途のみ）。
 */
export { DocumentSequencer } from "./durable/DocumentSequencer.js";

/**
 * Workers の既定エクスポート。**`fetch` と `scheduled` の両方を持つ。**
 *
 * `app` をそのまま既定エクスポートにすると `scheduled()` を生やせない
 * （Hono のインスタンスは `fetch` しか持たない）。オブジェクトへ包み、
 * `fetch` は Hono へ委譲する。
 *
 * ── scheduled（P1-03 / PK-SPEC-P1 §3.2）────────────────
 * 02:00 Asia/Tokyo に翌業務日のタスクを生成する。cron 式は
 * `wrangler.toml` の `[triggers]`（UTC 指定なので 17:00 UTC）。
 *
 * **返す Promise を `await` する。** Cron の実行は `scheduled()` の返した
 * Promise が解決するまで続く。`await` せずに投げると生成が途中で打ち切られる。
 * 結果は件数だけをログに出す（組織 ID・シャード番号を出さない /
 * architecture.md §1）。
 */
export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const result = await runNightlyGeneration(env, new Date());
    console.log(
      `nightly-generation properties=${String(result.properties)} ` +
        `created=${String(result.created)} failed=${String(result.failedProperties)}`,
    );
  },
} satisfies ExportedHandler<Env>;
