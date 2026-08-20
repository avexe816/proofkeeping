import {
  findLatestSnapshotDate,
  listTenantSnapshots,
  readPlatformOperationSettings,
} from "@pk/db";
import { useLoaderData, type LoaderFunctionArgs } from "react-router";

import { t } from "../../lib/i18n.js";
import { requirePlatformOperator } from "../../lib/platform/requireOperator.js";
import {
  buildUsagePage,
  buildVerdictNote,
  type UsagePage,
} from "../../lib/platform/usagePage.js";
import { getEnv } from "../../lib/ui/cloudflare.js";

/**
 * 利用状況（PF-05 / プロトタイプ 03）。
 *
 *   /plat/usage
 *
 * task: docs/tasks/PF-05.md
 *
 * ── 軸はテナント・言語・時系列だけ ──────────────────────
 * **個人単位の集計も絞り込みも無い**（security.md §5 / 完了条件）。
 *
 * ── 出す元の無い指標を置かない ──────────────────────────
 * プロトタイプ 03 の KPI 5 つのうち「アクティブ端末」は端末の登録簿が
 * 無く、カード「ストレージと通信」も測っていない（OPEN_QUESTIONS #114 /
 * DECISIONS #238）。**列ごと置かず、「未計測」と明示する。**
 *
 * 「記録数の推移（直近 6 か月）」も置いていない。スナップショットは
 * PF-02 が動き出した日からしか無く、**6 か月ぶんを出せるようになるのは
 * 半年後。** 出せない期間を 0 の棒で埋めない。
 */

/** 入力時間を秒で見せる。**計測が無ければ「未計測」。** */
function InputDuration({ ms }: { ms: number | null }) {
  if (ms === null) return <span className="pk-muted">{t("plat.usage.notMeasured")}</span>;
  return <span>{`${String(Math.round(ms / 1000))}${t("plat.usage.unit.seconds")}`}</span>;
}

/**
 * 未計測（`null`）を **0 に落とさずに**出す。
 *
 * 0033 より前のスナップショットはこの値を数えていない。
 * **`?? 0` で埋めると「実測 0 件」に見える**（オーナー指摘 / DECISIONS #242）。
 */
function Measured({ value }: { value: number | null }) {
  if (value === null) return <span className="pk-muted">{t("plat.usage.notMeasured")}</span>;
  return <span>{String(value)}</span>;
}

/** 割合。**出せない日は「記録なし」**（0% にしない）。 */
function Percent({ value }: { value: number | null }) {
  if (value === null) return <span className="pk-muted">{t("plat.usage.noData")}</span>;
  return <span>{`${String(value)}%`}</span>;
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<UsagePage> {
  const env = getEnv(context);
  await requirePlatformOperator(env, request, new Date());

  const businessDate = await findLatestSnapshotDate(env);
  const [snapshots, settings] = await Promise.all([
    businessDate === null ? Promise.resolve([]) : listTenantSnapshots(env, businessDate),
    readPlatformOperationSettings(env),
  ]);

  return buildUsagePage(snapshots, settings, businessDate);
}

export default function PlatUsage() {
  const data = useLoaderData<UsagePage>();

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("plat.usage.title")}</h1>
      </div>

      {data.businessDate === null ? (
        <p className="pk-page__lede">{t("plat.usage.empty")}</p>
      ) : (
        <p className="pk-page__lede">{`${t("plat.usage.asOf")} ${data.businessDate}`}</p>
      )}

      <dl className="pk-stats">
        <div className="pk-stats__item pk-stats__item--accent-info">
          <dt>{t("plat.usage.kpi.cleanings")}</dt>
          <dd>{String(data.summary.completedTasks)}</dd>
        </div>
        <div className="pk-stats__item pk-stats__item--accent-ok">
          <dt>{t("plat.usage.kpi.completeness")}</dt>
          <dd>
            <Percent value={data.summary.completenessPercent} />
          </dd>
        </div>
        <div className="pk-stats__item">
          <dt>{t("plat.usage.kpi.photos")}</dt>
          <dd>
            <Measured value={data.summary.photoCount} />
          </dd>
        </div>
        <div className="pk-stats__item">
          <dt>{t("plat.usage.kpi.findings")}</dt>
          <dd>
            <Measured value={data.summary.findings} />
          </dd>
        </div>
      </dl>

      <div className="pk-card">
        <h2 className="pk-card__title">{t("plat.usage.quality")}</h2>
        {/* **下位から並ぶ**ことを画面にも書く（並び順が仕様）。 */}
        <p className="pk-muted">{t("plat.usage.quality.order")}</p>
        <table className="pk-table">
          <thead>
            <tr>
              <th scope="col">{t("plat.usage.column.tenant")}</th>
              <th scope="col">{t("plat.usage.column.completeness")}</th>
              <th scope="col">{t("plat.usage.column.defaultRate")}</th>
              <th scope="col">{t("plat.usage.column.inputDuration")}</th>
              <th scope="col">{t("plat.usage.column.verdict")}</th>
            </tr>
          </thead>
          <tbody>
            {data.quality.map((row) => (
              <tr key={row.organizationId}>
                <td>{row.name}</td>
                <td>
                  <Percent value={row.completenessPercent} />
                </td>
                <td>
                  <Percent value={row.defaultRatePercent} />
                </td>
                <td>
                  <InputDuration ms={row.inputDurationMedianMs} />
                </td>
                <td>
                  {row.needsSupport ? (
                    <span className="pk-tag pk-tag--warn">{t("plat.usage.verdict.support")}</span>
                  ) : (
                    <span className="pk-tag pk-tag--ok">{t("plat.usage.verdict.ok")}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {/* 逐語の注記（PF-05「逐語で置く注記」）。**言い換えない。**
            ただし**数値は固定しない** — PF-14 で閾値を変えたら
            この文も変わる（DECISIONS #242）。 */}
        <p className="pk-muted">
          {buildVerdictNote(t("plat.usage.note.verdict"), data.thresholds)}
        </p>
      </div>

      <div className="pk-card">
        <h2 className="pk-card__title">{t("plat.usage.locales")}</h2>
        {data.totalPeople === null ? (
          // **未計測。** 0033 より前の行が混ざっている（空の表を「0 人」と読ませない）。
          <p className="pk-muted">{t("plat.usage.notMeasured.body")}</p>
        ) : data.totalPeople === 0 ? (
          <p className="pk-muted">{t("plat.usage.locales.empty")}</p>
        ) : (
          <table className="pk-table">
            <thead>
              <tr>
                <th scope="col">{t("plat.usage.column.locale")}</th>
                <th scope="col">{t("plat.usage.column.people")}</th>
                <th scope="col">{t("plat.usage.column.share")}</th>
              </tr>
            </thead>
            <tbody>
              {data.locales.map((row) => (
                <tr key={row.locale}>
                  <td>{row.locale}</td>
                  <td>{String(row.people)}</td>
                  <td>
                    <Percent value={row.percent} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {/* 逐語の注記。**「6.9%」という数字は書かない** — 上の表が実測を出す。 */}
        <p className="pk-muted">{t("plat.usage.note.locale")}</p>
      </div>

      <div className="pk-card">
        <h2 className="pk-card__title">{t("plat.usage.pending")}</h2>
        <p className="pk-muted">{t("plat.usage.pending.body")}</p>
      </div>
    </section>
  );
}
