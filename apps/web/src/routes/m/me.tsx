/**
 * M-11 自分の実績（PK-SPEC-P1 §9.6）と表示言語の切替（同 §12.3）。
 *
 * task:  docs/tasks/P1-17.md / docs/tasks/P1-18.md
 * ルール: .claude/rules/security.md §5（従業員データ）
 * 参照:  ui-prototypes/mobile/pk-14-personal-stats.html / pk-15-language.html
 *
 * ── 出さないものが設計 ──────────────────────────────────
 * §9.6 MUST / INV-02。**他人との比較・順位・平均との差を出さない。**
 * 集計に使うのは `listTasks({ assigneeId: 自分 })` だけで、他人の
 * `membershipId` を受け取る口が無い（URL にもフォームにも）。
 *
 * ── 平均だけが閾値で伏せられる ──────────────────────────
 * security.md §5「個人単位の指標は対象期間 20 タスク未満なら表示しない」。
 * 完了件数・作業中・合計作業時間は**事実**なので常に出し、そこから作った
 * **指標**である平均だけを伏せる（`summarizeOwnWork()` の注記 /
 * docs/DECISIONS.md #035）。仕様 §9.6 とプロトタイプは 11〜12 件でも
 * 平均を描いており、食い違いは docs/OPEN_QUESTIONS.md #040 に起票した。
 *
 * ── 言語は端末ではなくユーザーに紐づく ──────────────────
 * ui-writing.md §1 / §12.3。**ブラウザの言語設定を参照しない。**
 * 共用端末では「いま使っている人」を表さないため。
 */

import { listTasks, setUserLocale } from "@pk/db";
import { summarizeOwnWork, weekRangeOf, MINIMUM_TASKS_FOR_AVERAGE } from "@pk/engine";
import {
  Form,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { ORGANIZATION_TARGET, assertPermission } from "../../lib/auth/permission.js";
import { businessDateOf } from "../../lib/businessDate.js";
import { createTranslator, isLocale, LOCALES, type Locale, type MessageKey } from "../../lib/i18n.js";
import { requireMobileContext } from "../../lib/mobile/session.js";
import { splitHoursMinutes } from "../../lib/mobile/format.js";
import { getEnv } from "../../lib/ui/cloudflare.js";

export interface OwnStatsData {
  locale: Locale;
  displayName: string;
  businessDate: string;
  today: {
    completed: number;
    inProgress: number;
    workedMinutes: number;
    averageMinutes: number | null;
  };
  week: {
    from: string;
    to: string;
    completed: number;
    averageMinutes: number | null;
  };
  /** 平均を出すのに要る件数（画面が理由として示す）。 */
  minimumForAverage: number;
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<OwnStatsData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant, locale, displayName } = await requireMobileContext(env, request, now);

  // **対象は常に自分。** 他人を指定する引数が無いことが判定の一部
  // （`lib/auth/permission.ts` の `task.readOwn` の注記）。
  assertPermission(tenant, "task.readOwn", ORGANIZATION_TARGET);

  const businessDate = businessDateOf(now);
  const week = weekRangeOf(businessDate);

  // 今週ぶんを 1 回で引き、本日は手元で絞る。**2 回引かない**（§13）。
  const rows = await listTasks(env, tenant, {
    assigneeId: session.membershipId,
    businessDateFrom: week.from,
    businessDateTo: week.to,
  });

  const toInput = (task: (typeof rows)[number]) => ({
    status: task.status,
    actualMinutes: task.actualMinutes,
  });
  const today = summarizeOwnWork(
    rows.filter((task) => task.businessDate === businessDate).map(toInput),
  );
  const weekSummary = summarizeOwnWork(rows.map(toInput));

  return {
    locale,
    displayName,
    businessDate,
    today,
    week: {
      from: week.from,
      to: week.to,
      completed: weekSummary.completed,
      averageMinutes: weekSummary.averageMinutes,
    },
    minimumForAverage: MINIMUM_TASKS_FOR_AVERAGE,
  };
}

