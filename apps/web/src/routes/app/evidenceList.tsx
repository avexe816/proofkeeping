/**
 * W-06 清掃記録（PK-SPEC-P2 §12.1 / プロトタイプ owner 06）。
 *
 *   /app/p/{propertyId}/evidence?days=7|30
 *
 * task:  docs/tasks/P2-09.md（2026-08-19 プロトタイプ準拠へ拡張 / 人間の指示）
 * 参照:  ui-prototypes/owner/pkown-v3-B-findings-records.html（06 清掃記録）
 * ルール: .claude/rules/ui-writing.md §2 / security.md §1・§5
 *
 * ── 期間のタスク記録として出す ──────────────────────────
 * 元の実装は 1 業務日の証跡チェーン一覧だった。プロトタイプの 06 は
 * 「期間の清掃記録」（KPI・実作業時間の分布・一覧）で、チェーンの検証は
 * 各行の「記録」から入る詳細（`/evidence/:taskId`）が引き続き持つ。
 *
 * ── KPI で最も重要なのは記録の完備率 ────────────────────
 * プロトタイプの注記。100% を求めない（必須化すると適当な値が入り、
 * 無記録より有害）。目安時間の超過を問題として示さない（INV-05）。
 *
 * ── 差異の列は `finding.read` を持つ相手だけ ─────────────
 * この画面は `task.read` で開ける。差異へ到達できないロールには
 * 列ごと出さない（security.md §1。存在も示唆しない）。
 *
 * ── 並べ替え・ランキングを付けない ──────────────────────
 * 担当者ごとの件数で並べ替える口を作らない（§1.3 / INV-07）。
 * 担当者の氏名はこの画面に出さない。
 */

import {
  NotFoundError,
  countPhotosByTask,
  listFindings,
  listObservations,
  listRoomNumbersByIds,
  listTasks,
} from "@pk/db";
import { medianMinutes } from "@pk/engine";
import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";

import { can, propertyTarget } from "../../lib/auth/permission.js";
import { businessDateOf, shiftBusinessDate } from "../../lib/businessDate.js";
import { t, type MessageKey } from "../../lib/i18n.js";
import { formatClock } from "../../lib/mobile/format.js";
import { switchProperty } from "../../lib/property/selection.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

/** 期間の選択肢（プロトタイプのセレクタ）。 */
const PERIOD_DAYS = [7, 30] as const;

/** 実作業時間の分布の区切り（プロトタイプの 8 区分・分）。 */
const HISTOGRAM_BUCKETS = [
  { key: "b25", max: 25 },
  { key: "b30", max: 30 },
  { key: "b35", max: 35 },
  { key: "b40", max: 40 },
  { key: "b45", max: 45 },
  { key: "b50", max: 50 },
  { key: "b60", max: 60 },
  { key: "over", max: Number.POSITIVE_INFINITY },
] as const;

interface RecordRow {
  taskId: string;
  roomNumber: string;
  businessDate: string;
  taskType: string;
  startClock: string | null;
  endClock: string | null;
  actualMinutes: number | null;
  photoCount: number;
  inspection: "PASS" | "FAIL" | "NONE";
  /** 同じ客室・業務日の差異。`finding.read` が無い相手には常に `null`。 */
  finding: { id: string; confidence: number } | null;
}

interface EvidenceListData {
  propertyId: string;
  from: string;
  to: string;
  days: number;
  completedCount: number;
  perDayAverage: string;
  /** 記録の完備率（千分率）。母数 0 は `null`。 */
  recordRatePermille: number | null;
  observedCount: number;
  photoTotal: number;
  photoAverage: string;
  medianActualMinutes: number | null;
  histogram: { key: string; count: number }[];
  overMedianNote: boolean;
  rows: RecordRow[];
  canReadFindings: boolean;
}

