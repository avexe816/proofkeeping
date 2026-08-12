/**
 * M-02 本日のタスク（PK-SPEC-P1 §9.2）。**清掃員が最も長く見る画面。**
 *
 * task:  docs/tasks/P1-08.md
 * ルール: .claude/rules/ui-writing.md §3, §5
 * 参照:  ui-prototypes/mobile/pk-02-today-tasks.html
 *
 * ── 守っているもの ──────────────────────────────────────
 *   「開始する」は 1 タップ。**確認ダイアログを挟まない**（§9.2 / §3）
 *   タップ領域 48px 以上・主要ボタン 56px 以上・フォント 16px 以上
 *   30 秒ごとの自動更新 + 手動更新ボタン + プルダウン更新
 *   並び順は `sortTasksForBoard()`（`packages/engine`）
 *   オフラインバーは外枠（`routes/m/layout.tsx`）が常時出す
 *
 * ── 自分のタスクだけを返す ──────────────────────────────
 * `listTasks({ assigneeId })` にセッションの `membershipId` を渡す。
 * **クライアントから担当者 ID を受け取る口を作らない**（`routes/api/v1/tasks.ts`
 * の一覧と同じ方針）。他人の当日の動きが読める画面にしない（INV-07 の趣旨）。
 *
 * ── 施設のグループ表示はここに無い ──────────────────────
 * §19.3（複数施設を担当する清掃員）は **P1-21 の担当。** 1 施設ぶんの
 * 並びとして作ってある。担当が複数施設に跨る場合は見出しの施設名を伏せ、
 * 誤って別施設のタスクを開始させない側へ倒した（§19.2 の趣旨）。
 *
 * ── 楽観的更新（§8.3）──────────────────────────────────
 * 「開始する」を押したら**即座に作業中として描く。** 送信はキューが持つ。
 * キューから消えたら（届いた or 諦めた）手元の上書きを畳み、
 * サーバーの値へ戻す。「送信中です、お待ちください」で現場を止めない。
 */

import type { TaskStatusValue } from "@pk/engine";
import { countByGroup, sortTasksForBoard, TASK_GROUPS } from "@pk/engine";
import { listProperties, listRooms, listTasks } from "@pk/db";
import { useEffect, useRef, useState } from "react";
import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";

import { businessDateOf } from "../../lib/businessDate.js";
import { createTranslator, type Locale, type MessageKey } from "../../lib/i18n.js";
import { formatElapsed, formatShortDate } from "../../lib/mobile/format.js";
import { requireMobileContext } from "../../lib/mobile/session.js";
import { enqueueJson, flushQueue } from "../../lib/offline/queue.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { useAutoRefresh } from "../../ui/mobile/useAutoRefresh.js";
import { useOfflineQueue } from "../../ui/mobile/useOfflineQueue.js";

/** 自動更新の間隔（ui-writing.md §3「30 秒ごとの自動更新」）。 */
const REFRESH_INTERVAL_MS = 30_000;

/** 一覧の 1 件。**シャード番号・組織 ID・他人の名前を含めない。** */
export interface MobileTask {
  taskId: string;
  roomNumber: string;
  taskType: string;
  status: TaskStatusValue;
  priority: number;
  standardMinutes: number;
  /** 作業を始めた時刻（epoch ミリ秒）。未着手は `null`。 */
  startedAt: number | null;
}

