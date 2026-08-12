/**
 * M-02 本日のタスク（PK-SPEC-P1 §9.2 / §19.3）。**清掃員が最も長く見る画面。**
 *
 * task:  docs/tasks/P1-08.md（単一施設）/ docs/tasks/P1-21.md（施設グループ）
 * ルール: .claude/rules/ui-writing.md §3, §5
 * 参照:  ui-prototypes/mobile/pk-02-today-tasks.html
 *
 * ── 守っているもの ──────────────────────────────────────
 *   「開始する」は 1 タップ。**確認ダイアログを挟まない**（§9.2 / §3）
 *   ただし**施設が変わるときだけ 1 回**確認する（§19.8 MUST / P1-23）
 *   タップ領域 48px 以上・主要ボタン 56px 以上・フォント 16px 以上
 *   30 秒ごとの自動更新 + 手動更新ボタン + プルダウン更新
 *   並び順とグループ化は `buildMyDay()`（`packages/engine`）
 *   オフラインバーは外枠（`routes/m/layout.tsx`）が常時出す
 *
 * ── 「施設を切り替える」概念を持たせない（§19.2 MUST）───
 * 施設セレクタを置かない。**施設ごとにグループ化した 1 本のリスト**が既定。
 * 4 施設以上のときに起動時へ挟む選択画面（§19.4 / P1-22）は
 * 表示を絞るだけで、この画面の構造は変えない。
 *
 * ── 自分のタスクだけを返す ──────────────────────────────
 * `buildMyDayResponse()` にセッションの `membershipId` を渡す。
 * **クライアントから担当者 ID を受け取る口を作らない。**
 * 他人の当日の動きが読める画面にしない（INV-07 の趣旨）。
 *
 * ── オフライン（§19.7 MUST）─────────────────────────────
 * loader の値で最初に描き、そのあとクライアントが `my-day` を取り直して
 * IndexedDB へ 1 日単位で保存する。取得に失敗したらキャッシュへ落ち、
 * **取得時刻を画面上部に明示する。** 施設ごとにキャッシュを分けない。
 *
 * ── 楽観的更新（§8.3）──────────────────────────────────
 * 「開始する」を押したら**即座に作業中として描く。** 送信はキューが持つ。
 * キューから消えたら（届いた or 諦めた）手元の上書きを畳み、
 * サーバーの値へ戻す。「送信中です、お待ちください」で現場を止めない。
 */

import type { MyDayGroup, MyDayResponse, TaskSummary } from "@pk/contracts";
import type { MyDayFilter, TaskStatusValue } from "@pk/engine";
import { useEffect, useRef, useState } from "react";
import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";

import { businessDateOf } from "../../lib/businessDate.js";
import { createTranslator, type Locale, type MessageKey } from "../../lib/i18n.js";
import { formatElapsed, formatShortDate } from "../../lib/mobile/format.js";
import { requireMobileContext } from "../../lib/mobile/session.js";
import { fetchMyDay, readCachedMyDay } from "../../lib/offline/myDayCache.js";
import { enqueueJson, flushQueue } from "../../lib/offline/queue.js";
import { buildMyDayResponse } from "../../lib/task/myDay.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { useAutoRefresh } from "../../ui/mobile/useAutoRefresh.js";
import { useOfflineQueue } from "../../ui/mobile/useOfflineQueue.js";

/** 自動更新の間隔（ui-writing.md §3「30 秒ごとの自動更新」）。 */
const REFRESH_INTERVAL_MS = 30_000;

export interface TodayData {
  locale: Locale;
  /** サーバー側で組み立てた初回ぶん。**API の応答と同じ形**（§19.7）。 */
  day: MyDayResponse;
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<TodayData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant, locale } = await requireMobileContext(env, request, now);

  const day = await buildMyDayResponse(
    env,
    tenant,
    session.membershipId,
    businessDateOf(now),
    now,
  );
  return { locale, day };
}

/** 楽観的更新の 1 件。キューの id が消えたら畳む。 */
interface Optimistic {
  queueId: string;
  status: TaskStatusValue;
}

