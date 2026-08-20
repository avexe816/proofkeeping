import {
  findLatestSnapshotDate,
  listTenantSnapshots,
  readPlatformOperationSettings,
} from "@pk/db";
import { useLoaderData, type LoaderFunctionArgs } from "react-router";

import { t } from "../../lib/i18n.js";
import { requirePlatformOperator } from "../../lib/platform/requireOperator.js";
import {
  buildTenantListPage,
  trialDaysLeft,
  type TenantListPage,
  type TenantState,
} from "../../lib/platform/tenantList.js";
import { getEnv } from "../../lib/ui/cloudflare.js";

/**
 * テナント管理（PF-04 / プロトタイプ 02）。
 *
 *   /plat/tenants
 *
 * task: docs/tasks/PF-04.md
 *
 * ── 元はスナップショットだけ（完了条件）─────────────────
 * `getTenantDb()` を呼ばない。読むのは `platform_tenant_snapshot`（PF-02）と
 * 運用設定（PF-14 の閾値）だけ。**16 シャードへ fan-out しない。**
 *
 * ── 個人を出さない（INV-10 / 完了条件）──────────────────
 * スタッフは**人数だけ。** 氏名もメールも表に無い（スナップショットが
 * そもそも持っていない）。
 *
 * ── テナントのデータへ入る導線を作らない ────────────────
 * プロトタイプの「詳細」ボタンは置いていない。**テナントの中身へは
 * PF-13 の一時アクセス（理由＋承認 2 名＋最大 4 時間）を通す**のが
 * INV-10 で、そこを迂回する入口をここに作らない。
 *
 * ── 「＋ テナントを追加」を置かない ─────────────────────
 * 申込み〜組織作成の経路がまだ無い（OPEN_QUESTIONS #100 / #101）。
 * **到達先の無いボタンを置かない**（`ui/navigation.ts` と同じ判断）。
 */

/** 状態 → 文言とタグの色。プロトタイプ 02 の 4 つ。 */
const STATE_LABEL: Record<TenantState, Parameters<typeof t>[0]> = {
  ACTIVE: "plat.tenants.state.active",
  TRIAL: "plat.tenants.state.trial",
  ATTENTION: "plat.tenants.state.attention",
  SUSPENDED: "plat.tenants.state.suspended",
};

const STATE_CLASS: Record<TenantState, string> = {
  ACTIVE: "pk-tag pk-tag--ok",
  TRIAL: "pk-tag",
  ATTENTION: "pk-tag pk-tag--warn",
  SUSPENDED: "pk-tag pk-tag--warn",
};

/**
 * プラン別の「主な制限」。**出どころは `docs/PK-BIZ-PLAN.md` の版数表。**
 *
 * ここで勝手に決めない。機能差異は**PMS 連携の有無 1 点のみ**で、
 * Ent が足すのは契約条件（SSO・SLA・API・サポート形態）であって機能ではない。
 */
const PLAN_NOTE: Record<string, Parameters<typeof t>[0]> = {
  BASE: "plat.tenants.plan.base",
  PRO: "plat.tenants.plan.pro",
  ENT: "plat.tenants.plan.ent",
};

export async function loader({ request, context }: LoaderFunctionArgs): Promise<TenantListPage> {
  const env = getEnv(context);
  await requirePlatformOperator(env, request, new Date());

  // **「今日」を決め打ちで引かない。** 夜間バッチがまだの朝に空になる。
  const businessDate = await findLatestSnapshotDate(env);
  const [snapshots, settings] = await Promise.all([
    businessDate === null ? Promise.resolve([]) : listTenantSnapshots(env, businessDate),
    readPlatformOperationSettings(env),
  ]);

  return buildTenantListPage(snapshots, settings, businessDate);
}

/** 完備率のセル。**出せない日は「—」ではなく専用の文言。** */
function Completeness({ percent }: { percent: number | null }) {
  if (percent === null) return <span className="pk-muted">{t("plat.tenants.noData")}</span>;
  return <span>{`${String(percent)}%`}</span>;
}

