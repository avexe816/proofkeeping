/**
 * W-09 忘れ物管理（PK-SPEC-P2 §7・§12.1）。
 *
 *   /app/p/{propertyId}/lost-found?status=&item={lostItemId}
 *
 * task:  docs/tasks/P7-22.md（OPEN_QUESTIONS #082 の残り半分）
 * ルール: .claude/rules/security.md §1・§3 / ui-writing.md §2
 *
 * ── 自動廃棄をしない（§7.3 MUST）───────────────────────
 * 期限（`retentionDueAt`）は警告バッジとして出すだけ。**期限が来ても
 * 状態は変わらず、責任者の明示操作（理由必須の廃棄）だけが進める。**
 * この画面に「期限切れを一括廃棄」の類を足さないこと。
 *
 * ── 持ち主の情報を扱わない（security.md §3）─────────────
 * 表示も入力も品物のことだけ。連絡は PMS 側で行い、ここには
 * 「連絡済みにする」ボタン（`ownerContactedAt` の記録）しか無い。
 *
 * ── 絞りと出し分けは lib（§7.4）────────────────────────
 * `CLEANER` は自分が登録した分だけ・保管場所は非表示 —
 * `listVisibleLostItems()` / `toLostItemSummary()` が行う。画面は絞らない。
 */

import type { LostItemSummary } from "@pk/contracts";
import {
  LOST_ITEM_STATUSES,
  NotFoundError,
  findLostItemById,
  listLostItemHistory,
  listRoomNumbersByIds,
  markOwnerContacted,
  type LostItemStatus,
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
import {
  changeLostItemStatus,
  listVisibleLostItems,
  toLostItemSummary,
} from "../../lib/report/lostItem.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

interface HistoryRow {
  id: string;
  fromStatus: LostItemStatus | null;
  toStatus: LostItemStatus;
  note: string | null;
  occurredAt: string;
}

interface LostItemsData {
  propertyId: string;
  status: LostItemStatus | null;
  rows: (LostItemSummary & { roomNumber: string })[];
  /** `?item=` で選んだ 1 件。担当外・他人の登録は `null` のまま。 */
  detail: (LostItemSummary & { roomNumber: string; history: HistoryRow[] }) | null;
  canManage: boolean;
}

export async function loader({
  request,
  params,
  context,
}: LoaderFunctionArgs): Promise<LostItemsData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant, cookieValue } = await requireAppContext(env, request, now);

  const propertyId = params["propertyId"];
  if (propertyId === undefined) throw new NotFoundError();
  // URL を正としてセッションを寄せる（W-03 / 証跡一覧と同じ）。
  // 到達できない施設なら `NotFoundError`（INV-31）。
  await switchProperty(env, tenant, cookieValue, propertyId, now, session.membershipId);
  assertPermission(tenant, "lostItem.read", propertyTarget([propertyId]));

  const url = new URL(request.url);
  const statusRaw = url.searchParams.get("status");
  const status = (LOST_ITEM_STATUSES as readonly string[]).includes(statusRaw ?? "")
    ? (statusRaw as LostItemStatus)
    : null;

  const items = await listVisibleLostItems(env, tenant, session.membershipId, {
    propertyId,
    ...(status === null ? {} : { status: [status] }),
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

  const itemId = url.searchParams.get("item");
  let detail: LostItemsData["detail"] = null;
  if (itemId !== null && itemId !== "") {
    const row = await findLostItemById(env, tenant, itemId);
    // 他人の登録は一覧の絞り（§7.4）と同じ理由で開かない（404 と同じ「無い」）。
    if (
      row !== undefined &&
      row.propertyId === propertyId &&
      (tenant.role !== "CLEANER" || row.foundById === session.membershipId)
    ) {
      const history = await listLostItemHistory(env, tenant, row.id);
      const summary = toLostItemSummary(tenant, row);
      detail = {
        ...summary,
        roomNumber: roomNumbers.get(summary.roomId) ?? "",
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
    rows,
    detail,
    canManage: can(tenant, "lostItem.manage", propertyTarget([propertyId])),
  };
}

type LostItemsFailure = "INVALID" | "CONFLICT" | "DISPOSAL_REASON_REQUIRED";

interface LostItemsActionResult {
  advanced?: boolean;
  contacted?: boolean;
  failure?: LostItemsFailure;
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
}: ActionFunctionArgs): Promise<LostItemsActionResult> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant, cookieValue } = await requireAppContext(env, request, now);

  const propertyId = params["propertyId"];
  if (propertyId === undefined) throw new NotFoundError();
  await switchProperty(env, tenant, cookieValue, propertyId, now, session.membershipId);
  assertPermission(tenant, "lostItem.manage", propertyTarget([propertyId]));

  const form = await request.formData();
  const intent = form.get("intent");
  const lostItemId = form.get("lostItemId");
  if (typeof lostItemId !== "string" || lostItemId === "") return { failure: "INVALID" };

  const row = await findLostItemById(env, tenant, lostItemId);
  if (row === undefined || row.propertyId !== propertyId) throw new NotFoundError();

  // 持ち主へ連絡した事実の記録（§7.4）。**本文を取らない。**
  if (intent === "contacted") {
    await markOwnerContacted(env, tenant, row.id);
    return { contacted: true };
  }

  if (intent === "status") {
    const toRaw = form.get("to");
    const to = (LOST_ITEM_STATUSES as readonly string[]).includes(
      typeof toRaw === "string" ? toRaw : "",
    )
      ? (toRaw as LostItemStatus)
      : null;
    if (to === null) return { failure: "INVALID" };

    const storageLocation = textOf(form.get("storageLocation"), 200);
    const policeReportNo = textOf(form.get("policeReportNo"), 200);
    const disposalReason = textOf(form.get("disposalReason"), 200);

    const outcome = await changeLostItemStatus(env, tenant, {
      lostItemId: row.id,
      from: row.status,
      to,
      propertyId: row.propertyId,
      actorId: session.membershipId,
      note: textOf(form.get("note"), 200),
      ...(storageLocation === null ? {} : { storageLocation }),
      ...(policeReportNo === null ? {} : { policeReportNo }),
      ...(disposalReason === null ? {} : { disposalReason }),
    });
    if (outcome.kind === "REJECTED") {
      return {
        failure:
          outcome.error === "DISPOSAL_REASON_REQUIRED" ? "DISPOSAL_REASON_REQUIRED" : "CONFLICT",
      };
    }
    return { advanced: true };
  }

  return { failure: "INVALID" };
}