export interface TodayData {
  locale: Locale;
  businessDate: string;
  /** 担当が 1 施設のときだけ入る。複数なら `null`（§19 は P1-21）。 */
  propertyName: string | null;
  tasks: MobileTask[];
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<TodayData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant, locale } = await requireMobileContext(env, request, now);
  const businessDate = businessDateOf(now);

  const rows = await listTasks(env, tenant, {
    businessDate,
    assigneeId: session.membershipId,
  });

  // **タスクごとに客室を引かない。** 1 回で引いて突き合わせる（§13 の
  // 「一覧 API は p95 < 300ms（100 件時）」と同じ理由）。
  const rooms = await listRooms(env, tenant, {});
  const roomById = new Map(rooms.map((room) => [room.id, room]));

  const propertyIds = new Set(rows.map((task) => task.propertyId));
  let propertyName: string | null = null;
  if (propertyIds.size === 1) {
    const properties = await listProperties(env, tenant, {});
    propertyName = properties.find((property) => propertyIds.has(property.id))?.name ?? null;
  }

  return {
    locale,
    businessDate,
    propertyName,
    tasks: rows.map((task) => ({
      taskId: task.id,
      roomNumber: roomById.get(task.roomId)?.roomNumber ?? "",
      taskType: task.taskType,
      status: task.status,
      priority: task.priority,
      standardMinutes: task.standardMinutes,
      startedAt: task.startedAt?.getTime() ?? null,
    })),
  };
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
  const [optimistic, setOptimistic] = useState<Record<string, Optimistic>>({});
  const [now, setNow] = useState(() => Date.now());

  // `refresh` は毎描画で同一性が変わりうる。effect の依存から外す。
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // 経過時間の表示は 1 秒ごと（§9.3 と同じ刻み）。
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  // キューから消えた ＝ 届いた（または諦めた）。**サーバーの値へ戻す。**
  // 畳むと同時に取り直す。取り直さないと、届いているのに未着手として
  // 描き直る瞬間ができる（現場が同じボタンをもう一度押しうる）。
  useEffect(() => {
    const kept = Object.entries(optimistic).filter(([, value]) =>
      queue.state.ids.includes(value.queueId),
    );
    if (kept.length === Object.keys(optimistic).length) return;
    setOptimistic(Object.fromEntries(kept));
    refreshRef.current();
  }, [queue.state.ids, optimistic]);

  const start = (taskId: string): void => {
    void (async () => {
      const item = await enqueueJson({ url: `/api/v1/tasks/${taskId}/start`, body: {} });
      setOptimistic((current) => ({
        ...current,
        [taskId]: { queueId: item.id, status: "IN_PROGRESS" },
      }));
      await flushQueue();
      refresh();
    })();
  };

  const tasks = sortTasksForBoard(
    data.tasks.map((task) => ({
      ...task,
      status: optimistic[task.taskId]?.status ?? task.status,
    })),
  );
  const counts = countByGroup(tasks);

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
          {formatShortDate(data.businessDate)}
          {data.propertyName === null ? "" : ` · ${data.propertyName}`}
        </p>
      </header>

      <div className="pk-m-counts">
        {TASK_GROUPS.map((group) => (
          <div key={group} className="pk-m-counts__cell">
            <div className="pk-m-counts__value">{counts[group]}</div>
            <div className="pk-m-counts__label">{t(`m.today.count.${group}` as MessageKey)}</div>
          </div>
        ))}
      </div>

      <main className="pk-m-list">
        {tasks.length === 0 ? (
          <p className="pk-m-empty">{t("m.today.empty")}</p>
        ) : (
          tasks.map((task) => (
            <TaskCard
              key={task.taskId}
              task={task}
              t={t}
              now={now}
              pending={optimistic[task.taskId] !== undefined}
              onStart={() => {
                start(task.taskId);
              }}
            />
          ))
        )}
      </main>
    </>
  );
}

interface TaskCardProps {
  task: MobileTask;
  t: ReturnType<typeof createTranslator>;
  now: number;
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
 */
function TaskCard({ task, t, now, pending, onStart }: TaskCardProps): React.ReactElement {
  const isTodo = task.status === "CREATED" || task.status === "ASSIGNED";
  const isRunning = task.status === "IN_PROGRESS";
  const isPaused = task.status === "PAUSED";
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

      {/* **確認ダイアログを挟まない**（§9.2）。1 タップで開始する。 */}
      {isTodo ? (
        <button type="button" className="pk-m-button" onClick={onStart}>
          {t("m.task.start")}
        </button>
      ) : (
        <Link className="pk-m-button pk-m-button--secondary" to={`/m/task/${task.taskId}`}>
          {isRunning || isPaused ? t("m.task.resume") : t("m.task.open")}
        </Link>
      )}
    </article>
  );
}