export default function TodayRoute(): React.ReactElement {
  const data = useLoaderData<TodayData>();
  const t = createTranslator(data.locale);
  const { refresh, refreshing } = useAutoRefresh(REFRESH_INTERVAL_MS);
  const queue = useOfflineQueue();

  const [day, setDay] = useState<MyDayResponse>(data.day);
  /** キャッシュから描いているか（§19.7 の「取得時刻を明示」）。 */
  const [fromCache, setFromCache] = useState(false);
  const [filter, setFilter] = useState<MyDayFilter>("ALL");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [optimistic, setOptimistic] = useState<Record<string, Optimistic>>({});
  const [now, setNow] = useState(() => Date.now());

  // loader が取り直したら（プルダウン・30 秒）手元も入れ替える。
  useEffect(() => {
    setDay(data.day);
    setFromCache(false);
  }, [data.day]);

  // 取得 → 失敗したらキャッシュ（§19.7）。**loader とは別に走る。**
  // オフラインで開いた場合、loader 自体が届かないので画面ごと出ない。
  // その状態から復帰したときに、ここが最後の一覧を出す。
  useEffect(() => {
    // 後片付けの合図。**ローカルの `let` フラグにしないこと。**
    // closure で書き換わることを型検査は見ておらず、`false` に絞られた
    // ぶん `no-unnecessary-condition` が判定を「常に偽」として落とす。
    const abort = new AbortController();
    void (async () => {
      const fetched = await fetchMyDay(data.day.businessDate);
      if (isAborted(abort)) return;
      if (fetched !== null) {
        setDay(fetched);
        setFromCache(false);
        return;
      }
      const cached = await readCachedMyDay(data.day.businessDate);
      if (isAborted(abort) || cached === null) return;
      setDay(cached);
      setFromCache(true);
    })();
    return () => {
      abort.abort();
    };
  }, [data.day.businessDate, queue.offline]);

  // 経過時間の表示は 1 秒ごと（§9.3 と同じ刻み）。
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  // `refresh` は毎描画で同一性が変わりうる。effect の依存から外す。
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // キューから消えた ＝ 届いた（または諦めた）。**サーバーの値へ戻す。**
  useEffect(() => {
    const kept = Object.entries(optimistic).filter(([, value]) =>
      queue.state.ids.includes(value.queueId),
    );
    if (kept.length === Object.keys(optimistic).length) return;
    setOptimistic(Object.fromEntries(kept));
    refreshRef.current();
  }, [queue.state.ids, optimistic]);

  const start = (task: TaskSummary): void => {
    void (async () => {
      const item = await enqueueJson({ url: `/api/v1/tasks/${task.taskId}/start`, body: {} });
      setOptimistic((current) => ({
        ...current,
        [task.taskId]: { queueId: item.id, status: "IN_PROGRESS" },
      }));
      await flushQueue();
      refresh();
    })();
  };

  const view = viewOf(day, filter, optimistic);

  return (
    <>
      <header className="pk-m-head">
        <div className="pk-m-head__row">
          <h1 className="pk-m-head__title">{t("m.today.title")}</h1>
          <button
            type="button"
            className="pk-m-head__refresh"
            onClick={refresh}
            aria-label={t("m.today.refresh")}
            aria-busy={refreshing}
          >
            ↻
          </button>
        </div>
        <p className="pk-m-head__sub">
          {formatShortDate(day.businessDate)}
          {` · ${String(view.totalTasks)}${t("m.today.unit.count")}`}
        </p>

        {/* §19.3 の「🏢 N施設を担当」。**1 施設なら出さない。**
            切替の入口ではなく、今日の担当範囲を示す表示（§19.2）。 */}
        {day.propertyCount >= 2 ? (
          <p className="pk-m-head__properties">
            {`🏢 ${String(day.propertyCount)}${t("m.today.properties")}`}
          </p>
        ) : null}

        {/* §19.7 MUST。オフラインで保存された一覧を出しているときだけ。 */}
        {fromCache ? (
          <p className="pk-m-head__cached">
            {t("m.today.cached")}
            {` · ${t("m.today.fetchedAt")} ${formatClock(day.fetchedAt)}`}
          </p>
        ) : null}
      </header>

      {/* フィルタは全施設をまたいで適用する（§19.3 MUST）。
          件数は絞る前の値を出す。押した結果でボタンの数字が動かない。 */}
      <div className="pk-m-filters" role="group">
        <FilterButton
          current={filter}
          value="ALL"
          label={`${t("m.today.filter.all")} ${String(day.totalTasks)}`}
          onSelect={setFilter}
        />
        <FilterButton
          current={filter}
          value="TODO"
          label={`${t("m.today.filter.todo")} ${String(day.summary.todo)}`}
          onSelect={setFilter}
        />
        <FilterButton
          current={filter}
          value="DONE"
          label={`${t("m.today.filter.done")} ${String(day.summary.done)}`}
          onSelect={setFilter}
        />
      </div>

      <main className="pk-m-list">
        {view.groups.length === 0 ? (
          <p className="pk-m-empty">
            {filter === "ALL" ? t("m.today.empty") : t("m.today.filtered.empty")}
          </p>
        ) : (
          view.groups.map((group, index) => (
            <PropertyGroup
              key={group.property.propertyId}
              group={group}
              t={t}
              now={now}
              /* §19.3「完了した施設は自動で折りたたむ」。**利用者が開いたら
                 そちらを優先する。** 自動判断で開いた状態を閉じ直さない。 */
              collapsed={collapsed[group.property.propertyId] ?? group.allDone}
              onToggle={() => {
                setCollapsed((current) => ({
                  ...current,
                  [group.property.propertyId]:
                    !(current[group.property.propertyId] ?? group.allDone),
                }));
              }}
              /* 直前のグループと施設が違えば、開始時に 1 回だけ確認する
                 （§19.8 MUST）。同一施設内の連続タスクでは出さない。 */
              previousPropertyName={index === 0 ? null : (view.groups[index - 1]?.property.name ?? null)}
              optimistic={optimistic}
              onStart={start}
            />
          ))
        )}
      </main>
    </>
  );
}

