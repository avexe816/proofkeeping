import type { Env } from "@pk/db";
import { Hono } from "hono";
import { createRequestHandler, RouterContextProvider } from "react-router";

import { handleArchiveExportBatch, isArchiveExportMessage } from "./consumers/archive.js";
import { handleBaselineLearningBatch } from "./consumers/baselineLearning.js";
import { handleDailyReportBatch } from "./consumers/dailyReport.js";
import { handleEvidenceExportBatch } from "./consumers/evidenceExport.js";
import { handleNotificationBatch } from "./consumers/notification.js";
import { handleReconciliationBatch } from "./consumers/reconciliation.js";
import {
  handleResidencyAlertBatch,
  isResidencyAlertMessage,
} from "./consumers/residencyAlert.js";
import {
  handleArchiveRestoreBatch,
  isArchiveRestoreMessage,
} from "./consumers/archiveRestore.js";
import { handlePhotoRetentionBatch, isPhotoRetentionMessage } from "./consumers/photoRetention.js";
import { handleRollupUpdateBatch } from "./consumers/rollup.js";
import {
  handleTenantSnapshotBatch,
  isTenantSnapshotMessage,
} from "./consumers/tenantSnapshot.js";
import { handleSignalIngestBatch, isSignalIngestMessage } from "./consumers/signalIngest.js";
import {
  missingSecretNames,
  missingSecretsMessage,
} from "./lib/config/requiredSecrets.js";
import { cloudflareContext } from "./lib/ui/cloudflare.js";
import { dispatchArchiveExport, isArchiveDispatchMoment } from "./lib/archive/dispatch.js";
import { dispatchPhotoRetention } from "./lib/photo/retentionDispatch.js";
import { dispatchTenantSnapshots } from "./lib/platform/snapshotDispatch.js";
import { RESIDENCY_ALERT_CRON } from "./lib/staff/residencyAlert.js";
import { dispatchResidencyAlerts } from "./lib/staff/residencyAlertDispatch.js";
import {
  apiErrorHandler,
  apiNotFoundHandler,
  useTenantMiddleware,
  type AppEnv,
} from "./middleware/index.js";
import {
  BASELINE_LEARNING_CRON,
  dispatchBaselineLearning,
} from "./lib/baseline/dispatch.js";
import {
  MONTHLY_CLOSE_CRON,
  isMonthlyCloseMoment,
  runMonthlyClose,
} from "./lib/billing/monthlyClose.js";
import { DAILY_REPORT_CRON, dispatchDailyReports } from "./lib/report/dispatch.js";
import { dispatchReconciliation } from "./lib/reconciliation/dispatch.js";
import { runNightlyGeneration } from "./lib/task/nightly.js";
import health from "./routes/api/health.js";
import auth from "./routes/api/v1/auth.js";
import baselines from "./routes/api/v1/baselines.js";
import dev from "./routes/api/v1/dev.js";
import platformBootstrap from "./routes/api/v1/platformBootstrap.js";
import smtpProbe from "./routes/api/v1/smtpProbe.js";
import smtpSendTest from "./routes/api/v1/smtpSendTest.js";
import checklistTemplates from "./routes/api/v1/checklistTemplates.js";
import dataQuality from "./routes/api/v1/dataQuality.js";
import evidence from "./routes/api/v1/evidence.js";
import files from "./routes/api/v1/files.js";
import findings from "./routes/api/v1/findings.js";
import inspections from "./routes/api/v1/inspections.js";
import issues from "./routes/api/v1/issues.js";
import lostItems from "./routes/api/v1/lostItems.js";
import organization from "./routes/api/v1/organization.js";
import properties from "./routes/api/v1/properties.js";
import reconciliation from "./routes/api/v1/reconciliation.js";
import reworks from "./routes/api/v1/reworks.js";
import reports from "./routes/api/v1/reports.js";
import observations from "./routes/api/v1/observations.js";
import occupancy from "./routes/api/v1/occupancy.js";
import roomAccessLogs from "./routes/api/v1/roomAccessLogs.js";
import ruleConfigs from "./routes/api/v1/ruleConfigs.js";
import roomPlans from "./routes/api/v1/roomPlans.js";
import billingPeriodsRoute from "./routes/api/v1/billingPeriods.js";
import payoutsRoute from "./routes/api/v1/payouts.js";
import deliveriesRoute from "./routes/api/v1/deliveries.js";
import invoicesRoute from "./routes/api/v1/invoices.js";
import integrationWebhooksRoute from "./routes/api/v1/integrationWebhooks.js";
import integrations from "./routes/api/v1/integrations.js";
import apiKeys from "./routes/api/v1/apiKeys.js";
import archives from "./routes/api/v1/archives.js";
import publicApi from "./routes/api/v1/public.js";
import webhooksRoute from "./routes/api/v1/webhooks.js";
import receiptsRoute from "./routes/api/v1/receipts.js";
import counterparties from "./routes/api/v1/counterparties.js";
import dashboardRoute from "./routes/api/v1/dashboard.js";
import pricingRules from "./routes/api/v1/pricingRules.js";
import roomTypes from "./routes/api/v1/roomTypes.js";
import users from "./routes/api/v1/users.js";
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
 * - InspectionLock（Durable Object）: P2-03
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