const STATUS_LABEL: Record<LostItemStatus, MessageKey> = {
  FOUND: "lostItems.status.FOUND",
  STORED: "lostItems.status.STORED",
  REPORTED_TO_POLICE: "lostItems.status.REPORTED_TO_POLICE",
  RETURN_PENDING: "lostItems.status.RETURN_PENDING",
  RETURNED: "lostItems.status.RETURNED",
  DISPOSED: "lostItems.status.DISPOSED",
  TRANSFERRED: "lostItems.status.TRANSFERRED",
};

const CATEGORY_LABEL: Record<LostItemSummary["category"], MessageKey> = {
  VALUABLE: "m.report.lost.category.VALUABLE",
  ELECTRONICS: "m.report.lost.category.ELECTRONICS",
  CLOTHING: "m.report.lost.category.CLOTHING",
  BAG: "m.report.lost.category.BAG",
  MEDICINE: "m.report.lost.category.MEDICINE",
  FOOD: "m.report.lost.category.FOOD",
  DOCUMENT: "m.report.lost.category.DOCUMENT",
  OTHER: "m.report.lost.category.OTHER",
};

const FAILURE_MESSAGE: Record<LostItemsFailure, MessageKey> = {
  INVALID: "lostItems.error.invalid",
  CONFLICT: "lostItems.error.conflict",
  DISPOSAL_REASON_REQUIRED: "lostItems.error.disposalReason",
};

/** 期限バッジ。`URGENT` の赤は §7.3 が定める唯一の例外（app.css の注記）。 */
function warningBadge(level: LostItemSummary["warningLevel"]): "warn" | "urgent" | null {
  if (level === "URGENT") return "urgent";
  if (level === "ATTENTION") return "warn";
  return null;
}

