/**
 * 施設選択画面（PK-SPEC-P1 §19.4）。**担当が 4 施設以上のときだけ挟む。**
 *
 * task:  docs/tasks/P1-22.md
 * ルール: .claude/rules/ui-writing.md §3
 * 参照:  ui-prototypes/mobile/pk-03-property-picker.html
 *
 * ── 「切替」ではない ────────────────────────────────────
 * §19.2 MUST は「清掃員に施設を切り替えるという概念を持たせない」。
 * この画面は**起動時に 1 回だけ絞り込む**もので、常設のセレクタではない。
 * 選んだあとは当日中もう出ない。他施設へ移りたくなったら M-02 上部の
 * 「🏢 N施設を担当」から戻ってくる（§19.4）。
 *
 * ── 選択はサーバーの判定に使わない ──────────────────────
 * 保存するのは表示の絞り込みだけ（`lib/mobile/pick.ts`）。開始できるかは
 * `taskId` から解決した施設で判定する（§19.8 / INV-32）。**ここで選んだ
 * 施設 ID を信用して開始を通す経路を作らないこと。**
 *
 * ── 翌日以降は表示のみ ──────────────────────────────────
 * §19.4「翌日以降のタスクは選択できるが、開始はできない（表示のみ）」。
 * プロトタイプは押せない形で描いているが仕様を採った（DECISIONS #042）。
 */

import { buildPropertyPicker, type PickerEntry } from "@pk/engine";
import type { TaskSummary } from "@pk/contracts";
import {
  Form,
  redirect,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { setMobilePick } from "../../lib/auth/session.js";
import { businessDateOf, localClockOf, nextBusinessDate } from "../../lib/businessDate.js";
import { createTranslator, type Locale } from "../../lib/i18n.js";
import { formatShortDate } from "../../lib/mobile/format.js";
import {
  ALL_MOBILE_PROPERTIES,
  decodePickValue,
  encodePickValue,
} from "../../lib/mobile/pick.js";
import { requireMobileContext, MOBILE_HOME_PATH } from "../../lib/mobile/session.js";
import { buildMyDayResponse } from "../../lib/task/myDay.js";
import { getEnv } from "../../lib/ui/cloudflare.js";

/** 画面が受け取る 1 行。engine の `PickerEntry` から表示に要るものだけ。 */
export interface PickRow {
  value: string;
  propertyId: string;
  propertyName: string;
  businessDate: string;
  isToday: boolean;
  isCurrent: boolean;
  taskCount: number;
  todoCount: number;
  reworkCount: number;
  plannedStartAt: string | null;
  plannedEndAt: string | null;
}

export interface SelectPropertyData {
  locale: Locale;
  displayName: string;
  businessDate: string;
  /** 当日ぶん（選んで開始できる）。 */
  today: PickRow[];
  /** 翌日ぶん（表示のみ / §19.4）。 */
  upcoming: PickRow[];
  summary: { propertyCount: number; totalTasks: number; reworkTasks: number };
  /** 既定で選ばれる値。「現在ここ」が無ければ先頭。 */
  defaultValue: string | null;
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<SelectPropertyData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant, locale, displayName } = await requireMobileContext(env, request, now);

  const businessDate = businessDateOf(now);
  const tomorrow = nextBusinessDate(businessDate);

  // **2 日ぶんだけ。** 3 日先まで出すと情報量が増える（プロトタイプ 03 Q3）。
  // 1 日 1 回しか開かない画面なので、クエリが 2 倍になることは許容する。
  const [today, next] = await Promise.all([
    buildMyDayResponse(env, tenant, session.membershipId, businessDate, now),
    buildMyDayResponse(env, tenant, session.membershipId, tomorrow, now),
  ]);

  const picker = buildPropertyPicker<TaskSummary>(
    { businessDate, groups: today.groups },
    { businessDate: tomorrow, groups: next.groups },
    localClockOf(now),
  );

  const rows = picker.entries.map(toRow);
  const todayRows = rows.filter((row) => row.isToday);

  return {
    locale,
    displayName,
    businessDate,
    today: todayRows,
    upcoming: rows.filter((row) => !row.isToday),
    summary: picker.summary,
    defaultValue:
      todayRows.find((row) => row.isCurrent)?.value ?? todayRows[0]?.value ?? null,
  };
}

