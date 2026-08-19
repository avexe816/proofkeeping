/**
 * 検査キュー（施設横断）。
 *
 *   /app/inspections/queue
 *
 * task:  docs/tasks/P7-18.md
 * 参照:  ui-prototypes/ops/pkops-A-daily-quality.html（04 検査キュー）
 * ルール: .claude/rules/security.md §1 / .claude/rules/ui-writing.md §2・§3
 *
 * ── `CLEANER` はここに到達できない ──────────────────────
 * `inspection.read` が `DENY`。`resolveListScope()` の中の
 * `assertPermission()` が `NotFoundError` を投げ、**404** になる。
 * サイドバーからも消えるが、**メニュー非表示は権限制御ではない**
 * （security.md §1）。この loader が門。
 *
 * ── 担当者名を出さない ──────────────────────────────────
 * INV-09。プロトタイプ 04 の「検査は担当者名を見ずに行います」もこれ。
 * 一覧に列を作らないだけでなく、**API が返していない**
 * （`packages/contracts` の `inspectionQueueItemSchema`）。
 * 自分が清掃した客室はサーバー側で既に除いてある。
 *
 * ── 順位付けをしない ────────────────────────────────────
 * 並びは §11.2 の 4 段（engine）。**スコアも優先度の数値も出さない**
 * （CLAUDE.md §4「自動評価を作らない」）。
 * 経過時間を赤で出さない（ui-writing.md §3）。強さは `tone` の 3 段だけで、
 * `URGENT` が締切（客の到着）、`OVER_SLA` が目安超過。
 *
 * ── 「お急ぎ」の件数を出さない（OPEN_QUESTIONS #045）──────
 * §11.2 の第 1 段（チェックイン 30 分前）は**判定できる材料がまだ無い。**
 * チェックイン予定時刻の列が存在せず、`lib/inspection/queue.ts` は
 * `checkInAtMs: null` を渡している。したがって `summary.urgent` は
 * **実データに関わらず常に 0** になる。
 *
 * これを見出しに出すと「お急ぎ 0 件」＝「急ぐ客室は無い」と読まれる。
 * **判定していないことと、判定した結果 0 件であることは違う。**
 * 前者を後者の顔で見せないため、この画面は件数を出さない。
 *
 * **engine の `URGENT` 判定と API の `summary.urgent` は残してある**
 * （将来用 / `packages/engine` の `waitStateOf()`）。列が入って
 * `checkInAtMs` が埋まったら、**この画面の集計に「お急ぎ」を戻すこと。**
 * 戻す場所は下の `pk-board__counts`（`inspectionQueue.summary.urgent` の
 * 文言キーは消さずに残してある）。
 *
 * ── プロトタイプのうち作っていないもの ──────────────────
 * 抜き取り率・抜き取りの選び方・本日の再清掃カードは P7-18 の
 * 「やること」に無い。**task に書かれていないことを実装しない**
 * （CLAUDE.md §1）。
 */

import type { InspectionDetailResponse, InspectionQueueItem } from "@pk/contracts";
import { useState } from "react";
import { Form, useLoaderData, useNavigate, type LoaderFunctionArgs } from "react-router";

import { businessDateOf } from "../../lib/businessDate.js";
import { t } from "../../lib/i18n.js";
import { buildInspectionQueue } from "../../lib/inspection/queue.js";
import { formatClock } from "../../lib/mobile/format.js";
import { resolveListScope } from "../../lib/property/listScope.js";
import { listSelectableProperties, resolveSelectedScope } from "../../lib/property/selection.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";
import type { MessageKey } from "../../locales/index.js";

interface InspectionQueueData {
  businessDate: string;
  summary: { total: number; urgent: number; overSla: number; recheck: number };
  rows: InspectionQueueItem[];
}

export async function loader({
  request,
  context,
}: LoaderFunctionArgs): Promise<InspectionQueueData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  const url = new URL(request.url);

  // 施設はヘッダーの施設セレクタが唯一の入口（DECISIONS #204）。
  // **これが唯一の門。** 権限が無ければ 404（`CLEANER` はここで落ちる）。
  const selectable = await listSelectableProperties(env, tenant);
  const { property } = resolveSelectedScope(session.selectedPropertyId, tenant, selectable);
  const scope = resolveListScope(tenant, "inspection.read", property?.id ?? null);

  const businessDate = url.searchParams.get("businessDate") ?? businessDateOf(now);

  const queue = await buildInspectionQueue(env, tenant, {
    scope,
    businessDate,
    viewerMembershipId: session.membershipId,
    now,
  });

  return {
    businessDate: queue.businessDate,
    summary: queue.summary,
    rows: queue.data,
  };
}

/** 開始に失敗したときの文言。**M-08 と同じ語彙**（現場と管理で言い方を変えない）。 */
function startFailureKey(code: string): MessageKey {
  switch (code) {
    case "INSPECTION_ALREADY_STARTED":
      return "m.inspections.error.alreadyStarted";
    case "SELF_INSPECTION_FORBIDDEN":
      return "m.inspections.error.selfForbidden";
    case "INVALID_TRANSITION":
      return "m.inspections.error.notWaiting";
    case "OFFLINE":
      return "m.inspections.error.offline";
    default:
      return "m.inspections.error.generic";
  }
}

