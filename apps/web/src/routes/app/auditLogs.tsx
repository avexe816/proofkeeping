/**
 * 監査ログの閲覧（読み取り専用）。
 *
 *   /app/audit/logs
 *
 * task:  docs/tasks/P7-20.md
 * 参照:  ui-prototypes/ops/pkops-C-materials-billing-config.html（12 の閲覧側）
 * ルール: .claude/rules/security.md §1・§6
 *
 * ── できるだけ簡素に（人間の指示 2026-08-16）─────────────
 * 絞り込みは**施設と期間の 2 つだけ**、表は**4 列だけ。**
 * 実行者・対象での絞り込みは付けない（個人単位のビューを作らない、
 * という制約とも整合する）。
 *
 * ── 門は `finding.read` ─────────────────────────────────
 * 監査領域（`/app/audit/*`）の既存の境界と同じ。`CLEANER` / `INSPECTOR` は
 * 404、`AUDITOR` は読める、施設スコープは担当施設のみ。**新しい権限区分を
 * 作らない**（増やすほど分かりにくくなる）。
 *
 * ── 書き込みの口が無い ──────────────────────────────────
 * この画面に `Form method="post"` も action も無い。読むだけ。
 */

import { useLoaderData, Form, type LoaderFunctionArgs } from "react-router";

import { listAuditLogsForViewer } from "@pk/db";

import { t } from "../../lib/i18n.js";
import { formatClock } from "../../lib/mobile/format.js";
import { resolveListScope } from "../../lib/property/listScope.js";
import { listSelectableProperties, resolveSelectedScope } from "../../lib/property/selection.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

/** 既定の期間（日）。「最近なにが起きたか」を開いた瞬間に見せる。 */
const DEFAULT_RANGE_DAYS = 7;

interface AuditLogRow {
  id: string;
  at: number;
  date: string;
  /** DB の action 列は素の text（記録時に語彙を検証済み）。表示にはそのまま使う。 */
  action: string;
  targetType: string;
  targetId: string | null;
  propertyName: string | null;
}

interface AuditLogsData {
  from: string;
  to: string;
  rows: AuditLogRow[];
}

/** `YYYY-MM-DD` へ。**表示のための日付**で、業務日ではない。 */
function dayOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<AuditLogsData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  const url = new URL(request.url);

  // 施設はヘッダーの施設セレクタが唯一の入口（DECISIONS #204）。
  // **これが唯一の門**（検査キュー・進捗モニタと同じ形）。
  const properties = await listSelectableProperties(env, tenant);
  const { property } = resolveSelectedScope(session.selectedPropertyId, tenant, properties);
  const scope = resolveListScope(tenant, "auditLog.read", property?.id ?? null);

  const to = url.searchParams.get("to") ?? dayOf(now);
  const from =
    url.searchParams.get("from") ??
    dayOf(new Date(now.getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000));

  const logs = await listAuditLogsForViewer(env, tenant, {
    propertyIds: scope.propertyIds,
    from: new Date(`${from}T00:00:00Z`),
    to: new Date(`${to}T23:59:59Z`),
  });

  const nameOf = new Map(properties.map((property) => [property.id, property.name]));

  return {
    from,
    to,
    rows: logs.map((log) => ({
      id: log.id,
      at: log.at.getTime(),
      date: dayOf(log.at),
      action: log.action,
      targetType: log.targetType,
      targetId: log.targetId,
      propertyName: log.propertyId === null ? null : (nameOf.get(log.propertyId) ?? null),
    })),
  };
}

export default function AuditLogs() {
  const data = useLoaderData<AuditLogsData>();

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("auditLogs.title")}</h1>
        <Form method="get" className="pk-pagehead__actions">
          <label className="pk-field">
            <span className="pk-field__label">{t("auditLogs.filter.from")}</span>
            <input className="pk-input" type="date" name="from" defaultValue={data.from} />
          </label>
          <label className="pk-field">
            <span className="pk-field__label">{t("auditLogs.filter.to")}</span>
            <input className="pk-input" type="date" name="to" defaultValue={data.to} />
          </label>
          <button className="pk-button pk-button--primary" type="submit">
            {t("auditLogs.filter.apply")}
          </button>
        </Form>
      </div>

      {/* プロトタイプ owner 12「📜 操作の履歴」。 */}
      <section className="pk-panel">
        <div className="pk-panel__head">
          <span className="pk-panel__icon" aria-hidden="true">
            📜
          </span>
          {t("auditLogs.card")}
          <span className="pk-panel__note">{`${data.from} 〜 ${data.to}`}</span>
        </div>
        {data.rows.length === 0 ? (
          <div className="pk-panel__body">
            <p className="pk-muted">{t("auditLogs.empty")}</p>
          </div>
        ) : (
          <div className="pk-panel__body pk-panel__body--flush pk-scroll-x">
            <table className="pk-tbl">
              <thead>
                <tr>
                  <th>{t("auditLogs.column.at")}</th>
                  <th>{t("auditLogs.column.action")}</th>
                  <th>{t("auditLogs.column.target")}</th>
                  <th>{t("auditLogs.column.property")}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.id}>
                    <td>{`${row.date} ${formatClock(row.at)}`}</td>
                    <td>
                      <code>{row.action}</code>
                    </td>
                    <td>{`${row.targetType} ${row.targetId?.split("_").pop() ?? ""}`}</td>
                    <td>{row.propertyName ?? t("auditLogs.orgWide")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {/* **閲覧のみで、追記も削除もできない**（INV-30 / 逐語）。 */}
        <div className="pk-panel__foot">{t("auditLogs.intro")}</div>
      </section>
    </section>
  );
}