/**
 * 選択を保存して一覧へ戻す。
 *
 * **保存する前に当日・翌日の一覧と突き合わせる。** 担当外の施設 ID を
 * 送られても保存しない（絞り込みが空振りするだけとはいえ、セッションに
 * 意味の無い値を残さない）。突き合わせに使うのは `buildMyDayResponse()` で、
 * これはリポジトリ層が担当施設に絞ったあとの一覧（第 1 層）。
 */
export async function action({ request, context }: ActionFunctionArgs): Promise<Response> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant, cookieValue } = await requireMobileContext(env, request, now);

  const form = await request.formData();
  const businessDateNow = businessDateOf(now);
  // 「すべての施設をまとめて表示」。**ラジオより先に見る。**
  const decoded =
    form.get("pickAll") === "1"
      ? { businessDate: businessDateNow, propertyId: ALL_MOBILE_PROPERTIES }
      : decodePickValueOf(form.get("pick"));
  // 選ばずに送られた（ラジオが 1 つも無い等）。**選択画面へ戻さない。**
  // 戻すと同じ画面が出続けるので、絞り込まないまま一覧へ進める。
  if (decoded === null) return redirect(MOBILE_HOME_PATH);

  // 当日か翌日ぶんだけを受ける（§19.4 は翌日まで）。
  const valid =
    decoded.businessDate === businessDateNow ||
    decoded.businessDate === nextBusinessDate(businessDateNow);
  if (!valid) return redirect(MOBILE_HOME_PATH);

  if (decoded.propertyId !== ALL_MOBILE_PROPERTIES) {
    const day = await buildMyDayResponse(
      env,
      tenant,
      session.membershipId,
      decoded.businessDate,
      now,
    );
    const known = day.groups.some((group) => group.property.propertyId === decoded.propertyId);
    if (!known) return redirect(MOBILE_HOME_PATH);
  }

  await setMobilePick(
    env,
    cookieValue,
    {
      propertyId: decoded.propertyId,
      businessDate: decoded.businessDate,
      // **選んだ日を残す。** 業務日が変わったら選択画面を出し直す（§19.4）。
      pickedOn: businessDateNow,
    },
    now,
  );
  return redirect(MOBILE_HOME_PATH);
}

export default function SelectPropertyRoute(): React.ReactElement {
  const data = useLoaderData<SelectPropertyData>();
  const t = createTranslator(data.locale);

  return (
    <Form method="post" className="pk-m-pick">
      <header className="pk-m-head">
        <div className="pk-m-head__row">
          <h1 className="pk-m-head__title">{t("m.pick.title")}</h1>
        </div>
        <p className="pk-m-head__sub">
          {formatShortDate(data.businessDate)}
          {data.displayName === "" ? "" : ` · ${data.displayName}`}
          {` · ${String(data.summary.propertyCount)}${t("m.today.properties")}`}
        </p>
      </header>

      {/* サマリーは 3 項目（プロトタイプ 03）。**合計時間を出さない。**
          時間の合計は「時間内に終わらせろ」という圧力として読まれる。 */}
      <div className="pk-m-pick__summary">
        <Metric value={data.summary.propertyCount} label={t("m.pick.metric.properties")} />
        <Metric value={data.summary.totalTasks} label={t("m.pick.metric.tasks")} />
        <Metric value={data.summary.reworkTasks} label={t("m.pick.metric.rework")} />
      </div>

      <main className="pk-m-pick__list">
        {data.today.length === 0 ? (
          <p className="pk-m-empty">{t("m.today.empty")}</p>
        ) : (
          <>
            <h2 className="pk-m-pick__heading">{t("m.pick.today")}</h2>
            {data.today.map((row) => (
              <PickOption
                key={row.value}
                row={row}
                t={t}
                defaultChecked={row.value === data.defaultValue}
              />
            ))}
          </>
        )}

        {/* §19.4「翌日以降のタスクは選択できるが、開始はできない」。 */}
        {data.upcoming.length === 0 ? null : (
          <>
            <h2 className="pk-m-pick__heading">{t("m.pick.upcoming")}</h2>
            {data.upcoming.map((row) => (
              <PickOption key={row.value} row={row} t={t} defaultChecked={false} />
            ))}
          </>
        )}
      </main>

      <p className="pk-m-note">{t("m.pick.hint")}</p>

      <button type="submit" className="pk-m-button pk-m-button--tall">
        {t("m.pick.submit")}
      </button>
      {/*
        絞りたくない人の逃げ道（プロトタイプ 03 Q2）。**同じ form で送る。**
        名前をラジオと分けてあるのは意図。同じ `pick` にすると、送信時に
        ラジオの値とボタンの値が両方載り、先に現れるラジオが読まれる
        （このボタンが効かなくなる）。
      */}
      <button type="submit" name="pickAll" value="1" className="pk-m-button pk-m-button--secondary">
        {t("m.pick.all")}
      </button>
    </Form>
  );
}

