import {
  countUnmappedExternalIds,
  listExternalMappings,
  listIntegrations,
  listRooms,
  listSyncLogs,
  reactivateIntegration,
  recordAudit,
  type IntegrationKind,
} from "@pk/db";
import { circuitStateOf } from "@pk/integrations";
import {
  Form,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { assertPermission, can, propertyTarget } from "../../lib/auth/permission.js";
import { t, type MessageKey } from "../../lib/i18n.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

/**
 * W-13 連携設定 / W-24 同期ログ（PK-SPEC-P6 §7.1 / §7.3）。
 *
 *   /app/settings/integrations
 *
 * task:  docs/tasks/P6-14.md
 * ルール: .claude/rules/security.md §1・§7
 *
 * ── この画面が答える問い ────────────────────────────────
 * §9 のリスク表「**連携が止まって気づかない → 照合の空白**」に対する
 * 「画面に最終同期時刻を常時表示する」がこの画面。§7.1 の見本どおり、
 * 種類ごとに並べて**最終同期・結果・未マッピング件数**を出す。
 *
 * ── W-24 を別画面にしない ───────────────────────────────
 * §7.3 は「同期ログ ○○PMS」という別画面として描かれているが、
 * **連携 1 件を選んだ状態の W-13 と同じ情報**になる。行を開くと
 * その連携の直近のログが下に出る形にした（`?integrationId=`）。
 * 画面を分けると「最終同期は緑なのにログは赤」を見比べるのに
 * 行き来が要る（docs/DECISIONS.md #154）。
 *
 * ── CSV 取込を「常時有効」として出す ────────────────────
 * §7.1 の見本の 1 行目。**連携が 1 件も無くても出す。** §1.2 MUST の
 * 「手動 CSV 取込を常に有効なままにしておく」を画面でも示す。
 * `integration` の行としては存在しないので、静的な行として置く。
 *
 * ── リポジトリを直接呼ぶ ────────────────────────────────
 * PC 管理画面の方針（docs/DECISIONS.md #049）。**そのため
 * `assertPermission()` を loader と action の両方で呼ぶ。**
 */

/** §7.1 の 1 行ぶん。 */
interface IntegrationRow {
  integrationId: string;
  kind: IntegrationKind;
  displayName: string;
  status: string;
  /** サーキットブレーカーが開いているか（§3.4）。 */
  circuitOpen: boolean;
  /** `null` = 組織全体。 */
  propertyId: string | null;
  lastSyncAtMs: number | null;
  lastSuccessAtMs: number | null;
  lastErrorAtMs: number | null;
  lastErrorMessage: string | null;
  consecutiveFailures: number;
  /** 対応の無い外部 ID の数（§7.1 の「未マッピング客室 N 件」）。 */
  unmappedExternalCount: number;
  /** 対応の無い客室の数。 */
  unmappedRoomCount: number;
}

/** W-24 の 1 行（§7.3）。 */
interface SyncLogRow {
  syncLogId: string;
  startedAtMs: number;
  trigger: string;
  targetDate: string | null;
  status: string;
  received: number;
  applied: number;
  skipped: number;
  failed: number;
  errorMessage: string | null;
  durationMs: number | null;
}

interface IntegrationSettingsData {
  rows: IntegrationRow[];
  /** 下に出す同期ログ。**連携を選んでいなければ空。** */
  selectedIntegrationId: string | null;
  logs: SyncLogRow[];
  canWrite: boolean;
}

/** W-24 に出す件数。 */
const SYNC_LOG_LIMIT = 20;

export async function loader({
  request,
  context,
}: LoaderFunctionArgs): Promise<IntegrationSettingsData> {
  const env = getEnv(context);
  const now = new Date();
  const { tenant } = await requireAppContext(env, request, now);

  // 連携は組織の設定。**施設を渡さない**（`integration.read` は組織スコープ）。
  assertPermission(tenant, "integration.read", propertyTarget([]));

  const integrations = await listIntegrations(env, tenant, {});

  const rows: IntegrationRow[] = [];
  for (const integration of integrations) {
    // 未マッピングの数え方は 2 方向ある（§7.1 の「未マッピング客室」と
    // 「未マッピングデバイス」）。**対応表そのものを見る**
    // （`sync_log` は直近 1 回しか映さない / `countUnmappedExternalIds()` の注記）。
    const mappings = await listExternalMappings(env, tenant, {
      integrationId: integration.id,
      entityType: "ROOM",
    });
    const rooms = await listRooms(
      env,
      tenant,
      integration.propertyId === null ? {} : { propertyId: integration.propertyId },
    );
    const mappedRoomIds = new Set(mappings.map((row) => row.internalId));
    const unmappedExternalCount = await countUnmappedExternalIds(env, tenant, {
      integrationId: integration.id,
      entityType: "ROOM",
      // 対応表に載っている外部 ID のうち、無効化されたものが落ちる。
      externalIds: mappings.map((row) => row.externalId),
    });

    rows.push({
      integrationId: integration.id,
      kind: integration.kind,
      displayName: integration.displayName,
      status: integration.status,
      circuitOpen: circuitStateOf(integration.status) === "OPEN",
      propertyId: integration.propertyId,
      lastSyncAtMs: integration.lastSyncAt?.getTime() ?? null,
      lastSuccessAtMs: integration.lastSuccessAt?.getTime() ?? null,
      lastErrorAtMs: integration.lastErrorAt?.getTime() ?? null,
      lastErrorMessage: integration.lastErrorMessage,
      consecutiveFailures: integration.consecutiveFailures,
      unmappedExternalCount,
      unmappedRoomCount: rooms.filter((room) => !mappedRoomIds.has(room.id)).length,
    });
  }

  const selected = new URL(request.url).searchParams.get("integrationId");
  const logs =
    selected === null
      ? []
      : (await listSyncLogs(env, tenant, { integrationId: selected, limit: SYNC_LOG_LIMIT })).map(
          (row) => ({
            syncLogId: row.id,
            startedAtMs: row.startedAt.getTime(),
            trigger: row.trigger,
            targetDate: row.targetDate,
            status: row.status,
            received: row.recordsReceived,
            applied: row.recordsApplied,
            skipped: row.recordsSkipped,
            failed: row.recordsFailed,
            errorMessage: row.errorMessage,
            durationMs: row.durationMs,
          }),
        );

  return {
    rows,
    selectedIntegrationId: selected,
    logs,
    canWrite: can(tenant, "integration.write", propertyTarget([])),
  };
}

interface IntegrationSettingsResult {
  reconnected?: boolean;
  rejected?: boolean;
}

/**
 * 再接続（§3.4 の「手動で再接続テストに成功したら `ACTIVE` に戻る」）。
 *
 * API（`routes/api/v1/integrations.ts`）と同じことをする。**判定と監査ログを
 * 両方に書いているので、片方だけ直さないこと**（W-20 / W-21 と同じ形 /
 * DECISIONS #099）。
 *
 * **まだ実際には接続していない**（OPEN_QUESTIONS #088）。
 */
export async function action({
  request,
  context,
}: ActionFunctionArgs): Promise<IntegrationSettingsResult> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  assertPermission(tenant, "integration.write", propertyTarget([]));

  const form = await request.formData();
  const integrationId = form.get("integrationId");
  if (typeof integrationId !== "string" || integrationId === "") return { rejected: true };

  const integrations = await listIntegrations(env, tenant, {});
  const target = integrations.find((row) => row.id === integrationId);
  if (target === undefined) return { rejected: true };
  // **`SUSPENDED` は戻さない**（利用者が明示的に止めた状態 / API と同じ）。
  if (target.status === "SUSPENDED") return { rejected: true };

  await reactivateIntegration(env, tenant, integrationId);
  await recordAudit(env, tenant, {
    actorId: session.membershipId,
    action: "integration.statusChanged",
    targetType: "integration",
    targetId: integrationId,
    ...(target.propertyId === null ? {} : { propertyId: target.propertyId }),
    before: { status: target.status, consecutiveFailures: target.consecutiveFailures },
    after: { status: "ACTIVE", consecutiveFailures: 0 },
  });

  return { reconnected: true };
}

