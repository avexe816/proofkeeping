/**
 * M-08 検査待ち一覧（PK-SPEC-P2 §11.2 / §5.2 / §5.3）。
 *
 * task:  docs/tasks/P2-05.md
 * ルール: .claude/rules/ui-writing.md §3
 *
 * ── 守っているもの ──────────────────────────────────────
 *   並びは §11.2 の 4 段（`sortInspectionQueue()` が決める）
 *   SLA 超過はオレンジ、チェックイン期限だけが赤（§5.2 / ui-writing.md §3）
 *   **清掃担当者の名前を出さない**（名前が検査の判断に効く / OPEN_QUESTIONS #046）
 *   30 秒ごとの自動更新と手動更新ボタン（ui-writing.md §3）
 *   「検査する」は 1 タップ。**確認ダイアログを挟まない**
 *
 * ── 「検査する」だけは確認を挟まない ────────────────────
 * 押すと `POST /tasks/:id/inspection/start` が走り、成功したら M-09 へ。
 * **オフラインキューへ入れない。** 検査の開始は排他制御（`InspectionLock`）を
 * 伴うので、後からまとめて送ると「既に別の人が始めていた」が遅れて分かる。
 * 通信が無いときは押しても始まらないことを、その場で伝える。
 */

import type {
  InspectionDetailResponse,
  InspectionWaitingItem,
  InspectionWaitingResponse,
} from "@pk/contracts";
import { useCallback, useEffect, useState } from "react";
import { useLoaderData, useNavigate, type LoaderFunctionArgs } from "react-router";

import { assertPermission, propertyTarget } from "../../lib/auth/permission.js";
import { businessDateOf } from "../../lib/businessDate.js";
import { buildWaitingList } from "../../lib/inspection/waiting.js";
import { createTranslator, type Locale, type MessageKey } from "../../lib/i18n.js";
import { requireMobileContext } from "../../lib/mobile/session.js";
import { listSelectableProperties, resolveSelectedScope } from "../../lib/property/selection.js";
import { getEnv } from "../../lib/ui/cloudflare.js";

/** 自動更新の間隔（ui-writing.md §3「30 秒ごとの自動更新」）。 */
const REFRESH_INTERVAL_MS = 30_000;

export interface InspectionsData {
  locale: Locale;
  businessDate: string;
  propertyId: string | null;
  summary: { total: number; urgent: number; overSla: number; recheck: number };
  items: InspectionWaitingItem[];
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<InspectionsData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant, locale } = await requireMobileContext(env, request, now);
  const businessDate = businessDateOf(now);

  // 表示中の施設（M-10 と同じ解決）。**検査は施設の作業**なので、
  // 全社ビュー・担当施設なしでは一覧を出さない。
  const properties = await listSelectableProperties(env, tenant);
  const { property } = resolveSelectedScope(session.selectedPropertyId, tenant, properties);
  if (property === null) {
    return {
      locale,
      businessDate,
      propertyId: null,
      summary: { total: 0, urgent: 0, overSla: 0, recheck: 0 },
      items: [],
    };
  }

  // 画面はリポジトリを直接呼ぶ（DECISIONS #049）。**loader でも権限を判定する。**
  // `CLEANER` はここで 404 になる（`inspection.read` が DENY / P2-04）。
  assertPermission(tenant, "inspection.read", propertyTarget([property.id]));

  const waiting = await buildWaitingList(env, tenant, property.id, businessDate, now);
  return {
    locale,
    businessDate,
    propertyId: property.id,
    summary: waiting.summary,
    items: waiting.data,
  };
}