/**
 * 楽観的更新を載せてから絞り込む。
 *
 * **順序が意味を持つ。** 先に絞ると、いま「開始」を押したタスクが
 * 未着手フィルタから即座に消え、押した本人の画面から行が飛ぶ。
 */
function viewOf(
  day: MyDayResponse,
  filter: MyDayFilter,
  optimistic: Record<string, Optimistic>,
): MyDayResponse {
  const applied: MyDayResponse = {
    ...day,
    groups: day.groups.map((group) => ({
      ...group,
      tasks: group.tasks.map((task) => ({
        ...task,
        status: optimistic[task.taskId]?.status ?? task.status,
      })),
    })),
  };
  if (filter === "ALL") return applied;

  const keep = (status: TaskSummary["status"]): boolean =>
    filter === "TODO"
      ? status === "CREATED" || status === "ASSIGNED"
      : status === "COMPLETED" || status === "AWAITING_INSPECTION";

  const kept = applied.groups
    .map((group) => {
      const tasks = group.tasks.filter((task) => keep(task.status));
      return { ...group, tasks, taskCount: tasks.length };
    })
    .filter((group) => group.tasks.length > 0);

  return {
    ...applied,
    groups: kept.map((group, index) => ({
      ...group,
      sequence: index + 1,
      // 絞った結果として最後になったグループの移動時間を落とす。
      travelMinutesToNext: index === kept.length - 1 ? null : group.travelMinutesToNext,
    })),
    totalTasks: kept.reduce((sum, group) => sum + group.taskCount, 0),
    propertyCount: kept.length,
  };
}

/**
 * 画面から離れたか。**関数にしてあるのは意図。**
 *
 * `abort.signal.aborted` を直に 2 回書くと、1 回目の判定で型が `false` に
 * 絞られたまま `await` を跨いでも戻らず、2 回目が「常に偽」として
 * lint に落とされる。呼び出しの戻り値は絞られない。
 */
function isAborted(controller: AbortController): boolean {
  return controller.signal.aborted;
}