export async function loader({
  request,
  params,
  context,
}: LoaderFunctionArgs): Promise<EvidenceListData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant, cookieValue } = await requireAppContext(env, request, now);

  const propertyId = params["propertyId"];
  if (propertyId === undefined) throw new NotFoundError();

  // URL を正としてセッションを寄せる（PK-SPEC-P0 §23.5 / W-03 と同じ）。
  // 到達できない施設なら `NotFoundError`（INV-31）。
  await switchProperty(env, tenant, cookieValue, propertyId, now, session.membershipId);

  const daysRaw = Number(new URL(request.url).searchParams.get("days"));
  const days = (PERIOD_DAYS as readonly number[]).includes(daysRaw) ? daysRaw : 7;
  const to = businessDateOf(now);
  const from = shiftBusinessDate(to, -(days - 1));

  const canReadFindings = can(tenant, "finding.read", propertyTarget([propertyId]));

  const [tasks, observations, findings] = await Promise.all([
    listTasks(env, tenant, { propertyId, businessDateFrom: from, businessDateTo: to }),
    listObservations(env, tenant, { propertyId, from, to }),
    canReadFindings ? listFindings(env, tenant, { propertyId, from, to }) : Promise.resolve([]),
  ]);

  const [photoCounts, roomNumbers] = await Promise.all([
    countPhotosByTask(
      env,
      tenant,
      tasks.map((task) => task.id),
    ),
    listRoomNumbersByIds(env, tenant, [...new Set(tasks.map((task) => task.roomId))]),
  ]);

  const observedTaskIds = new Set(observations.map((row) => row.taskId));
  // 抑制済みは出さない（月次レポートと同じ判断 / DECISIONS #196）。
  const findingByRoomDate = new Map<string, { id: string; confidence: number }>();
  for (const finding of findings) {
    if (finding.status === "SUPPRESSED") continue;
    const key = `${finding.roomId}|${finding.businessDate}`;
    const current = findingByRoomDate.get(key);
    if (current === undefined || finding.confidence > current.confidence) {
      findingByRoomDate.set(key, { id: finding.id, confidence: finding.confidence });
    }
  }

  const active = tasks.filter((task) => task.status !== "CANCELLED");
  const completed = active.filter((task) => task.status === "COMPLETED");
  const minutes = completed
    .map((task) => task.actualMinutes)
    .filter((value): value is number => value !== null);
  const photoTotal = active.reduce((sum, task) => sum + (photoCounts.get(task.id) ?? 0), 0);
  const median = medianMinutes(minutes);

  const histogram = HISTOGRAM_BUCKETS.map((bucket, index) => ({
    key: bucket.key,
    count: minutes.filter(
      (value) =>
        value <= bucket.max && (index === 0 || value > (HISTOGRAM_BUCKETS[index - 1]?.max ?? 0)),
    ).length,
  }));

  const rows: RecordRow[] = active
    .map((task) => ({
      taskId: task.id,
      roomNumber: roomNumbers.get(task.roomId) ?? "",
      businessDate: task.businessDate,
      taskType: task.taskType,
      startClock: task.startedAt === null ? null : formatClock(task.startedAt.getTime()),
      endClock: task.completedAt === null ? null : formatClock(task.completedAt.getTime()),
      actualMinutes: task.actualMinutes,
      photoCount: photoCounts.get(task.id) ?? 0,
      inspection:
        task.inspectionResult === "PASS"
          ? ("PASS" as const)
          : task.inspectionResult === "FAIL"
            ? ("FAIL" as const)
            : ("NONE" as const),
      finding: canReadFindings
        ? (findingByRoomDate.get(`${task.roomId}|${task.businessDate}`) ?? null)
        : null,
    }))
    .sort(
      (a, b) =>
        b.businessDate.localeCompare(a.businessDate) || a.roomNumber.localeCompare(b.roomNumber),
    );

  const observedActiveCount = active.filter((task) => observedTaskIds.has(task.id)).length;

  return {
    propertyId,
    from,
    to,
    days,
    completedCount: completed.length,
    perDayAverage: (completed.length / days).toFixed(1),
    recordRatePermille:
      active.length === 0 ? null : Math.round((observedActiveCount * 1000) / active.length),
    observedCount: observedActiveCount,
    photoTotal,
    photoAverage: active.length === 0 ? "0" : (photoTotal / active.length).toFixed(1),
    medianActualMinutes: median,
    histogram,
    overMedianNote: minutes.length > 0,
    rows,
    canReadFindings,
  };
}

/** 作業種別の文言。現場画面と同じキーを引く（訳を増やさない）。 */
const TASK_TYPE_LABEL: Record<string, MessageKey> = {
  CHECKOUT: "m.taskType.CHECKOUT",
  STAYOVER: "m.taskType.STAYOVER",
  DEEP: "m.taskType.DEEP",
  COMMON_AREA: "m.taskType.COMMON_AREA",
  RECHECK: "m.taskType.RECHECK",
};

const HISTOGRAM_LABEL: Record<string, MessageKey> = {
  b25: "evidence.hist.b25",
  b30: "evidence.hist.b30",
  b35: "evidence.hist.b35",
  b40: "evidence.hist.b40",
  b45: "evidence.hist.b45",
  b50: "evidence.hist.b50",
  b60: "evidence.hist.b60",
  over: "evidence.hist.over",
};