/**
 * 表示言語の変更（§12.3）。
 *
 * **対応言語以外は黙って無視する。** `LOCALES` に無い値を保存すると
 * `resolveLocale()` が既定へ落とすだけだが、DB に使われない値が残る。
 */
export async function action({ request, context }: ActionFunctionArgs): Promise<null> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireMobileContext(env, request, now);

  const form = await request.formData();
  const locale = form.get("locale");
  if (typeof locale === "string" && isLocale(locale)) {
    await setUserLocale(env, tenant, session.userId, locale);
  }
  return null;
}

export default function OwnStatsRoute(): React.ReactElement {
  const data = useLoaderData<OwnStatsData>();
  const t = createTranslator(data.locale);

  return (
    <>
      <header className="pk-m-head">
        <div className="pk-m-head__row">
          <h1 className="pk-m-head__title">{t("m.me.title")}</h1>
        </div>
        <p className="pk-m-head__sub">{`${data.displayName} · ${data.businessDate}`}</p>
      </header>

      <main className="pk-m-body">
        <section className="pk-m-stats">
          <h2 className="pk-m-stats__title">{t("m.me.today")}</h2>
          <Stat label={t("m.me.completed")} value={`${String(data.today.completed)}${t("m.me.unit.count")}`} />
          <Stat label={t("m.me.inProgress")} value={`${String(data.today.inProgress)}${t("m.me.unit.count")}`} />
          <Stat label={t("m.me.workedTime")} value={workedLabel(data.today.workedMinutes, t)} />
          <Stat
            label={t("m.me.average")}
            value={
              data.today.averageMinutes === null
                ? t("m.me.average.tooFew")
                : `${String(data.today.averageMinutes)}${t("m.me.unit.minutesPerRoom")}`
            }
          />
        </section>

        <section className="pk-m-stats">
          <h2 className="pk-m-stats__title">{t("m.me.thisWeek")}</h2>
          <Stat label={t("m.me.completed")} value={`${String(data.week.completed)}${t("m.me.unit.count")}`} />
          <Stat
            label={t("m.me.average")}
            value={
              data.week.averageMinutes === null
                ? t("m.me.average.tooFew")
                : `${String(data.week.averageMinutes)}${t("m.me.unit.minutesPerRoom")}`
            }
          />
        </section>

        {/* security.md §5 / §9.6 MUST。**この 1 行を消さないこと。** */}
        <p className="pk-m-note">{t("m.me.noComparison")}</p>

        {/* §12.3 言語切替。ブラウザの設定は参照しない。 */}
        <Form method="post" className="pk-m-lang">
          <h2 className="pk-m-stats__title">{t("m.me.language")}</h2>
          {LOCALES.map((locale) => (
            <button
              key={locale}
              type="submit"
              name="locale"
              value={locale}
              className={
                locale === data.locale ? "pk-m-lang__item pk-m-lang__item--on" : "pk-m-lang__item"
              }
              aria-pressed={locale === data.locale}
            >
              {t(`m.locale.${locale}` as MessageKey)}
            </button>
          ))}
        </Form>
      </main>
    </>
  );
}

/** 「5時間20分」。**単位は `t()` で付ける**（`lib/mobile/format.ts` の方針）。 */
function workedLabel(totalMinutes: number, t: ReturnType<typeof createTranslator>): string {
  const { hours, minutes } = splitHoursMinutes(totalMinutes);
  const tail = `${String(minutes)}${t("m.me.unit.minutes")}`;
  return hours === 0 ? tail : `${String(hours)}${t("m.me.unit.hours")}${tail}`;
}

function Stat({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="pk-m-stats__row">
      <span className="pk-m-stats__label">{label}</span>
      <span className="pk-m-stats__value">{value}</span>
    </div>
  );
}