export default function PlatTenants() {
  const data = useLoaderData<TenantListPage>();

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("plat.tenants.title")}</h1>
      </div>

      {data.businessDate === null ? (
        <p className="pk-page__lede">{t("plat.tenants.empty")}</p>
      ) : (
        <p className="pk-page__lede">{`${t("plat.tenants.asOf")} ${data.businessDate}`}</p>
      )}

      {/* KPI 5 枚（プロトタイプ 02）。テナントの画面と同じ `pk-stats`。 */}
      <dl className="pk-stats">
        <div className="pk-stats__item pk-stats__item--accent-info">
          <dt>{t("plat.tenants.kpi.tenants")}</dt>
          <dd>{String(data.summary.tenants)}</dd>
        </div>
        <div className="pk-stats__item pk-stats__item--accent-ok">
          <dt>{t("plat.tenants.kpi.active")}</dt>
          <dd>{String(data.summary.active)}</dd>
        </div>
        <div className="pk-stats__item">
          <dt>{t("plat.tenants.kpi.trial")}</dt>
          <dd>{String(data.summary.trial)}</dd>
        </div>
        <div className="pk-stats__item">
          <dt>{t("plat.tenants.kpi.attention")}</dt>
          <dd>{String(data.summary.attention)}</dd>
        </div>
        <div className="pk-stats__item">
          <dt>{t("plat.tenants.kpi.scale")}</dt>
          <dd>
            {`${String(data.summary.properties)} / ${String(data.summary.rooms)}`}
          </dd>
        </div>
      </dl>

      <div className="pk-card">
        <h2 className="pk-card__title">{t("plat.tenants.list")}</h2>
        <table className="pk-table">
          <thead>
            <tr>
              <th scope="col">{t("plat.tenants.column.name")}</th>
              <th scope="col">{t("plat.tenants.column.plan")}</th>
              <th scope="col">{t("plat.tenants.column.properties")}</th>
              <th scope="col">{t("plat.tenants.column.rooms")}</th>
              <th scope="col">{t("plat.tenants.column.staff")}</th>
              <th scope="col">{t("plat.tenants.column.completeness")}</th>
              <th scope="col">{t("plat.tenants.column.state")}</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.organizationId}>
                <td>
                  {row.name}
                  {row.contractedOn === null ? null : (
                    <span className="pk-muted"> {row.contractedOn}</span>
                  )}
                </td>
                <td>{row.plan === null ? t("plat.tenants.noPlan") : row.plan}</td>
                <td>{row.propertyCount}</td>
                <td>{row.roomCount}</td>
                <td>{row.staffCount}</td>
                <td>
                  <Completeness percent={row.completenessPercent} />
                </td>
                <td>
                  <span className={STATE_CLASS[row.state]}>{t(STATE_LABEL[row.state])}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="pk-card">
        <h2 className="pk-card__title">{t("plat.tenants.plans")}</h2>
        <table className="pk-table">
          <thead>
            <tr>
              <th scope="col">{t("plat.tenants.column.plan")}</th>
              <th scope="col">{t("plat.tenants.column.count")}</th>
              <th scope="col">{t("plat.tenants.column.properties")}</th>
              <th scope="col">{t("plat.tenants.column.planNote")}</th>
            </tr>
          </thead>
          <tbody>
            {data.plans.map((plan) => (
              <tr key={plan.plan}>
                <td>{plan.plan}</td>
                <td>{plan.tenants}</td>
                <td>{plan.properties}</td>
                <td>
                  {plan.plan in PLAN_NOTE ? (
                    t(PLAN_NOTE[plan.plan] as Parameters<typeof t>[0])
                  ) : (
                    <span className="pk-muted">{t("plat.tenants.noData")}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {/* 逐語の注記（PF-04「逐語で置く注記」）。**言い換えない。** */}
        <p className="pk-muted">{t("plat.tenants.note.plan")}</p>
      </div>

      {data.trials.length === 0 ? null : (
        <div className="pk-card">
          <h2 className="pk-card__title">{t("plat.tenants.trials")}</h2>
          <ul>
            {data.trials.map((row) => {
              const left = trialDaysLeft(row.trialEndsOn, data.businessDate);
              return (
                <li key={row.organizationId}>
                  {row.name}
                  {left === null ? null : (
                    <span className="pk-muted">
                      {` ${t("plat.tenants.trialLeft")} ${String(left)}`}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {/* 試用中の確認項目 4 つ（プロトタイプ 02）。**増やさない。** */}
          <ul>
            <li>{t("plat.tenants.trialCheck.1")}</li>
            <li>{t("plat.tenants.trialCheck.2")}</li>
            <li>{t("plat.tenants.trialCheck.3")}</li>
            <li>{t("plat.tenants.trialCheck.4")}</li>
          </ul>
        </div>
      )}
    </section>
  );
}
