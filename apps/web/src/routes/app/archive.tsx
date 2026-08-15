import {
  createArchiveRestore,
  isRestoreViewable,
  listArchiveRestoreRows,
  listArchiveRestores,
  recordAudit,
  ARCHIVE_RESTORE_MAX_MONTHS,
  ARCHIVE_RESTORE_RETENTION_DAYS,
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
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

import type { ArchiveRestoreMessage } from "../../consumers/archiveRestore.js";

/**
 * アーカイブ閲覧（PK-SPEC-P7 §9 / P7-09）。
 *
 *   /app/archive
 *
 * task: docs/tasks/P7-09.md
 *
 * ── この画面がいちばん先に伝えること（§9 MUST）───────────
 * 「**アーカイブは削除ではなく退避であることを UI で明示する。
 * 『データは保管されています。閲覧には復元が必要です』と表示する。**」
 *
 * 見出しのすぐ下に出す。**畳まない・小さくしない・条件で隠さない。**
 * 復元が 1 件も無いときこそ読まれる文なので、一覧が空でも出す。
 *
 * ── 「削除」と書かない ──────────────────────────────────
 * 期限切れは「削除されました」ではなく「**閲覧できる期間が終わりました**」。
 * 消えたのは復元した写しで、退避そのものは残っている。もう一度復元できる。
 * 文言は `locales/ja.json` の `archive.*`。**JSX に直書きしない**
 * （ui-writing.md §1）。
 *
 * ── 展開そのものは Queue の中 ───────────────────────────
 * この画面の action は起票してキューへ投げるだけ。R2 の読み取りと
 * gunzip は `consumers/archiveRestore.ts`（architecture.md §5）。
 */

interface RestoreView {
  id: string;
  fromBusinessDate: string;
  toBusinessDate: string;
  status: string;
  rowCount: number;
  tableCount: number;
  expiresAtMs: number | null;
  errorCode: string | null;
  viewable: boolean;
}

interface LoaderData {
  restores: RestoreView[];
  /** 選んだ復元の中身（`?restoreId=`）。 */
  rows: { id: string; tableName: string; businessDate: string; payload: string }[];
  selectedId: string | null;
  canRestore: boolean;
  maxMonths: number;
  retentionDays: number;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const now = new Date();
  const { tenant: ctx } = await requireAppContext(env, request, now);
  // **`CLEANER` / `INSPECTOR` はここへ到達しない**（404 / security.md §1）。
  assertPermission(ctx, "archive.read", propertyTarget([]));

  const restores = await listArchiveRestores(env, ctx);
  const selectedId = new URL(request.url).searchParams.get("restoreId");

  const selected = restores.find((row) => row.id === selectedId);
  const rows =
    selected !== undefined &&
    selected.status === "READY" &&
    isRestoreViewable(selected.expiresAt, ctx.now)
      ? await listArchiveRestoreRows(env, ctx, { restoreId: selected.id, limit: 200 })
      : [];

  return {
    restores: restores.map((row) => ({
      id: row.id,
      fromBusinessDate: row.fromBusinessDate,
      toBusinessDate: row.toBusinessDate,
      status: row.status,
      rowCount: row.rowCount,
      tableCount: row.tableCount,
      expiresAtMs: row.expiresAt?.getTime() ?? null,
      errorCode: row.errorCode,
      viewable: row.status === "READY" && isRestoreViewable(row.expiresAt, ctx.now),
    })),
    rows: rows.map((row) => ({
      id: row.id,
      tableName: row.tableName,
      businessDate: row.businessDate,
      payload: row.payload,
    })),
    selectedId,
    canRestore: can(ctx, "archive.restore", propertyTarget([])),
    maxMonths: ARCHIVE_RESTORE_MAX_MONTHS,
    retentionDays: ARCHIVE_RESTORE_RETENTION_DAYS,
  } satisfies LoaderData;
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant: ctx } = await requireAppContext(env, request, now);
  assertPermission(ctx, "archive.restore", propertyTarget([]));

  const form = await request.formData();
  // `FormData.get()` は `File` を返しうる。**文字列だけを受ける。**
  const readField = (name: string): string => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  const from = readField("fromBusinessDate");
  const to = readField("toBusinessDate");

  const outcome = await createArchiveRestore(env, ctx, {
    requestedById: session.membershipId,
    propertyId: null,
    fromBusinessDate: from,
    toBusinessDate: to,
  });
  if (outcome.kind === "REJECTED") return { error: outcome.reason };

  const message: ArchiveRestoreMessage = {
    kind: "ARCHIVE_RESTORE",
    orgShortId: ctx.orgShortId,
    restoreId: outcome.id,
    requestedAtMs: ctx.now.getTime(),
  };
  await env.QUEUE_ARCHIVE_RESTORE.send(message);

  // **13 か月以上前の記録を読む操作**（security.md §6）。
  await recordAudit(env, ctx, {
    actorId: session.membershipId,
    action: "export.data",
    targetType: "archiveRestore",
    targetId: outcome.id,
    after: { fromBusinessDate: from, toBusinessDate: to },
  });

  return { requested: true };
}

