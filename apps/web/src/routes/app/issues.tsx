/**
 * W-10 不具合管理（PK-SPEC-P2 §8・§12.1）。
 *
 *   /app/p/{propertyId}/issues?status=&severity=&issue={issueId}
 *
 * task:  docs/tasks/P7-22.md（OPEN_QUESTIONS #082 の残り半分）
 * ルール: .claude/rules/security.md §1 / ui-writing.md §2
 *
 * ── 客室に触らない（§8.3）──────────────────────────────
 * 解決しても客室は止まったまま。戻すのは客室ボード側の明示操作で、
 * この画面に「客室を戻す」を足さないこと。`roomBlocked` は
 * 「この報告が客室を止めたか」の事実表示（いま止まっているかではない）。
 *
 * ── 解決には内容が要る（DECISIONS #081）─────────────────
 * `RESOLVED` へ進めるとき `resolutionNote` が無ければ
 * `RESOLUTION_NOTE_REQUIRED`。判定は `changeIssueStatus()`（API と同じ）。
 *
 * ── `CLEANER` は自分の報告だけ（§8）────────────────────
 * 絞りは `listVisibleIssues()`。画面は絞らない。
 */

import type { IssueReportSummary } from "@pk/contracts";
import {
  ISSUE_SEVERITIES,
  ISSUE_STATUSES,
  NotFoundError,
  findIssueReportById,
  listIssueHistory,
  listRoomNumbersByIds,
  type IssueSeverity,
  type IssueStatus,
} from "@pk/db";
import {
  Form,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { assertPermission, can, propertyTarget } from "../../lib/auth/permission.js";
import { t, type MessageKey } from "../../lib/i18n.js";
import { switchProperty } from "../../lib/property/selection.js";
import { changeIssueStatus, listVisibleIssues, toIssueSummary } from "../../lib/report/issue.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

interface HistoryRow {
  id: string;
  fromStatus: IssueStatus | null;
  toStatus: IssueStatus;
  note: string | null;
  occurredAt: string;
}

interface IssuesData {
  propertyId: string;
  status: IssueStatus | null;
  severity: IssueSeverity | null;
  rows: (IssueReportSummary & { roomNumber: string })[];
  detail: (IssueReportSummary & { roomNumber: string; history: HistoryRow[] }) | null;
  canManage: boolean;
}

export async function loader({
  request,
  params,
  context,
}: LoaderFunctionArgs): Promise<IssuesData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant, cookieValue } = await requireAppContext(env, request, now);

  const propertyId = params["propertyId"];
  if (propertyId === undefined) throw new NotFoundError();
  // URL を正としてセッションを寄せる（W-09 / 証跡一覧と同じ）。
  await switchProperty(env, tenant, cookieValue, propertyId, now, session.membershipId);
  assertPermission(tenant, "issue.read", propertyTarget([propertyId]));

  const url = new URL(request.url);
  const statusRaw = url.searchParams.get("status");
  const status = (ISSUE_STATUSES as readonly string[]).includes(statusRaw ?? "")
    ? (statusRaw as IssueStatus)
    : null;
  const severityRaw = url.searchParams.get("severity");
  const severity = (ISSUE_SEVERITIES as readonly string[]).includes(severityRaw ?? "")
    ? (severityRaw as IssueSeverity)
    : null;

  const items = await listVisibleIssues(env, tenant, session.membershipId, {
    propertyId,
    ...(status === null ? {} : { status: [status] }),
    ...(severity === null ? {} : { severity: [severity] }),
  });
  const roomNumbers = await listRoomNumbersByIds(
    env,
    tenant,
    items.map((item) => item.roomId),
  );
  const rows = items.map((item) => ({
    ...item,
    roomNumber: roomNumbers.get(item.roomId) ?? "",
  }));

  const issueId = url.searchParams.get("issue");
  let detail: IssuesData["detail"] = null;
  if (issueId !== null && issueId !== "") {
    const row = await findIssueReportById(env, tenant, issueId);
    // 他人の報告は一覧の絞り（§8）と同じ理由で開かない。
    if (
      row !== undefined &&
      row.propertyId === propertyId &&
      (tenant.role !== "CLEANER" || row.reportedById === session.membershipId)
    ) {
      const history = await listIssueHistory(env, tenant, row.id);
      detail = {
        ...toIssueSummary(row),
        roomNumber: roomNumbers.get(row.roomId) ?? "",
        history: history.map((entry) => ({
          id: entry.id,
          fromStatus: entry.fromStatus,
          toStatus: entry.toStatus,
          note: entry.note,
          occurredAt: entry.occurredAt.toISOString(),
        })),
      };
    }
  }

  return {
    propertyId,
    status,
    severity,
    rows,
    detail,
    canManage: can(tenant, "issue.manage", propertyTarget([propertyId])),
  };
}

