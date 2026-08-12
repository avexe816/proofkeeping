import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { HOUSEKEEPING_STATUSES, NotFoundError, type HousekeepingStatus } from "@pk/db";
import type { BoardSection, RoomBoardGroup } from "@pk/engine";
import { Form, useActionData, useLoaderData } from "react-router";

import { businessDateOf } from "../../lib/businessDate.js";
import { t, type MessageKey } from "../../lib/i18n.js";
import { switchProperty } from "../../lib/property/selection.js";
import { loadRoomBoard, type BoardStaff } from "../../lib/room/board.js";
import { overrideRoomStatus } from "../../lib/room/status.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";
import { RoomBoard } from "../../ui/RoomBoard.js";

/**
 * W-03 客室ボード（PK-SPEC-P1 §9.5 / §10.1）。
 *
 *   /app/p/{propertyId}/board
 *
 * task: docs/tasks/P0-21.md（URL と選択状態）→ docs/tasks/P1-15.md（盤面）
 *
 * ── URL を正とする ──────────────────────────────────────
 * PK-SPEC-P0 §23.5 MUST。URL の `propertyId` とセッションの選択が違えば
 * **URL 側へセッションを寄せる。** ブックマークと共有が成立するのは
 * この向きだけ。P0-21 が置いたこの性質は変えない。
 *
 * ── 手動上書きは理由必須 ────────────────────────────────
 * §11.2。理由を書かずに送ると `REASON_REQUIRED` で戻る。
 * 成功した上書きは `AuditLog` に `room.statusOverridden` として残り、
 * **P4 の検出ルール R010 が使う。**
 */

interface BoardData {
  propertyId: string;
  propertyName: string;
  businessDate: string;
  counts: Record<RoomBoardGroup, number>;
  sections: readonly BoardSection[];
  staff: readonly BoardStaff[];
  canOverride: boolean;
}

export async function loader({ request, params, context }: LoaderFunctionArgs): Promise<BoardData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant, cookieValue } = await requireAppContext(env, request, now);

  const propertyId = params["propertyId"];
  if (propertyId === undefined) throw new NotFoundError();

  // 到達できない施設なら `NotFoundError`（middleware が 404 に写す / INV-31）。
  await switchProperty(env, tenant, cookieValue, propertyId, now, session.membershipId);

  const businessDate = new URL(request.url).searchParams.get("date") ?? businessDateOf(now);
  const board = await loadRoomBoard(env, tenant, propertyId, businessDate, now);
  return {
    propertyId: board.propertyId,
    propertyName: board.propertyName,
    businessDate: board.businessDate,
    counts: board.counts,
    sections: board.sections,
    staff: board.staff,
    canOverride: board.canOverride,
  };
}

interface BoardActionResult {
  overridden?: boolean;
  reasonRequired?: boolean;
  invalid?: boolean;
}

export async function action({
  request,
  context,
}: ActionFunctionArgs): Promise<BoardActionResult> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

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

export default function PropertyBoard(): React.ReactElement {
  const data = useLoaderData<BoardData>();
  const result = useActionData<BoardActionResult>();

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("nav.board")}</h1>
        <p className="pk-muted">{`${data.propertyName} · ${data.businessDate}`}</p>
      </div>

      <p className="pk-board__counts">
        {`${t("board.status.READY")} ${String(data.counts.READY)} · ` +
          `${t("board.status.IN_PROGRESS")} ${String(data.counts.IN_PROGRESS)} · ` +
          `${t("board.status.DIRTY")} ${String(data.counts.DIRTY)} · ` +
          `${t("board.status.BLOCKED")} ${String(data.counts.BLOCKED)}`}
      </p>

      {result?.reasonRequired === true ? (
        <p className="pk-notice pk-notice--warn">{t("board.override.reasonRequired")}</p>
      ) : null}
      {result?.overridden === true ? (
        <p className="pk-notice">{t("board.override.done")}</p>
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
                  <label htmlFor={`status-${cell.roomId}`}>{t("board.override.status")}</label>
                  <select
                    id={`status-${cell.roomId}`}
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
                  {/* §11.2 MUST。**理由の入力を必須にする。** */}
                  <label htmlFor={`reason-${cell.roomId}`}>{t("board.override.reason")}</label>
                  <input id={`reason-${cell.roomId}`} name="reason" required />
                  <button className="pk-button" type="submit">
                    {t("board.override.submit")}
                  </button>
                </Form>
              )
            : undefined
        }
      />
    </section>
  );
}