/** 時刻の表示。**未取得と「取得したが失敗」を区別する。** */
function formatAt(value: number | null): string {
  return value === null ? "—" : new Date(value).toISOString();
}

/** §7.1 の種類ごとの見出し。**語彙は `NOTIFICATION`/`MESSAGING` まで。** */
const KIND_ORDER: readonly IntegrationKind[] = [
  "PMS",
  "SMART_LOCK",
  "SELF_CHECKIN",
  "ACCOUNTING",
  "MESSAGING",
];

const KIND_LABEL: Readonly<Record<IntegrationKind, MessageKey>> = {
  PMS: "integration.kind.PMS",
  SMART_LOCK: "integration.kind.SMART_LOCK",
  SELF_CHECKIN: "integration.kind.SELF_CHECKIN",
  ACCOUNTING: "integration.kind.ACCOUNTING",
  MESSAGING: "integration.kind.MESSAGING",
};

export default function IntegrationSettings() {
  const data = useLoaderData<IntegrationSettingsData>();
  const result = useActionData<IntegrationSettingsResult>();

  return (
    <div className="pk-page">
      <header className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("integration.title")}</h1>
      </header>

      {result?.rejected === true ? (
        <p className="pk-notice">{t("integration.rejected")}</p>
      ) : null}
      {result?.reconnected === true ? (
        <p className="pk-notice">{t("integration.reconnected")}</p>
      ) : null}

      {/*
        §7.1 の見本の 1 行目。**連携が 1 件も無くても出す。**
        §1.2 MUST「手動 CSV 取込を常に有効なままにしておく」を画面でも示す。
      */}
      <section className="pk-meter">
        <h2 className="pk-meter__label">{t("integration.kind.PMS")}</h2>
        <dl className="pk-items">
          <dt>{t("integration.csv")}</dt>
          <dd>{t("integration.csv.always")}</dd>
        </dl>
        <p className="pk-muted">{t("integration.csv.note")}</p>
      </section>

      {KIND_ORDER.map((kind) => {
        const rows = data.rows.filter((row) => row.kind === kind);
        if (rows.length === 0) return null;
        return (
          <section className="pk-meter" key={kind}>
            <h2 className="pk-meter__label">{t(KIND_LABEL[kind])}</h2>
            {rows.map((row) => (
              <article className="pk-items" key={row.integrationId}>
                <h3>{row.displayName}</h3>
                <dl className="pk-items">
                  <dt>{t("integration.status")}</dt>
                  <dd>{row.status}</dd>
                  {/* §9 の「画面に最終同期時刻を常時表示する」。 */}
                  <dt>{t("integration.lastSync")}</dt>
                  <dd>{formatAt(row.lastSyncAtMs)}</dd>
                  <dt>{t("integration.lastSuccess")}</dt>
                  <dd>{formatAt(row.lastSuccessAtMs)}</dd>
                  <dt>{t("integration.unmappedExternal")}</dt>
                  <dd>{String(row.unmappedExternalCount)}</dd>
                  <dt>{t("integration.unmappedRooms")}</dt>
                  <dd>{String(row.unmappedRoomCount)}</dd>
                </dl>

                {/*
                  §3.4 の `ERROR`。**「連携が止まっている」ことを目立たせる。**
                  ただし照合は止まっていない（§1.2）ので、そう書く。
                */}
                {row.circuitOpen ? (
                  <p className="pk-notice">
                    {`${t("integration.circuitOpen")}（${String(row.consecutiveFailures)}）`}
                  </p>
                ) : null}
                {row.circuitOpen ? (
                  <p className="pk-muted">{t("integration.circuitOpen.note")}</p>
                ) : null}

                <p className="pk-inline">
                  <a href={`/app/settings/integrations?integrationId=${row.integrationId}`}>
                    {t("integration.viewLogs")}
                  </a>
                  {" / "}
                  <a href={`/app/settings/integrations/${row.integrationId}/mappings`}>
                    {t("integration.viewMappings")}
                  </a>
                </p>

                {data.canWrite && row.circuitOpen ? (
                  <Form method="post" className="pk-inline">
                    <input type="hidden" name="integrationId" value={row.integrationId} />
                    <button className="pk-button" type="submit">
                      {t("integration.reconnect")}
                    </button>
                  </Form>
                ) : null}
              </article>
            ))}
          </section>
        );
      })}

      {data.rows.length === 0 ? <p className="pk-muted">{t("integration.none")}</p> : null}

      {/* ── W-24 同期ログ（§7.3）───────────────────────────── */}
      {data.selectedIntegrationId === null ? null : (
        <section className="pk-meter">
          <h2 className="pk-meter__label">{t("syncLog.title")}</h2>
          {data.logs.length === 0 ? (
            <p className="pk-muted">{t("syncLog.none")}</p>
          ) : (
            <table className="pk-grid">
              <thead>
                <tr>
                  <th scope="col">{t("syncLog.startedAt")}</th>
                  <th scope="col">{t("syncLog.trigger")}</th>
                  <th scope="col">{t("syncLog.targetDate")}</th>
                  <th scope="col">{t("syncLog.status")}</th>
                  <th scope="col">{t("syncLog.counts")}</th>
                </tr>
              </thead>
              <tbody>
                {data.logs.map((log) => (
                  <tr key={log.syncLogId}>
                    <td>{new Date(log.startedAtMs).toISOString()}</td>
                    <td>{log.trigger}</td>
                    <td>{log.targetDate ?? "—"}</td>
                    <td>
                      {log.status}
                      {/*
                        §7.3 の見本は失敗の理由（「タイムアウト（30秒）」）を
                        件数の下に出している。**外部の応答をそのまま出さない**
                        （個人情報が混ざりうる / `lastErrorMessage` の注記）。
                        書き込む側が内部の理由まで詰めてある。
                      */}
                      {log.errorMessage === null ? null : (
                        <>
                          <br />
                          <span className="pk-muted">{log.errorMessage}</span>
                        </>
                      )}
                    </td>
                    {/* §7.3 の「受信/適用/スキップ/失敗」。 */}
                    <td>
                      {`${String(log.received)} / ${String(log.applied)} / ${String(
                        log.skipped,
                      )} / ${String(log.failed)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="pk-muted">{t("syncLog.skippedNote")}</p>
        </section>
      )}
    </div>
  );
}