export default function InspectionsRoute(): React.ReactElement {
  const data = useLoaderData<InspectionsData>();
  const t = createTranslator(data.locale);
  const navigate = useNavigate();

  const [items, setItems] = useState(data.items);
  const [summary, setSummary] = useState(data.summary);
  /** 開始中のタスク。二度押しで 2 回 POST しないため。 */
  const [starting, setStarting] = useState<string | null>(null);
  /** 開始に失敗した理由コード。**文言は i18n で出す。** */
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    setItems(data.items);
    setSummary(data.summary);
  }, [data.items, data.summary]);

  const refresh = useCallback(async (): Promise<void> => {
    if (data.propertyId === null) return;
    try {
      const response = await fetch(
        `/api/v1/inspections/waiting?propertyId=${encodeURIComponent(data.propertyId)}` +
          `&businessDate=${data.businessDate}`,
      );
      if (!response.ok) return;
      const body = await response.json<InspectionWaitingResponse>();
      setItems(body.data);
      setSummary(body.summary);
    } catch {
      // 通信できないだけ。**画面は最後に取れた一覧のまま**（ui-writing.md §5）。
    }
  }, [data.propertyId, data.businessDate]);

  useEffect(() => {
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [refresh]);

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
        await refresh();
      } catch {
        setFailure("OFFLINE");
      } finally {
        setStarting(null);
      }
    })();
  };

  return (
    <>
      <header className="pk-m-head">
        <div className="pk-m-head__row">
          <h1 className="pk-m-head__title">{t("m.inspections.title")}</h1>
          <span className="pk-m-head__count">{summary.total}</span>
          <button
            type="button"
            className="pk-m-head__refresh"
            onClick={() => void refresh()}
            aria-label={t("m.inspections.refresh")}
          >
            ⟳
          </button>
        </div>
        <p className="pk-m-head__sub">
          {t("m.inspections.urgent")} {summary.urgent} · {t("m.inspections.overSla")}{" "}
          {summary.overSla} · {t("m.inspections.recheck")} {summary.recheck}
        </p>
      </header>

      <main className="pk-m-list">
        {failure === null ? null : (
          <p className="pk-m-alert" role="status">
            {t(startFailureKey(failure))}
          </p>
        )}

        {data.propertyId === null ? (
          <p className="pk-m-empty">{t("m.inspections.noProperty")}</p>
        ) : items.length === 0 ? (
          <p className="pk-m-empty">{t("m.inspections.empty")}</p>
        ) : (
          items.map((item) => (
            <article key={item.taskId} className={`pk-m-card pk-m-card--${item.tone}`}>
              <div className="pk-m-card__row">
                <span className="pk-m-card__room">{item.roomNumber}</span>
                {item.isRecheck ? (
                  <span className="pk-m-card__tag">
                    {t("m.inspections.round")} {item.nextRound}
                  </span>
                ) : null}
              </div>

              <p className="pk-m-card__meta">{waitLabel(item, t)}</p>

              <button
                type="button"
                className="pk-m-button"
                disabled={starting !== null}
                onClick={() => {
                  start(item.taskId);
                }}
              >
                {starting === item.taskId
                  ? t("m.inspections.starting")
                  : t("m.inspections.start")}
              </button>
            </article>
          ))
        )}
      </main>
    </>
  );
}

/** 待ち時間・チェックインまでの残りの 1 行（§11.2 のワイヤー）。 */
function waitLabel(item: InspectionWaitingItem, t: (key: MessageKey) => string): string {
  const minutes = t("m.inspections.minutes");
  if (item.minutesToCheckIn !== null && item.tone === "URGENT") {
    return `${t("m.inspections.checkInIn")} ${String(item.minutesToCheckIn)}${minutes}`;
  }
  const waited = `${t("m.inspections.waited")} ${String(item.waitedMinutes)}${minutes}`;
  // 目安を添えるのは超過しているときだけ。**平常時に締切を見せて急かさない。**
  return item.isOverSla
    ? `${waited}（${t("m.inspections.slaGuide")} ${String(item.slaMinutes)}${minutes}）`
    : waited;
}

/** 開始に失敗したときの文言キー。**未知のコードは一般的な文言へ落とす。** */
function startFailureKey(error: string): MessageKey {
  const known: Record<string, MessageKey> = {
    INSPECTION_ALREADY_STARTED: "m.inspections.error.alreadyStarted",
    SELF_INSPECTION_FORBIDDEN: "m.inspections.error.selfForbidden",
    INVALID_TRANSITION: "m.inspections.error.notWaiting",
    OFFLINE: "m.inspections.error.offline",
  };
  return known[error] ?? "m.inspections.error.generic";
}