/** `YYYY-MM-DD`（`Asia/Tokyo`）。期限・履歴は日付で足りる。 */
function jstDate(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

export default function LostItems() {
  const data = useLoaderData<LostItemsData>();
  const result = useActionData<LostItemsActionResult>();

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("lostItems.title")}</h1>
      </div>
      <p className="pk-muted">{t("lostItems.lede")}</p>

      {result?.failure !== undefined ? (
        <p className="pk-notice pk-notice--warn">{t(FAILURE_MESSAGE[result.failure])}</p>
      ) : null}
      {result?.advanced === true ? <p className="pk-notice">{t("lostItems.advanced")}</p> : null}
      {result?.contacted === true ? <p className="pk-notice">{t("lostItems.contacted")}</p> : null}

      <Form method="get" className="pk-filter">
        <label className="pk-field">
          <span className="pk-field__label">{t("lostItems.filter.status")}</span>
          <select className="pk-select" name="status" defaultValue={data.status ?? ""}>
            <option value="">{t("lostItems.filter.all")}</option>
            {LOST_ITEM_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(STATUS_LABEL[status])}
              </option>
            ))}
          </select>
        </label>
        <button className="pk-button" type="submit">
          {t("lostItems.filter.apply")}
        </button>
      </Form>

      <table className="pk-grid">
        <thead>
          <tr>
            <th>{t("lostItems.column.managementNo")}</th>
            <th>{t("lostItems.column.businessDate")}</th>
            <th>{t("lostItems.column.room")}</th>
            <th>{t("lostItems.column.category")}</th>
            <th>{t("lostItems.column.description")}</th>
            <th>{t("lostItems.column.status")}</th>
            <th>{t("lostItems.column.retention")}</th>
            <th>{t("lostItems.column.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => {
            const badge = warningBadge(row.warningLevel);
            return (
              <tr key={row.lostItemId}>
                <th scope="row">{row.managementNo}</th>
                <td>{row.businessDate}</td>
                <td>{row.roomNumber}</td>
                <td>{t(CATEGORY_LABEL[row.category])}</td>
                <td>{row.description}</td>
                <td>{t(STATUS_LABEL[row.status])}</td>
                <td>
                  {row.retentionDueAtMs === null ? "—" : jstDate(row.retentionDueAtMs)}
                  {badge === null ? null : (
                    <span className={`pk-badge pk-badge--${badge}`}>
                      {badge === "urgent"
                        ? t("lostItems.warning.urgent")
                        : t("lostItems.warning.attention")}
                    </span>
                  )}
                </td>
                <td>
                  <a
                    className="pk-button"
                    href={`?${data.status === null ? "" : `status=${data.status}&`}item=${row.lostItemId}`}
                  >
                    {t("lostItems.action.open")}
                  </a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {data.rows.length === 0 ? <p className="pk-muted">{t("lostItems.empty")}</p> : null}

      {data.detail === null ? null : (
        <>
          <h2 className="pk-section__title">
            {`${t("lostItems.detail.title")} — ${data.detail.managementNo}`}
          </h2>
          <dl className="pk-items">
            <dt>{t("lostItems.column.status")}</dt>
            <dd>{t(STATUS_LABEL[data.detail.status])}</dd>
            <dt>{t("lostItems.detail.foundLocation")}</dt>
            <dd>{data.detail.foundLocation}</dd>
            {/* 保管場所。**`CLEANER` には lib が `null` を返す**（§7.4）。 */}
            {data.detail.storageLocation === null ? null : (
              <>
                <dt>{t("lostItems.detail.storageLocation")}</dt>
                <dd>{data.detail.storageLocation}</dd>
              </>
            )}
            {data.detail.policeReportNo === null ? null : (
              <>
                <dt>{t("lostItems.detail.policeReportNo")}</dt>
                <dd>{data.detail.policeReportNo}</dd>
              </>
            )}
            <dt>{t("lostItems.detail.ownerContacted")}</dt>
            <dd>
              {data.detail.ownerContactedAtMs === null
                ? t("lostItems.detail.ownerNotContacted")
                : jstDate(data.detail.ownerContactedAtMs)}
            </dd>
          </dl>

          {data.canManage ? (
            <>
              <Form method="post" className="pk-inlineform">
                <input type="hidden" name="intent" value="contacted" />
                <input type="hidden" name="lostItemId" value={data.detail.lostItemId} />
                <button className="pk-button" type="submit">
                  {t("lostItems.action.contacted")}
                </button>
              </Form>
              <p className="pk-muted">{t("lostItems.contactedNote")}</p>

              <Form method="post" className="pk-filter">
                <input type="hidden" name="intent" value="status" />
                <input type="hidden" name="lostItemId" value={data.detail.lostItemId} />
                <label className="pk-field">
                  <span className="pk-field__label">{t("lostItems.advance.to")}</span>
                  <select className="pk-select" name="to">
                    {LOST_ITEM_STATUSES.filter((status) => status !== data.detail?.status).map(
                      (status) => (
                        <option key={status} value={status}>
                          {t(STATUS_LABEL[status])}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                <label className="pk-field">
                  <span className="pk-field__label">{t("lostItems.advance.note")}</span>
                  <input className="pk-input" name="note" maxLength={200} />
                </label>
                <label className="pk-field">
                  <span className="pk-field__label">{t("lostItems.advance.storageLocation")}</span>
                  <input className="pk-input" name="storageLocation" maxLength={200} />
                </label>
                <label className="pk-field">
                  <span className="pk-field__label">{t("lostItems.advance.policeReportNo")}</span>
                  <input className="pk-input" name="policeReportNo" maxLength={200} />
                </label>
                <label className="pk-field">
                  <span className="pk-field__label">{t("lostItems.advance.disposalReason")}</span>
                  <input className="pk-input" name="disposalReason" maxLength={200} />
                </label>
                <button className="pk-button" type="submit">
                  {t("lostItems.advance.submit")}
                </button>
              </Form>
              {/* §7.3 MUST。期限は警告のみで、廃棄は理由必須の明示操作。 */}
              <p className="pk-muted">{t("lostItems.advance.disposalNote")}</p>
            </>
          ) : null}

          <h2 className="pk-section__title">{t("lostItems.history.title")}</h2>
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