function Metric({ value, label }: { value: number; label: string }): React.ReactElement {
  return (
    <div className="pk-m-pick__metric">
      <span className="pk-m-pick__metricValue">{value}</span>
      <span className="pk-m-pick__metricLabel">{label}</span>
    </div>
  );
}

interface PickOptionProps {
  row: PickRow;
  t: ReturnType<typeof createTranslator>;
  defaultChecked: boolean;
}

/**
 * 選択肢 1 つ。**ラベル全体がタップ領域**（64px 以上 / P1-22 完了条件）。
 *
 * 翌日ぶんも選べる。開始できないことは一覧側（M-02）が示す（§19.4）。
 */
function PickOption({ row, t, defaultChecked }: PickOptionProps): React.ReactElement {
  return (
    <label className={row.isToday ? "pk-m-pick__item" : "pk-m-pick__item pk-m-pick__item--next"}>
      <input type="radio" name="pick" value={row.value} defaultChecked={defaultChecked} />
      <span className="pk-m-pick__body">
        <span className="pk-m-pick__name">{`🏨 ${row.propertyName}`}</span>
        <span className="pk-m-pick__meta">
          {row.isCurrent ? `${t("m.pick.here")} · ` : ""}
          {row.isToday ? "" : `${formatShortDate(row.businessDate)} · `}
          {plannedLabel(row, t)}
        </span>
      </span>
      <span className="pk-m-pick__count">
        {`${String(row.taskCount)}${t("m.today.unit.count")}`}
        {/* 内訳は 0 のとき出さない（プロトタイプ 03）。**時間の合計は出さない。** */}
        {row.todoCount === 0 ? null : (
          <span className="pk-m-pick__badge">
            {`${t("m.today.count.TODO")} ${String(row.todoCount)}`}
          </span>
        )}
        {row.reworkCount === 0 ? null : (
          <span className="pk-m-pick__badge pk-m-pick__badge--rework">
            {`${t("m.today.count.REWORK")} ${String(row.reworkCount)}`}
          </span>
        )}
      </span>
    </label>
  );
}

/** 時間帯の表示。**未設定なら「時間指定なし」**（空欄にしない）。 */
function plannedLabel(row: PickRow, t: ReturnType<typeof createTranslator>): string {
  if (row.plannedStartAt === null) return t("m.pick.noSchedule");
  if (row.plannedEndAt === null) return `${row.plannedStartAt} ${t("m.pick.from")}`;
  return `${row.plannedStartAt} – ${row.plannedEndAt}`;
}

/** フォームの値を読む。**文字列でなければ `null`。** */
function decodePickValueOf(
  raw: FormDataEntryValue | null,
): { businessDate: string; propertyId: string } | null {
  return typeof raw === "string" ? decodePickValue(raw) : null;
}

function toRow(entry: PickerEntry<TaskSummary>): PickRow {
  return {
    value: encodePickValue(entry.businessDate, entry.propertyId),
    propertyId: entry.propertyId,
    propertyName: entry.property.name,
    businessDate: entry.businessDate,
    isToday: entry.isToday,
    isCurrent: entry.isCurrent,
    taskCount: entry.taskCount,
    todoCount: entry.todoCount,
    reworkCount: entry.reworkCount,
    plannedStartAt: entry.plannedStartAt,
    plannedEndAt: entry.plannedEndAt,
  };
}
