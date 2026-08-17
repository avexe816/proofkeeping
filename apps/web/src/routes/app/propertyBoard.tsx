import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  HOUSEKEEPING_STATUSES,
  NotFoundError,
  listFindings,
  type HousekeepingStatus,
} from "@pk/db";
import type { BoardDisplayGroup, BoardSection } from "@pk/engine";
import { BOARD_DISPLAY_GROUPS, countBoardDisplayGroups } from "@pk/engine";
import { Form, useActionData, useLoaderData } from "react-router";

import { can, propertyTarget } from "../../lib/auth/permission.js";
import { businessDateOf } from "../../lib/businessDate.js";
import { t, type MessageKey } from "../../lib/i18n.js";
import { switchProperty } from "../../lib/property/selection.js";
import { loadRoomBoard, type BoardStaff } from "../../lib/room/board.js";
import { overrideRoomStatus } from "../../lib/room/status.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";
import { BOARD_MARKS, RoomBoard } from "../../ui/RoomBoard.js";

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
  /** 表示区分の件数（プロトタイプ owner 03 の KPI 5 枚）。 */
  counts: Record<BoardDisplayGroup, number>;
  sections: readonly BoardSection[];
  staff: readonly BoardStaff[];
  canOverride: boolean;
  /**
   * 稼働の差異（未確認）のある客室 ID。**`finding.read` を持たない相手には
   * `null`**（ドットも凡例の項目も出ない / security.md §1）。
   */
  findingRoomIds: readonly string[] | null;
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

  // プロトタイプの「● 稼働の差異あり」。**未確認（OPEN / REVIEWING）だけ。**
  // 確認が済んだ差異にドットを残すと、対応済みの客室が要対応に見え続ける。
  // 差異を読めないロールには件数も存在も渡さない（凡例ごと出ない）。
  const findingRoomIds = can(tenant, "finding.read", propertyTarget([propertyId]))
    ? [
        ...new Set(
          (
            await listFindings(env, tenant, {
              propertyId,
              businessDate,
              status: ["OPEN", "REVIEWING"],
            })
          ).map((finding) => finding.roomId),
        ),
      ]
    : null;

  return {
    propertyId: board.propertyId,
    propertyName: board.propertyName,
    businessDate: board.businessDate,
    counts: countBoardDisplayGroups(board.sections),
    sections: board.sections,
    staff: board.staff,
    canOverride: board.canOverride,
    findingRoomIds,
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

      {/* 表示区分の件数カード（プロトタイプ owner 03 の KPI 5 枚）。 */}
      <dl className="pk-stats pk-stats--board">
        {BOARD_DISPLAY_GROUPS.map((group) => (
          <div key={group} className={`pk-stats__item pk-stats__item--${group}`}>
            <dt>{`${BOARD_MARKS[group]} ${t(`board.status.${group}` as MessageKey)}`}</dt>
            <dd>{String(data.counts[group])}</dd>
          </div>
        ))}
      </dl>

      {result?.reasonRequired === true ? (
        <p className="pk-notice pk-notice--warn">{t("board.override.reasonRequired")}</p>
      ) : null}
      {result?.overridden === true ? (
        <p className="pk-notice">{t("board.override.done")}</p>
      ) : null}

      {/* プロトタイプの「客室の状態」カードの見出しとヒント。 */}
      <h2 className="pk-section__title">{t("board.legend.title")}</h2>
      <p className="pk-muted">{t("board.legend.hint")}</p>

      <RoomBoard
        sections={data.sections}
        staff={data.staff}
        t={t}
        findingRoomIds={data.findingRoomIds === null ? undefined : new Set(data.findingRoomIds)}
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