type IssuesFailure = "INVALID" | "CONFLICT" | "RESOLUTION_NOTE_REQUIRED";

interface IssuesActionResult {
  advanced?: boolean;
  failure?: IssuesFailure;
}

function textOf(value: FormDataEntryValue | null, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" || trimmed.length > maxLength ? null : trimmed;
}

export async function action({
  request,
  params,
  context,
}: ActionFunctionArgs): Promise<IssuesActionResult> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant, cookieValue } = await requireAppContext(env, request, now);

  const propertyId = params["propertyId"];
  if (propertyId === undefined) throw new NotFoundError();
  await switchProperty(env, tenant, cookieValue, propertyId, now, session.membershipId);
  assertPermission(tenant, "issue.manage", propertyTarget([propertyId]));

  const form = await request.formData();
  const issueId = form.get("issueId");
  if (typeof issueId !== "string" || issueId === "") return { failure: "INVALID" };

  const row = await findIssueReportById(env, tenant, issueId);
  if (row === undefined || row.propertyId !== propertyId) throw new NotFoundError();

  const toRaw = form.get("to");
  const to = (ISSUE_STATUSES as readonly string[]).includes(typeof toRaw === "string" ? toRaw : "")
    ? (toRaw as IssueStatus)
    : null;
  if (to === null) return { failure: "INVALID" };

  const resolutionNote = textOf(form.get("resolutionNote"), 500);
  const outcome = await changeIssueStatus(env, tenant, {
    issueId: row.id,
    from: row.status,
    to,
    actorId: session.membershipId,
    note: textOf(form.get("note"), 200),
    ...(resolutionNote === null ? {} : { resolutionNote }),
  });
  if (outcome.kind === "REJECTED") {
    return {
      failure:
        outcome.error === "RESOLUTION_NOTE_REQUIRED" ? "RESOLUTION_NOTE_REQUIRED" : "CONFLICT",
    };
  }
  // `NOOP`（同じ状態への再送）も成功として返す（冪等 / testing.md §4）。
  return { advanced: true };
}

const STATUS_LABEL: Record<IssueStatus, MessageKey> = {
  OPEN: "issues.status.OPEN",
  ACKNOWLEDGED: "issues.status.ACKNOWLEDGED",
  IN_PROGRESS: "issues.status.IN_PROGRESS",
  RESOLVED: "issues.status.RESOLVED",
  CLOSED: "issues.status.CLOSED",
  WONT_FIX: "issues.status.WONT_FIX",
};

const SEVERITY_LABEL: Record<IssueSeverity, MessageKey> = {
  LOW: "m.report.issue.severity.LOW",
  MEDIUM: "m.report.issue.severity.MEDIUM",
  HIGH: "m.report.issue.severity.HIGH",
  CRITICAL: "m.report.issue.severity.CRITICAL",
};

const CATEGORY_LABEL: Record<IssueReportSummary["category"], MessageKey> = {
  CLEANING: "m.report.issue.category.CLEANING",
  PLUMBING: "m.report.issue.category.PLUMBING",
  ELECTRICAL: "m.report.issue.category.ELECTRICAL",
  HVAC: "m.report.issue.category.HVAC",
  FURNITURE: "m.report.issue.category.FURNITURE",
  AMENITY: "m.report.issue.category.AMENITY",
  SAFETY: "m.report.issue.category.SAFETY",
  OTHER: "m.report.issue.category.OTHER",
};

const FAILURE_MESSAGE: Record<IssuesFailure, MessageKey> = {
  INVALID: "issues.error.invalid",
  CONFLICT: "issues.error.conflict",
  RESOLUTION_NOTE_REQUIRED: "issues.error.resolutionNote",
};