export default function EvidenceList(): React.ReactElement {
  const data = useLoaderData<EvidenceListData>();
  const maxBucket = Math.max(1, ...data.histogram.map((bucket) => bucket.count));

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("evidence.list.title")}</h1>
        <p className="pk-muted">{`${data.from} 〜 ${data.to}`}</p>
        <form method="get" className="pk-pagehead__actions">
          <label className="pk-field">
            <span className="pk-field__label">{t("evidence.list.period")}</span>
            <select className="pk-select" name="days" defaultValue={String(data.days)}>
              <option value="7">{t("evidence.period.7")}</option>
              <option value="30">{t("evidence.period.30")}</option>
            </select>
          </label>
          <button className="pk-button pk-button--primary" type="submit">
            {t("evidence.list.apply")}
          </button>
        </form>
      </div>

      {/* §6.1 / P2 固有の絶対ルール。**法的タイムスタンプと表現しない。** */}
      <p className="pk-notice">{t("evidence.disclaimer")}</p>

      {/* ── KPI（プロトタイプの 4 枚。完備率が主役）──────────── */}
      <dl className="pk-stats">
        <div className="pk-stats__item">
          <dt>{t("evidence.kpi.count")}</dt>
          <dd>{String(data.completedCount)}</dd>
          <p className="pk-report__delta">{`${t("evidence.kpi.perDay")} ${data.perDayAverage}`}</p>
        </div>
        <div className="pk-stats__item pk-stats__item--READY">
          <dt>{t("evidence.kpi.recordRate")}</dt>
          <dd>
            {data.recordRatePermille === null ? "—" : (data.recordRatePermille / 10).toFixed(1)}
            <span className="pk-stats__unit">{t("evidence.unit.percent")}</span>
          </dd>
          <p className="pk-report__delta">
            {`${String(data.observedCount)}${t("evidence.kpi.recordRateNote")}`}
          </p>
        </div>
        <div className="pk-stats__item pk-stats__item--BLOCKED">
          <dt>{t("evidence.kpi.photos")}</dt>
          <dd>{String(data.photoTotal)}</dd>
          <p className="pk-report__delta">{`${t("evidence.kpi.photoAverage")} ${data.photoAverage}`}</p>
        </div>
        <div className="pk-stats__item">
          <dt>{t("evidence.kpi.median")}</dt>
          <dd>
            {data.medianActualMinutes === null ? "—" : String(data.medianActualMinutes)}
            <span className="pk-stats__unit">{t("evidence.unit.minutes")}</span>
          </dd>
          <p className="pk-report__delta">{t("evidence.kpi.medianNote")}</p>
        </div>
      </dl>

      {/* ── 実作業時間の分布 ───────────────────────────────── */}
      {data.overMedianNote ? (
        <>
          <h2 className="pk-section__title">{t("evidence.hist.title")}</h2>
          <div className="pk-bars">
            {data.histogram.map((bucket) => (
              <div key={bucket.key} className="pk-bars__col">
                <span className="pk-bars__value">{String(bucket.count)}</span>
                <i
                  className="pk-bars__bar"
                  style={{
                    height: `${String(Math.max(4, Math.round((bucket.count * 96) / maxBucket)))}%`,
                  }}
                />
                <span className="pk-bars__label">
                  {t(HISTOGRAM_LABEL[bucket.key] as MessageKey)}
                </span>
              </div>
            ))}
          </div>
          {/* 超過を問題として示さない（INV-05 / プロトタイプの注記そのまま）。 */}
          <p className="pk-muted">{t("evidence.hist.note")}</p>
        </>
      ) : null}

      {data.rows.length === 0 ? (
        <p className="pk-muted">{t("evidence.list.empty")}</p>
      ) : (
        <table className="pk-grid">
          <thead>
            <tr>
              <th>{t("evidence.list.room")}</th>
              <th>{t("evidence.list.date")}</th>
              <th>{t("evidence.list.taskType")}</th>
              <th>{t("evidence.list.clock")}</th>
              <th>{t("evidence.list.minutes")}</th>
              <th>{t("evidence.list.photos")}</th>
              <th>{t("evidence.list.inspection")}</th>
              {data.canReadFindings ? <th>{t("evidence.list.finding")}</th> : null}
              <th />
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.taskId}>
                <th scope="row">{row.roomNumber}</th>
                <td>{row.businessDate}</td>
                <td>{labelOfTaskType(row.taskType)}</td>
                <td>
                  {row.startClock === null ? "—" : `${row.startClock} → ${row.endClock ?? ""}`}
                </td>
                <td>
                  {row.actualMinutes === null
                    ? "—"
                    : `${String(row.actualMinutes)}${t("evidence.unit.minutes")}`}
                </td>
                <td>{String(row.photoCount)}</td>
                <td>
                  {row.inspection === "PASS"
                    ? t("evidence.inspection.pass")
                    : row.inspection === "FAIL"
                      ? t("evidence.inspection.rework")
                      : t("evidence.inspection.none")}
                </td>
                {data.canReadFindings ? (
                  <td>
                    {row.finding === null ? (
                      "—"
                    ) : (
                      <a href={`/app/audit/findings/${row.finding.id}`}>
                        {String(row.finding.confidence)}
                      </a>
                    )}
                  </td>
                ) : null}
                <td>
                  <Link
                    className="pk-button"
                    to={`/app/p/${data.propertyId}/evidence/${row.taskId}`}
                  >
                    {t("evidence.list.open")}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* 担当者の氏名はこの画面に出さない（プロトタイプの注記 / INV-06）。 */}
      <p className="pk-muted">{t("evidence.staffHidden")}</p>
    </section>
  );
}

function labelOfTaskType(taskType: string): string {
  const key = TASK_TYPE_LABEL[taskType];
  return key === undefined ? taskType : t(key);
}