/**
 * 強さの文言。**3 つしか無い**（engine の `INSPECTION_QUEUE_TONES`）。
 *
 * **`URGENT` は現状の行には現れない**（OPEN_QUESTIONS #045 /
 * `checkInAtMs` が常に `null`）。表から消していないのは、
 * `INSPECTION_QUEUE_TONES` の網羅を型で保つためと、#045 の解消時に
 * ここへ手を入れずに済ませるため。
 */
const TONE_LABEL: Record<InspectionQueueItem["tone"], MessageKey> = {
  URGENT: "inspectionQueue.tone.urgent",
  OVER_SLA: "inspectionQueue.tone.overSla",
  NORMAL: "inspectionQueue.tone.normal",
};

export default function InspectionQueue() {
  const data = useLoaderData<InspectionQueueData>();
  const navigate = useNavigate();
  const [starting, setStarting] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  /**
   * 検査を開く。**確認ダイアログを挟まない**（M-08 と同じ / §11.2）。
   *
   * 検査の実施画面は M-09 だけなので、開始できたらそこへ送る。
   * PC 専用の検査画面は P2 の範囲に無く、ここで作らない。
   */
  const start = (taskId: string): void => {
    setStarting(taskId);
    setFailure(null);
    void (async () => {
      try {
        const response = await fetch(`/api/v1/tasks/${taskId}/inspection/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientTs: Date.now() }),
        });
        if (response.ok) {
          const body = await response.json<InspectionDetailResponse>();
          await navigate(`/m/inspection/${body.data.inspectionId}`);
          return;
        }
        const empty: { error?: string } = {};
        const body = await response.json<{ error?: string }>().catch(() => empty);
        setFailure(body.error ?? "INVALID_REQUEST");
      } catch {
        setFailure("OFFLINE");
      } finally {
        setStarting(null);
      }
    })();
  };

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("inspectionQueue.title")}</h1>
      </div>

      {/* INV-09。**この文は消さないこと。** 順序の説明であって、隠す話ではない。 */}
      <p className="pk-notice">{t("inspectionQueue.intro")}</p>

      <Form method="get" className="pk-filter">
        <label className="pk-field">
          <span className="pk-field__label">{t("inspectionQueue.filter.businessDate")}</span>
          <input
            className="pk-input"
            type="date"
            name="businessDate"
            defaultValue={data.businessDate}
          />
        </label>

        <button className="pk-button" type="submit">
          {t("inspectionQueue.filter.apply")}
        </button>
      </Form>

      {/*
        **「お急ぎ」は出さない**（冒頭の注記 / OPEN_QUESTIONS #045）。
        判定材料が無く常に 0 になるため、0 件を「急ぐ客室が無い」と
        読ませてしまう。#045 が解消したらここへ 1 行戻す。
      */}
      <ul className="pk-board__counts">
        <li>{`${t("inspectionQueue.summary.total")} ${String(data.summary.total)}`}</li>
        <li>{`${t("inspectionQueue.summary.overSla")} ${String(data.summary.overSla)}`}</li>
        <li>{`${t("inspectionQueue.summary.recheck")} ${String(data.summary.recheck)}`}</li>
      </ul>

      {failure === null ? null : (
        <p className="pk-notice" role="status">
          {t(startFailureKey(failure))}
        </p>
      )}

      {data.rows.length === 0 ? (
        <p className="pk-muted">{t("inspectionQueue.empty")}</p>
      ) : (
        <table className="pk-grid">
          <thead>
            <tr>
              <th>{t("inspectionQueue.column.room")}</th>
              <th>{t("inspectionQueue.column.property")}</th>
              <th>{t("inspectionQueue.column.completedAt")}</th>
              <th>{t("inspectionQueue.column.waited")}</th>
              <th>{t("inspectionQueue.column.round")}</th>
              <th>{t("inspectionQueue.column.tone")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.taskId}>
                <th scope="row">{row.roomNumber}</th>
                <td>{row.propertyName}</td>
                <td>
                  {/* **端末のタイムゾーンで出さない**（`formatClock()` の注記）。 */}
                  {row.completedAt === null
                    ? t("inspectionQueue.notRecorded")
                    : formatClock(row.completedAt)}
                </td>
                <td>{`${String(row.waitedMinutes)} / ${String(row.slaMinutes)}`}</td>
                <td>{String(row.nextRound)}</td>
                <td>{t(TONE_LABEL[row.tone])}</td>
                <td>
                  <button
                    className="pk-button"
                    type="button"
                    disabled={starting !== null}
                    onClick={() => {
                      start(row.taskId);
                    }}
                  >
                    {starting === row.taskId
                      ? t("inspectionQueue.starting")
                      : t("inspectionQueue.start")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