/** `YYYY-MM-DD`（`Asia/Tokyo`）。 */
function jstDate(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

export default function Issues() {
  const data = useLoaderData<IssuesData>();
  const result = useActionData<IssuesActionResult>();

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("issues.title")}</h1>
        <Form method="get" className="pk-pagehead__actions">
          <label className="pk-field">
            <span className="pk-field__label">{t("issues.filter.status")}</span>
            <select className="pk-select" name="status" defaultValue={data.status ?? ""}>
              <option value="">{t("issues.filter.all")}</option>
              {ISSUE_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(STATUS_LABEL[status])}
                </option>
              ))}
            </select>
          </label>
          <label className="pk-field">
            <span className="pk-field__label">{t("issues.filter.severity")}</span>
            <select className="pk-select" name="severity" defaultValue={data.severity ?? ""}>
              <option value="">{t("issues.filter.all")}</option>
              {ISSUE_SEVERITIES.map((severity) => (
                <option key={severity} value={severity}>
                  {t(SEVERITY_LABEL[severity])}
                </option>
              ))}
            </select>
          </label>
          <button className="pk-button pk-button--primary" type="submit">
            {t("issues.filter.apply")}
          </button>
        </Form>
      </div>
      <p className="pk-muted">{t("issues.lede")}</p>

      {result?.failure !== undefined ? (
        <p className="pk-notice pk-notice--warn">{t(FAILURE_MESSAGE[result.failure])}</p>
      ) : null}
      {result?.advanced === true ? <p className="pk-notice">{t("issues.advanced")}</p> : null}

      <table className="pk-grid">
        <thead>
          <tr>
            <th>{t("issues.column.reportedAt")}</th>
            <th>{t("issues.column.room")}</th>
            <th>{t("issues.column.category")}</th>
            <th>{t("issues.column.severity")}</th>
            <th>{t("issues.column.title")}</th>
            <th>{t("issues.column.status")}</th>
            <th>{t("issues.column.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <tr key={row.issueId}>
              <th scope="row">{jstDate(row.reportedAtMs)}</th>
              <td>{row.roomNumber}</td>
              <td>{t(CATEGORY_LABEL[row.category])}</td>
              <td>
                {t(SEVERITY_LABEL[row.severity])}
                {/* この報告が客室を止めた事実（§8.2）。いまの客室状態ではない。 */}
                {row.roomBlocked ? (
                  <span className="pk-badge pk-badge--warn">{t("issues.badge.roomBlocked")}</span>
                ) : null}
              </td>
              <td>{row.title}</td>
              <td>{t(STATUS_LABEL[row.status])}</td>
              <td>
                <a className="pk-button" href={`?issue=${row.issueId}`}>
                  {t("issues.action.open")}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.rows.length === 0 ? <p className="pk-muted">{t("issues.empty")}</p> : null}

      {data.detail === null ? null : (
        <>
          <h2 className="pk-section__title">{`${t("issues.detail.title")} — ${data.detail.title}`}</h2>
          <dl className="pk-items">
            <dt>{t("issues.column.status")}</dt>
            <dd>{t(STATUS_LABEL[data.detail.status])}</dd>
            <dt>{t("issues.detail.description")}</dt>
            <dd>{data.detail.description}</dd>
            {data.detail.resolutionNote === null ? null : (
              <>
                <dt>{t("issues.detail.resolutionNote")}</dt>
                <dd>{data.detail.resolutionNote}</dd>
              </>
            )}
          </dl>

          {data.canManage ? (
            <Form method="post" className="pk-filter">
              <input type="hidden" name="issueId" value={data.detail.issueId} />
              <label className="pk-field">
                <span className="pk-field__label">{t("issues.advance.to")}</span>
                <select className="pk-select" name="to">
                  {ISSUE_STATUSES.filter((status) => status !== data.detail?.status).map(
                    (status) => (
                      <option key={status} value={status}>
                        {t(STATUS_LABEL[status])}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <label className="pk-field">
                <span className="pk-field__label">{t("issues.advance.note")}</span>
                <input className="pk-input" name="note" maxLength={200} />
              </label>
              <label className="pk-field">
                <span className="pk-field__label">{t("issues.advance.resolutionNote")}</span>
                <input className="pk-input" name="resolutionNote" maxLength={500} />
              </label>
              <button className="pk-button" type="submit">
                {t("issues.advance.submit")}
              </button>
            </Form>
          ) : null}
          {/* §8.3。解決しても客室は戻らない。戻すのは客室ボードの明示操作。 */}
          <p className="pk-muted">{t("issues.roomNote")}</p>

          <h2 className="pk-section__title">{t("issues.history.title")}</h2>
          <ul className="pk-timeline">
            {data.detail.history.map((entry) => (
              <li className="pk-timeline__item" key={entry.id}>
                <span className="pk-timeline__time">{entry.occurredAt.slice(0, 10)}</span>
                <span>
                  {entry.fromStatus === null
                    ? t(STATUS_LABEL[entry.toStatus])
                    : `${t(STATUS_LABEL[entry.fromStatus])} → ${t(STATUS_LABEL[entry.toStatus])}`}
                </span>
                {entry.note === null ? null : <span className="pk-muted">{entry.note}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