/** 状態 → i18n キー。**「削除」と書かない。** */
function statusKey(status: string): MessageKey {
  switch (status) {
    case "PENDING":
      return "archive.status.PENDING";
    case "RUNNING":
      return "archive.status.RUNNING";
    case "READY":
      return "archive.status.READY";
    case "EXPIRED":
      return "archive.status.EXPIRED";
    default:
      return "archive.status.FAILED";
  }
}

export default function ArchivePage() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();

  return (
    <main className="pk-page">
      <h1>{t("archive.title")}</h1>

      {/*
        §9 MUST。**この 2 文を必ず出す。** 条件で隠さない。
        退避は削除ではないことを、いちばん先に読ませる。
      */}
      <p className="pk-archive__notice">{t("archive.notice.retained")}</p>
      <p className="pk-archive__notice">{t("archive.notice.restoreRequired")}</p>

      {data.canRestore ? (
        <section>
          <h2>{t("archive.restore.heading")}</h2>
          <p>{t("archive.restore.limits")}</p>
          <Form method="post">
            <label>
              {t("archive.restore.from")}
              <input type="date" name="fromBusinessDate" required />
            </label>
            <label>
              {t("archive.restore.to")}
              <input type="date" name="toBusinessDate" required />
            </label>
            <button type="submit">{t("archive.restore.submit")}</button>
          </Form>
          {result !== undefined && "error" in result ? (
            <p role="alert">{t(`archive.error.${result.error}` as MessageKey)}</p>
          ) : null}
          {result !== undefined && "requested" in result ? (
            <p>{t("archive.restore.accepted")}</p>
          ) : null}
        </section>
      ) : null}

      <section>
        <h2>{t("archive.list.heading")}</h2>
        {data.restores.length === 0 ? (
          <p>{t("archive.list.empty")}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("archive.list.range")}</th>
                <th>{t("archive.list.status")}</th>
                <th>{t("archive.list.rows")}</th>
                <th>{t("archive.list.expiresAt")}</th>
              </tr>
            </thead>
            <tbody>
              {data.restores.map((restore) => (
                <tr key={restore.id}>
                  <td>
                    {restore.viewable ? (
                      <a href={`/app/archive?restoreId=${restore.id}`}>
                        {`${restore.fromBusinessDate} 〜 ${restore.toBusinessDate}`}
                      </a>
                    ) : (
                      `${restore.fromBusinessDate} 〜 ${restore.toBusinessDate}`
                    )}
                  </td>
                  <td>{t(statusKey(restore.status))}</td>
                  <td>{restore.rowCount}</td>
                  <td>
                    {restore.expiresAtMs === null
                      ? "—"
                      : new Date(restore.expiresAtMs).toISOString().slice(0, 10)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {data.selectedId !== null ? (
        <section>
          <h2>{t("archive.rows.heading")}</h2>
          {data.rows.length === 0 ? (
            <p>{t("archive.rows.unavailable")}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t("archive.rows.table")}</th>
                  <th>{t("archive.rows.businessDate")}</th>
                  <th>{t("archive.rows.payload")}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.tableName}</td>
                    <td>{row.businessDate}</td>
                    <td>
                      <code>{row.payload}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : null}
    </main>
  );
}