/**
 * 必須 secret の検査。**いちばん前に置く。**
 *
 * `.dev.vars` を作らずに起動すると `SESSION_SECRET` が空文字になり、
 * ログインが `INTERNAL_ERROR`（500）で落ちる（空鍵は
 * `crypto.subtle.importKey()` が弾く）。**応答からは原因が読めない**ので、
 * ここで名前を挙げて 503 を返す（`lib/config/requiredSecrets.ts`）。
 *
 * ── ヘルスチェックより前 ────────────────────────────────
 * `/api/health` も通す。設定が欠けた Worker を「正常」と答えさせない。
 *
 * ── 値を出さない ────────────────────────────────────────
 * 応答にもログにも**名前だけ**を出す（architecture.md §1 と同じ方針）。
 */
app.use("*", async (c, next) => {
  const missing = missingSecretNames(c.env);
  if (missing.length === 0) return next();

  console.error(`configuration-incomplete missing=${missing.join(",")}`);
  const message = missingSecretsMessage(missing);
  // API は JSON、画面はそのまま読める本文。**どちらも 503**（設定が入れば直る）。
  if (c.req.path.startsWith("/api/")) {
    return c.json({ error: "CONFIGURATION_INCOMPLETE", missing }, 503);
  }
  return c.text(message, 503);
});

// ヘルスチェック（P0-20）。**認証を要求しない唯一の API。**
// セッション middleware より前段に置く。監視はセッションを持てない。
app.route("/api/health", health);

// 認証不要の dev 経路（シード投入）。本番では 404。
// **`app` 側（認証 middleware の前）に置く。** 初期データが無いとログインできないため。
app.route("/api/v1/dev", dev);

// 運営担当者の初期開通（PF-16）。**1 人目だけ・人が押したときだけ。**
// セッションを持たない経路で、守っているのは `PLATFORM_BOOTSTRAP_TOKEN`
// （鍵が無ければ 404）。**`dev` と違い production でも開く** — 本番の
// 1 人目を作るための経路だから（`platformBootstrap.ts` の冒頭）。
app.route("/api/v1/platform", platformBootstrap);

// SMTP の疎通確認（P5-21）。**鍵が無ければ 404。メールは送らない。**
// 鍵は workflow が実行のたびに作って消す（`.github/workflows/smtp-probe.yml`）。
app.route("/api/v1/dev", smtpProbe);

