/**
 * M-10 客室ボード（PK-SPEC-P1 §9.5）。**施設責任者がモバイルで見る盤面。**
 *
 * task:  docs/tasks/P1-15.md
 * ルール: .claude/rules/ui-writing.md §3
 *
 * ── W-03 と同じ盤面 ─────────────────────────────────────
 * 読み出しは `lib/room/board.ts`、並びは `packages/engine`、描くのは
 * `ui/RoomBoard.tsx`。**モバイル専用の並べ替えを書かないこと。**
 * PC とモバイルで部屋の順が違うと、電話で「上から 3 つ目」が通じない。
 *
 * ── 清掃スタッフはここへ来ない ──────────────────────────
 * 手動上書き（§11.2）は `room.statusOverride` が `CLEANER` を拒む。
 * 盤面そのものは `property.read` で読めるが、**担当者名は INV-06 の
 * 出し分けを通る**（`loadRoomBoard()`）。
 *
 * ── 30 秒ごとの自動更新 ─────────────────────────────────
 * ui-writing.md §3。手動更新ボタンも置く。
 */

import { HOUSEKEEPING_STATUSES, type HousekeepingStatus } from "@pk/db";
import type { BoardDisplayGroup, BoardSection } from "@pk/engine";
import { countBoardDisplayGroups } from "@pk/engine";
import {
  Form,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { businessDateOf } from "../../lib/businessDate.js";
import { createTranslator, type Locale, type MessageKey } from "../../lib/i18n.js";
import { requireMobileContext } from "../../lib/mobile/session.js";
import { listSelectableProperties, resolveSelectedScope } from "../../lib/property/selection.js";
import { loadRoomBoard, type BoardStaff } from "../../lib/room/board.js";
import { overrideRoomStatus } from "../../lib/room/status.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { useAutoRefresh } from "../../ui/mobile/useAutoRefresh.js";
import { RoomBoard } from "../../ui/RoomBoard.js";

/** 自動更新の間隔（ui-writing.md §3）。 */
const REFRESH_INTERVAL_MS = 30_000;

export interface MobileBoardData {
  locale: Locale;
  /** 表示できる施設が無ければ `null`（担当が外れた等）。 */
  propertyName: string | null;
  businessDate: string;
  counts: Record<BoardDisplayGroup, number>;
  sections: readonly BoardSection[];
  staff: readonly BoardStaff[];
  canOverride: boolean;
}

export async function loader({
  request,
  context,
}: LoaderFunctionArgs): Promise<MobileBoardData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant, locale } = await requireMobileContext(env, request, now);
  const businessDate = businessDateOf(now);

  const properties = await listSelectableProperties(env, tenant);
  const { property } = resolveSelectedScope(session.selectedPropertyId, tenant, properties);
  if (property === null) {
    return {
      locale,
      propertyName: null,
      businessDate,
      counts: { READY: 0, IN_PROGRESS: 0, DIRTY: 0, BLOCKED: 0, REWORK: 0 },
      sections: [],
      staff: [],
      canOverride: false,
    };
  }

  const board = await loadRoomBoard(env, tenant, property.id, businessDate, now);
  return {
    locale,
    propertyName: board.propertyName,
    businessDate: board.businessDate,
    counts: countBoardDisplayGroups(board.sections),
    sections: board.sections,
    staff: board.staff,
    canOverride: board.canOverride,
  };
}

interface MobileBoardActionResult {
  overridden?: boolean;
  reasonRequired?: boolean;
  invalid?: boolean;
}

export async function action({
  request,
  context,
}: ActionFunctionArgs): Promise<MobileBoardActionResult> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireMobileContext(env, request, now);

  const form = await request.formData();
  const roomId = form.get("roomId");
  const status = form.get("status");
  const reason = form.get("reason");
  if (typeof roomId !== "string" || typeof status !== "string" || typeof reason !== "string") {
    return { invalid: true };
  }
  if (!(HOUSEKEEPING_STATUSES as readonly string[]).includes(status)) return { invalid: true };

  const outcome = await overrideRoomStatus(env, tenant, {
    roomId,
    status: status as HousekeepingStatus,
    reason,
    actorId: session.membershipId,
    ip: request.headers.get("CF-Connecting-IP") ?? undefined,
  });
  if (outcome.kind === "REJECTED") return { reasonRequired: true };
  return { overridden: true };
}

export default function MobileBoardRoute(): React.ReactElement {
  const data = useLoaderData<MobileBoardData>();
  const result = useActionData<MobileBoardActionResult>();
  const t = createTranslator(data.locale);
  const { refresh, refreshing } = useAutoRefresh(REFRESH_INTERVAL_MS);

  return (
    <>
      <header className="pk-m-head">
        <div className="pk-m-head__row">
          <h1 className="pk-m-head__title">{t("board.title")}</h1>
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
          {data.propertyName === null ? data.businessDate : `${data.propertyName} · ${data.businessDate}`}
        </p>
      </header>

      {data.propertyName === null ? (
        <p className="pk-m-empty">{t("property.none")}</p>
      ) : (
        <main className="pk-m-body">
          {/* 表示区分の件数。再清掃は未着手から分けて出す（PC 盤面と同じ数え方）。 */}
          <p className="pk-board__counts">
            {`${t("board.status.READY")} ${String(data.counts.READY)} · ` +
              `${t("board.status.IN_PROGRESS")} ${String(data.counts.IN_PROGRESS)} · ` +
              `${t("board.status.DIRTY")} ${String(data.counts.DIRTY)} · ` +
              `${t("board.status.REWORK")} ${String(data.counts.REWORK)}`}
          </p>

          {result?.reasonRequired === true ? (
            <p className="pk-m-note">{t("board.override.reasonRequired")}</p>
          ) : null}
          {result?.overridden === true ? (
            <p className="pk-m-note">{t("board.override.done")}</p>
          ) : null}

          <RoomBoard
            sections={data.sections}
            staff={data.staff}
            t={t}
            renderDetailExtra={
              data.canOverride
                ? (cell) => (
                    <Form method="post" className="pk-override">
                      <input type="hidden" name="roomId" value={cell.roomId} />
                      <label htmlFor={`m-status-${cell.roomId}`}>{t("board.override.status")}</label>
                      <select
                        id={`m-status-${cell.roomId}`}
                        name="status"
                        className="pk-select"
                        defaultValue={cell.housekeepingStatus}
                      >
                        {HOUSEKEEPING_STATUSES.map((value) => (
                          <option key={value} value={value}>
                            {t(`board.housekeeping.${value}` as MessageKey)}
                          </option>
                        ))}
                      </select>
                      {/* §11.2 MUST。理由の入力を必須にする。 */}
                      <label htmlFor={`m-reason-${cell.roomId}`}>{t("board.override.reason")}</label>
                      <input id={`m-reason-${cell.roomId}`} name="reason" required />
                      <button className="pk-m-button pk-m-button--secondary" type="submit">
                        {t("board.override.submit")}
                      </button>
                    </Form>
                  )
                : undefined
            }
          />
        </main>
      )}
    </>
  );
}