/** `fetchedAt`（epoch ミリ秒）を `HH:MM` にする。**端末の時計で描く。** */
function formatClock(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

interface FilterButtonProps {
  current: MyDayFilter;
  value: MyDayFilter;
  label: string;
  onSelect: (value: MyDayFilter) => void;
}

function FilterButton({ current, value, label, onSelect }: FilterButtonProps): React.ReactElement {
  return (
    <button
      type="button"
      className={value === current ? "pk-m-filters__item pk-m-filters__item--on" : "pk-m-filters__item"}
      aria-pressed={value === current}
      onClick={() => {
        onSelect(value);
      }}
    >
      {label}
    </button>
  );
}

interface PropertyGroupProps {
  group: MyDayGroup;
  t: ReturnType<typeof createTranslator>;
  now: number;
  collapsed: boolean;
  onToggle: () => void;
  previousPropertyName: string | null;
  optimistic: Record<string, Optimistic>;
  onStart: (task: TaskSummary) => void;
}

/**
 * 施設 1 つぶん（§19.3）。
 *
 * ── 移動ブロックはグループの**前**に置く ────────────────
 * 仕様の図では施設ヘッダの手前に「🚃 移動 · 約25分」が入る。
 * `travelMinutesToNext` は**前のグループ**が持つので、ここでは
 * 「自分が 2 番目以降なら移動ブロックを描く」形にはできない
 * （前のグループの値が要る）。親が並べる順序で解決している。
 */
function PropertyGroup({
  group,
  t,
  now,
  collapsed,
  onToggle,
  previousPropertyName,
  optimistic,
  onStart,
}: PropertyGroupProps): React.ReactElement {
  return (
    <section className="pk-m-group">
      <button
        type="button"
        className="pk-m-group__head"
        onClick={onToggle}
        aria-expanded={!collapsed}
      >
        <span className="pk-m-group__name">{`🏨 ${group.property.name}`}</span>
        <span className="pk-m-group__count">
          {`${String(group.taskCount)}${t("m.today.unit.count")}`}
        </span>
        <span className="pk-m-group__toggle" aria-hidden="true">
          {collapsed ? "▸" : "▾"}
        </span>
      </button>

      {group.plannedStartAt === null ? null : (
        <p className="pk-m-group__planned">
          {group.plannedEndAt === null
            ? group.plannedStartAt
            : `${group.plannedStartAt} – ${group.plannedEndAt}`}
        </p>
      )}

      {collapsed
        ? null
        : group.tasks.map((task) => (
            <TaskCard
              key={task.taskId}
              task={task}
              t={t}
              now={now}
              propertyName={group.property.name}
              previousPropertyName={previousPropertyName}
              pending={optimistic[task.taskId] !== undefined}
              onStart={() => {
                onStart(task);
              }}
            />
          ))}

      {/* 施設間の移動ブロック（§19.3）。**時間が未設定なら「移動」だけ。** */}
      {group.travelMinutesToNext === null ? null : (
        <p className="pk-m-travel">
          {`🚃 ${t("m.today.travel")} · ${String(group.travelMinutesToNext)}${t("m.today.travel.minutes")}`}
        </p>
      )}
    </section>
  );
}

interface TaskCardProps {
  task: TaskSummary;
  t: ReturnType<typeof createTranslator>;
  now: number;
  propertyName: string;
  previousPropertyName: string | null;
  pending: boolean;
  onStart: () => void;
}

/**
 * 一覧の 1 枚。
 *
 * ── 経過は「開始してからの時計」──────────────────────────
 * 中断を差し引いた実作業時間は時間ログからしか出せず、**一覧で引くと
 * タスクの数だけクエリが増える**（§13）。ここは開始時刻からの経過を
 * 出し、正確な実作業時間は M-03（詳細）で出す。ラベルも「経過」にして
 * あるので、表示と意味は食い違わない。
 *
 * ── 施設が変わるときだけ確認する（§19.8 MUST）──────────
 * 直前のグループと施設が違うタスクの開始で、**1 回だけ**確認を出す。
 * 同一施設内の連続タスクでは出さない（§9.2 の 1 タップ開始を維持）。
 */
function TaskCard({
  task,
  t,
  now,
  propertyName,
  previousPropertyName,
  pending,
  onStart,
}: TaskCardProps): React.ReactElement {
  const [confirming, setConfirming] = useState(false);
  const isTodo = task.status === "CREATED" || task.status === "ASSIGNED";
  const isRunning = task.status === "IN_PROGRESS";
  const isPaused = task.status === "PAUSED";
  const needsConfirm =
    previousPropertyName !== null && previousPropertyName !== propertyName;

  const group =
    isRunning || isPaused
      ? "IN_PROGRESS"
      : task.status === "REWORK"
        ? "REWORK"
        : task.status === "BLOCKED"
          ? "BLOCKED"
          : isTodo
            ? "TODO"
            : "DONE";

  return (
    <article className={`pk-m-card pk-m-card--${group}`}>
      <div className="pk-m-card__row">
        <span className="pk-m-card__room">{task.roomNumber}</span>
        <span className="pk-m-card__tag">{t(`m.status.${task.status}` as MessageKey)}</span>
      </div>
      <p className="pk-m-card__meta">
        {t(`m.taskType.${task.taskType}` as MessageKey)}
        {isRunning && task.startedAt !== null
          ? ` · ${t("m.task.elapsed")} ${formatElapsed(now - task.startedAt)}`
          : ` · ${t("m.task.standard")} ${String(task.standardMinutes)}${t("m.task.minutes")}`}
        {pending ? ` · ${t("m.task.pending")}` : ""}
      </p>

      {isTodo ? (
        confirming ? (
          // §19.8 の確認。**施設名を必ず含める。** 部屋番号だけを出さない。
          <div className="pk-m-confirm" role="group">
            <p className="pk-m-confirm__text">
              {`${previousPropertyName ?? ""} → ${propertyName} ${task.roomNumber}`}
            </p>
            <button
              type="button"
              className="pk-m-button pk-m-button--secondary"
              onClick={() => {
                setConfirming(false);
              }}
            >
              {t("m.task.cancel")}
            </button>
            <button
              type="button"
              className="pk-m-button"
              onClick={() => {
                setConfirming(false);
                onStart();
              }}
            >
              {t("m.task.start")}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="pk-m-button"
            onClick={() => {
              if (needsConfirm) setConfirming(true);
              else onStart();
            }}
          >
            {t("m.task.start")}
          </button>
        )
      ) : (
        <Link className="pk-m-button pk-m-button--secondary" to={`/m/task/${task.taskId}`}>
          {isRunning || isPaused ? t("m.task.resume") : t("m.task.open")}
        </Link>
      )}
    </article>
  );
}