// 送信経路の確認（P5-23）。**固定の文面を 1 通だけ送る。鍵が無ければ 404。**
// 宛先は実行のたびに人が指定する（`.github/workflows/smtp-send-test.yml`）。
app.route("/api/v1/dev", smtpSendTest);

// Webhook（P5-10 / PK-SPEC-P5 §2.7）。**セッションを持たない経路。**
// 守っているのは署名（security.md §7）。認証 middleware の前段に置く。
app.route("/api/v1/webhooks", webhooksRoute);

// 汎用 Webhook 受信口（P6-04 / PK-SPEC-P6 §4.2）。**同じくセッションを持たない。**
// 守っているのは `X-PK-Signature`（HMAC-SHA256）で、検証失敗は 401。
app.route("/api/v1/integrations", integrationWebhooksRoute);

// 公開 API（P6-12 / PK-SPEC-P6 §6）。**セッションを持たない経路。**
// 認証は `Authorization: Bearer`（`middleware/apiKey.ts`）で、
// **`useTenantMiddleware()` を付けない。** 認証 middleware の前段に置く。
app.route("/api/v1/public", publicApi);

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
// 検査（P2-04 / PK-SPEC-P2 §4）。開始だけは `/tasks/:taskId/inspection/start`
// （§14.1 の経路名）。**全体の判定を受け取る口が無い**（§4.3 MUST）。
api.route("/inspections", inspections);
// 当日の客室状況（P1-04 / W-05）。CSV 取込と「全室アウト清掃として生成」。
// 差戻し・再清掃（P2-07 / PK-SPEC-P2 §4.6・§4.7）。**一覧の口は無い。**
// 差戻しはタスクから辿る（`routes/api/v1/reworks.ts` の注記）。
api.route("/reworks", reworks);
// 証跡（P2-09 / P2-10 / PK-SPEC-P2 §14.2）。**書き込みの口が無い。**
// 証跡は業務操作の副産物としてサーバーが書く（`contracts/evidence.ts`）。
// ここにあるのは一覧・詳細・整合性確認・ZIP 出力の 4 つ。
api.route("/evidence", evidence);
// 忘れ物（P2-11 / PK-SPEC-P2 §7・§14.3）。**持ち主の情報を受け取る口が無い。**
// `CLEANER` の絞り（自分の登録だけ・保管場所を伏せる）は `lib/report/lostItem.ts`。
api.route("/lost-items", lostItems);
// 設備不具合（P2-12 / 同 §8・§14.3）。**`CRITICAL` だけが客室を止める。**
// 解決しても客室は自動復旧しない（§8.3）。
api.route("/issues", issues);
// 日報（P2-14 / PK-SPEC-P2 §9・§14.4）。**削除・訂正・送付の口が無い。**
// 生成は必ず Queue を通る（`consumers/dailyReport.ts`）。
api.route("/reports", reports);
api.route("/room-plans", roomPlans);
// 観察記録（P3-03〜P3-07 / PK-SPEC-P3 §7）。**削除の口が無い。**
// 記録・スキップはタスク側（`/tasks/:id/observation`）。ここは一覧と事後修正。
api.route("/observations", observations);
// 消耗ベースライン（P3-09 / P3-10 / PK-SPEC-P3 §5・§7）。**削除の口が無い。**
// 上書きは p90 だけ・理由必須（§5.5）。再計算は必ず Queue を通る。
api.route("/baselines", baselines);
// 稼働記録（P4-02 / PK-SPEC-P4 §8）。**削除の口が無い。**
// 取込元（`source`）は口が決める。`PMS_API` を名乗る経路を作らない。
api.route("/occupancy", occupancy);
// 稼働照合（P4-05 / PK-SPEC-P4 §5.4）。**手動実行の口だけ。**
api.route("/reconciliation", reconciliation);
// 差異レポート（P4-06 / P4-07 / 同 §6）。**作る口・消す口が無い。**
// `CLEANER` / `INSPECTOR` は 404（§6.4 MUST / security.md §1）。
api.route("/findings", findings);
// 業務上の入室記録（P4-10 / 同 §2.3・§4.1）。**更新・削除の口が無い。**
// 登録は差異を抑制するので、書けるのは施設責任者以上（DECISIONS #115）。
api.route("/room-access-logs", roomAccessLogs);
// ルール設定（P4-13 / 同 §2.7 / W-25）。**engine を変えずに調整するための口。**
// ルールの条件式を送る欄が無い。`OWNER` / `ORG_ADMIN` だけ（§6.4）。
api.route("/rule-configs", ruleConfigs);
// 連携の再接続（P6-07 / PK-SPEC-P6 §3.4）。**サーキットブレーカーを閉じる口。**
// 受信口（`/api/v1/integrations/webhook/:id`）は上の認証前段にある。
// こちらはセッションが要り、`OWNER` / `ORG_ADMIN` だけ（DECISIONS #143）。
api.route("/integrations", integrations);
// API キーの管理（P6-12 / 同 §6.1）。**平文は作成時の応答だけ。**
// 再表示の口を作らないこと（§6.1 MUST）。`OWNER` / `ORG_ADMIN` だけ。
api.route("/api-keys", apiKeys);
// 退避データの復元と閲覧（P7-09 / PK-SPEC-P7 §9）。
// **退避を消す口は無い。** 期限で読めなくなるのは復元した写しだけ。
api.route("/archives", archives);
// 観察記録の入力品質（P3-12 / 同 §6.3 / W-22）。**読み取りだけ。**
// スタッフ別は入力率だけを返す（security.md §5 / INV-07）。
api.route("/data-quality", dataQuality);
// 客室タイプ（P1-24 / W-25）。**物理削除の口が無い**（無効化のみ）。
api.route("/room-types", roomTypes);
// 現場スタッフの登録（P7-01 / §2.3 Step 5）。**初期 PIN は作成時に 1 回だけ返る。**
// 管理者のメール招待は未実装（OPEN_QUESTIONS #101）。
api.route("/users", users);
// 標準時間マスタ（P1-02 / W-17）。
api.route("/standard-times", standardTimes);
// チェックリスト定義（P1-06 / W-16）。3 階層の継承はタスク生成時に解決する。
api.route("/checklist-templates", checklistTemplates);
// 取引先マスタ（P5-02 / PK-SPEC-P5 §2.1）。**物理削除の口が無い**（無効化のみ）。
api.route("/counterparties", counterparties);
// 料金設定（P5-03 / 同 §2.2・§3.2）。更新ではなく期間を閉じる。
api.route("/pricing-rules", pricingRules);
// 月次締め（P5-05 / 同 §2.8・§6.1）。合意と差戻しは P5-12。
api.route("/billing-periods", billingPeriodsRoute);
// P5-18。支払集計。門は payout.read / payout.write（OWNER / ORG_ADMIN のみ）。
api.route("/payouts", payoutsRoute);
// 請求書（P5-07 / 同 §4.1・§9）。**発行と送付は 1 本の口**（1 クリック）。
api.route("/invoices", invoicesRoute);
// 領収書（P5-08 / 同 §4.2・§8.2）。**印紙貼付欄を持たない**（billing.md §3）。
api.route("/receipts", receiptsRoute);
// 送付ログ（P5-10 / 同 §2.7）。**追記のみ。消す口が無い。**
api.route("/deliveries", deliveriesRoute);
// 組織ダッシュボード（P5-14 / PK-SPEC-P5 §7.1）。**稼働の数字は rollup だけ。**
// 全社ビューを持たないロールは 403（`routes/api/v1/dashboard.ts` の注記）。
api.route("/dashboard", dashboardRoute);
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
// 検査開始の排他制御（P2-03）。binding は wrangler.toml の `INSPECTION_LOCK`。
export { InspectionLock } from "./durable/InspectionLock.js";
// 照合バッチの二重起動防止（P4-05 / PK-SPEC-P4 §5.2）。粒度は施設 × 業務日。
export { ReconciliationLock } from "./durable/ReconciliationLock.js";

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
  /**
   * Queue コンシューマ（P2-10 / architecture.md §5）。
   *
   * **キューごとにハンドラを分けられない。** Workers の `queue()` は
   * 全 binding 共通の入口なので、`batch.queue`（キュー名）で振り分ける。
   * 名前は環境ごとに接尾辞が付く（`pk-evidence-export-local` など /
   * wrangler.toml）ので、**前方一致で見る。**
   *
   * コンシューマを足す task は、ここに 1 分岐と wrangler.toml の
   * `[[queues.consumers]]`（4 環境ぶん）を同時に足すこと。
   */
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    if (batch.queue.startsWith("pk-evidence-export")) {
      await handleEvidenceExportBatch(env, batch);
      return;
    }
    // 日報 PDF（P2-14 / PK-SPEC-P2 §9）。請求書・領収書（P5）も同じキュー。
    if (batch.queue.startsWith("pk-pdf-generation")) {
      await handleDailyReportBatch(env, batch);
      return;
    }
    // 消耗ベースラインの再計算（P3-09 / PK-SPEC-P3 §5）。
    if (batch.queue.startsWith("pk-baseline-learning")) {
      await handleBaselineLearningBatch(env, batch);
      return;
    }
    // 稼働照合（P4-05 / PK-SPEC-P4 §5）。**二重起動は DO が断る。**
    //
    // **このキューは 2 種類のメッセージを運ぶ。** P6-04 が受信した物理
    // シグナルの取込（`SIGNAL_INGEST`）を相乗りさせている。8 本目のキューを
    // 足すと 4 環境ぶんの Cloudflare リソース作成が要り、人手を待つ間
    // 受信口が動かせないため（docs/DECISIONS.md #140）。**`kind` で分ける。**
    if (batch.queue.startsWith("pk-reconciliation")) {
      const signalIngest = batch.messages.filter((message) =>
        isSignalIngestMessage(message.body),
      );
      const reconciliation = batch.messages.filter(
        (message) => !isSignalIngestMessage(message.body),
      );
      if (signalIngest.length > 0) {
        await handleSignalIngestBatch(env, { ...batch, messages: signalIngest });
      }
      if (reconciliation.length > 0) {
        await handleReconciliationBatch(env, { ...batch, messages: reconciliation });
      }
      return;
    }
    // 帳票の送付（P5-07 / PK-SPEC-P5 §4.1 の ⑩〜⑫）。
    //
    // **このキューは 2 種類のメッセージを運ぶ。** P8-02 の在留資格
    // アラート判定（`RESIDENCY_ALERT`）を相乗りさせている
    // （8 本目のキューを作らない / DECISIONS #140 の判断を踏襲）。
    // **`kind` で分ける**（pk-reconciliation と同じ形）。
    if (batch.queue.startsWith("pk-notification")) {
      const residencyAlerts = batch.messages.filter((message) =>
        isResidencyAlertMessage(message.body),
      );
      const rest = batch.messages.filter((message) => !isResidencyAlertMessage(message.body));
      if (residencyAlerts.length > 0) {
        await handleResidencyAlertBatch(env, { ...batch, messages: residencyAlerts });
      }
      if (rest.length > 0) {
        await handleNotificationBatch(env, { ...batch, messages: rest });
      }
      return;
    }
    // 日次集計の更新（P5-14 / PK-SPEC-P0 §19.6）。**再計算方式。**
    //
    // **このキューも 2 種類のメッセージを運ぶ。** PF-02 のテナント
    // スナップショット（`TENANT_SNAPSHOT`）を相乗りさせている
    // （DECISIONS #140 / #160 と同じ判断 — 8 本目のキューを作らない）。
    // どちらも「数え直して上書きする」再計算方式で、性質が揃っている。
    if (batch.queue.startsWith("pk-rollup-update")) {
      const snapshots = batch.messages.filter((message) =>
        isTenantSnapshotMessage(message.body),
      );
      const rest = batch.messages.filter((message) => !isTenantSnapshotMessage(message.body));
      if (snapshots.length > 0) {
        await handleTenantSnapshotBatch(env, { ...batch, messages: snapshots });
      }
      if (rest.length > 0) {
        await handleRollupUpdateBatch(env, { ...batch, messages: rest });
      }
      return;
    }
    // R2 のライフサイクル 3 種（P7-08 / P7-09 / P7-10）。**`kind` で分ける。**
    //
    // 年次アーカイブ（§19.7）は**退避であって削除ではない**（#159）。
    // 写真の保持期限（§4.5）は**本当に消える**（写しを作らない）。
    // 別のキューにしないのは、4 環境ぶんの Cloudflare リソース作成を
    // 待たずに動かすため（DECISIONS #140 / #160 と同じ判断）。
    if (batch.queue.startsWith("pk-archive-restore")) {
      const archiveExport = batch.messages.filter((message) =>
        isArchiveExportMessage(message.body),
      );
      const photoRetention = batch.messages.filter((message) =>
        isPhotoRetentionMessage(message.body),
      );
      const archiveRestore = batch.messages.filter((message) =>
        isArchiveRestoreMessage(message.body),
      );
      if (archiveExport.length > 0) {
        await handleArchiveExportBatch(env, { ...batch, messages: archiveExport });
      }
      if (photoRetention.length > 0) {
        await handlePhotoRetentionBatch(env, { ...batch, messages: photoRetention });
      }
      if (archiveRestore.length > 0) {
        await handleArchiveRestoreBatch(env, { ...batch, messages: archiveRestore });
      }
      // どれでもないメッセージは `handleArchiveExportBatch` が ack して落とす。
      if (
        archiveExport.length === 0 &&
        photoRetention.length === 0 &&
        archiveRestore.length === 0
      ) {
        await handleArchiveExportBatch(env, batch);
      }
      return;
    }
    // 知らないキュー。**ack も retry もしない**（既定の再送に任せる）。
    console.error(`queue-unhandled queue=${batch.queue}`);
  },
  /**
   * Cron Trigger（wrangler.toml の `[triggers]`）。**2 本ある。**
   *
   * `controller.cron` は発火した cron 式そのもの。**式で振り分ける。**
   * 分岐を持たずに両方を毎回走らせると、10 分ごとにタスク生成が走る。
   *
   *   `0 17 * * *`    02:00 JST      翌業務日のタスク生成（P1-03）＋
   *                                  当日の稼働照合（P4-05 / §5.1）
   *   `*&#47;10 * * * *`  10 分ごと      日締め + 10 分の施設の日報（P2-14）
   *   `0 18 * * 6`    日曜 03:00 JST ベースライン週次バッチ（P3-09）
   *   `0 22 * * *`    07:00 JST      在留資格の期限アラート（P8-02）
   *
   * **返す Promise を `await` する。** Cron の実行は `scheduled()` の返した
   * Promise が解決するまで続く。結果は件数だけをログに出す
   * （組織 ID・シャード番号を出さない / architecture.md §1）。
   */
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const now = new Date(controller.scheduledTime);

    if (controller.cron === BASELINE_LEARNING_CRON) {
      const result = await dispatchBaselineLearning(env, now);
      console.log(
        `baseline-learning-dispatch organizations=${String(result.organizations)} ` +
          `queued=${String(result.queued)} failed=${String(result.failedOrganizations)}`,
      );
      return;
    }

    // 在留資格の期限アラート（P8-02 / PK-SPEC-P8 §1.4「毎日 07:00 JST」）。
    // **fallthrough より前に置くこと。** 最後の分岐は「それ以外の cron」を
    // 02:00 の回として扱うので、ここを忘れると 07:00 にタスク生成が走る。
    if (controller.cron === RESIDENCY_ALERT_CRON) {
      const result = await dispatchResidencyAlerts(env, now);
      console.log(
        `residency-alert-dispatch organizations=${String(result.organizations)} ` +
          `queued=${String(result.queued)} failed=${String(result.failedOrganizations)}`,
      );
      return;
    }

    // 月次締め（P5-05 / PK-SPEC-P5 §6.1）。cron 式は UTC の月末を撃つので
    // **JST の 1 日かどうかをここで確かめる**（`isMonthlyCloseMoment()`）。
    if (controller.cron === MONTHLY_CLOSE_CRON) {
      if (!isMonthlyCloseMoment(now)) return;
      const result = await runMonthlyClose(env, now);
      console.log(
        `monthly-close organizations=${String(result.organizations)} ` +
          `created=${String(result.created)} aggregated=${String(result.aggregated)} ` +
          `failed=${String(result.failedOrganizations)}`,
      );

      // 年次アーカイブ（P7-08 / §19.7）。**同じ cron に相乗りしている**
      // （DECISIONS #160）。2 月 1 日の回だけ走る。
      if (isArchiveDispatchMoment(now)) {
        const archive = await dispatchArchiveExport(env, now);
        console.log(
          `archive-export-dispatch year=${String(archive.year)} ` +
            `organizations=${String(archive.organizations)} ` +
            `queued=${String(archive.queued)} failed=${String(archive.failedOrganizations)}`,
        );
      }
      return;
    }

    if (controller.cron === DAILY_REPORT_CRON) {
      const result = await dispatchDailyReports(env, now);
      console.log(
        `daily-report-dispatch organizations=${String(result.organizations)} ` +
          `queued=${String(result.queued)} failed=${String(result.failedOrganizations)}`,
      );
      return;
    }

    // 02:00 JST の回。**2 つを続けて走らせる**（DECISIONS #113）。
    // 照合（P4-05 / §5.1）は同じ時刻で、cron 式を分けられない。
    // **どちらも `await` する。** 片方を投げっぱなしにすると打ち切られる。
    const result = await runNightlyGeneration(env, now);
    console.log(
      `nightly-generation properties=${String(result.properties)} ` +
        `created=${String(result.created)} failed=${String(result.failedProperties)}`,
    );

    const reconciliation = await dispatchReconciliation(env, now);
    console.log(
      `reconciliation-dispatch organizations=${String(reconciliation.organizations)} ` +
        `queued=${String(reconciliation.queued)} ` +
        `failed=${String(reconciliation.failedOrganizations)}`,
    );

    // 写真の保持期限（P7-10 / §4.5「日次バッチ」）。**同じ cron に相乗り**
    // （DECISIONS #165）。**版数が引けない組織は投げない**（消さない側へ倒す）。
    const retention = await dispatchPhotoRetention(env, now);
    console.log(
      `photo-retention-dispatch organizations=${String(retention.organizations)} ` +
        `queued=${String(retention.queued)} ` +
        `skippedNoPlan=${String(retention.skippedNoPlan)} ` +
        `expiredRestores=${String(retention.expiredRestores)} ` +
        `failed=${String(retention.failedOrganizations)}`,
    );

    // テナントのスナップショット（PF-02 / DECISIONS #220 の 2）。**同じ cron に
    // 相乗り**（新しい cron 式を足さない）。運営画面の数字はここでしか作られない。
    const snapshots = await dispatchTenantSnapshots(env, now);
    console.log(
      `tenant-snapshot-dispatch organizations=${String(snapshots.organizations)} ` +
        `queued=${String(snapshots.queued)} ` +
        `failed=${String(snapshots.failedOrganizations)}`,
    );
  },
} satisfies ExportedHandler<Env>;
