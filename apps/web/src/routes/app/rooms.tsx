import { NotFoundError, createRooms, listRooms, recordAudit, updateRoom } from "@pk/db";
import { Form, useActionData, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";

import { t } from "../../lib/i18n.js";
import { assertPermission } from "../../lib/auth/permission.js";
import { listSelectableProperties, resolveSelectedScope } from "../../lib/property/selection.js";
import {
  expandRoomRange,
  parseExcludedNumbers,
  parseRoomCsv,
} from "../../lib/room/bulk.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

/**
 * 客室マスタ 方式A（PK-SPEC-P0 §24.2 / §24.3）。
 *
 *   /app/settings/rooms
 *
 * task: docs/tasks/P0-22.md
 *
 * ── 物理削除の経路を作らない ────────────────────────────
 * §26 の絶対ルール。無効化（`isActive = false`）だけ。`action` に
 * `delete` を足さないこと。
 *
 * ── 清掃専用の場所は別セクション ────────────────────────
 * §24.3。`isSellable = false` を客室と混ぜて数えない。
 *
 * ── 部屋番号の変更は旧番号を監査ログへ ──────────────────
 * §24.5。`recordAudit()` の `before` に旧番号を入れる。
 * リポジトリ層は監査ログを書かないので、ここで書く（P0-07 の方針）。
 */

/**
 * `FormData` から文字列だけを取り出す。
 *
 * `get()` は `File` も返しうる。**`String()` で潰さない**
 * （`[object File]` が部屋番号として保存される）。
 */
function fieldOf(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

interface RoomsData {
  propertyId: string | null;
  sellable: readonly { id: string; roomNumber: string; note: string | null }[];
  nonSellable: readonly { id: string; roomNumber: string; note: string | null }[];
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<RoomsData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  const properties = await listSelectableProperties(env, tenant);
  const { property } = resolveSelectedScope(session.selectedPropertyId, tenant, properties);
  if (property === null) return { propertyId: null, sellable: [], nonSellable: [] };

  assertPermission(tenant, "property.read", { kind: "PROPERTY", propertyIds: [property.id] });

  const rows = await listRooms(env, tenant, { propertyId: property.id, isActive: true });
  const shape = (row: (typeof rows)[number]) => ({
    id: row.id,
    roomNumber: row.roomNumber,
    note: row.note,
  });

  return {
    propertyId: property.id,
    sellable: rows.filter((row) => row.isSellable).map(shape),
    nonSellable: rows.filter((row) => !row.isSellable).map(shape),
  };
}

/** 操作の結果。**件数を必ず返す**（§24.2「スキップ件数を表示する」）。 */
interface RoomsActionResult {
  created?: number;
  skipped?: number;
  rejectedRows?: number;
  invalid?: boolean;
}

export async function action({ request, context }: ActionFunctionArgs): Promise<RoomsActionResult> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  const properties = await listSelectableProperties(env, tenant);
  const { property } = resolveSelectedScope(session.selectedPropertyId, tenant, properties);
  if (property === null) throw new NotFoundError();

  assertPermission(tenant, "property.write", { kind: "PROPERTY", propertyIds: [property.id] });

  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "range") {
    const range = expandRoomRange({
      from: Number(fieldOf(form, "from")),
      to: Number(fieldOf(form, "to")),
      exclude: parseExcludedNumbers(fieldOf(form, "exclude")),
    });
    if (!range.ok) return { invalid: true };

    const result = await createRooms(
      env,
      tenant,
      range.roomNumbers.map((roomNumber, index) => ({
        propertyId: property.id,
        roomNumber,
        sortOrder: index,
      })),
    );
    await recordAudit(env, tenant, {
      actorId: session.membershipId,
      action: "room.created",
      targetType: "room",
      propertyId: property.id,
      after: { created: result.created, skipped: result.skipped },
    });
    return { created: result.created, skipped: result.skipped };
  }

  if (intent === "csv") {
    const parsed = parseRoomCsv(fieldOf(form, "csv"));
    const result = await createRooms(
      env,
      tenant,
      parsed.rows.map((row) => ({
        propertyId: property.id,
        roomNumber: row.roomNumber,
        // §24.2 の例で清掃専用の場所は PANTRY という客室タイプで表される。
        // 客室タイプのマスタが解決できるまでは、その 1 語だけを見る。
        isSellable: row.roomTypeCode !== "PANTRY",
        sourceType: "CSV" as const,
        note: row.note ?? undefined,
      })),
    );
    await recordAudit(env, tenant, {
      actorId: session.membershipId,
      action: "room.created",
      targetType: "room",
      propertyId: property.id,
      after: { created: result.created, skipped: result.skipped },
    });
    return {
      created: result.created,
      skipped: result.skipped,
      rejectedRows: parsed.rejected.length,
    };
  }

  if (intent === "rename") {
    const roomId = fieldOf(form, "roomId");
    const roomNumber = fieldOf(form, "roomNumber");
    const previous = fieldOf(form, "previousRoomNumber");
    if (roomId === "" || roomNumber === "") return { invalid: true };

    await updateRoom(env, tenant, roomId, { roomNumber });
    // §24.5: 旧番号を残す。証跡の追跡可能性のため。
    await recordAudit(env, tenant, {
      actorId: session.membershipId,
      action: "room.updated",
      targetType: "room",
      targetId: roomId,
      propertyId: property.id,
      before: { roomNumber: previous },
      after: { roomNumber },
    });
    return {};
  }

  if (intent === "deactivate") {
    const roomId = fieldOf(form, "roomId");
    if (roomId === "") return { invalid: true };

    await updateRoom(env, tenant, roomId, { isActive: false });
    await recordAudit(env, tenant, {
      actorId: session.membershipId,
      action: "room.deactivated",
      targetType: "room",
      targetId: roomId,
      propertyId: property.id,
    });
    return {};
  }

  return { invalid: true };
}

export default function Rooms() {
  const data = useLoaderData<RoomsData>();
  const result = useActionData<RoomsActionResult>();

  return (
    <section className="pk-page">
      <h1 className="pk-page__title">{t("room.title")}</h1>

      {result?.invalid === true ? <p className="pk-notice">{t("room.bulk.invalid")}</p> : null}
      {result?.created === undefined ? null : (
        <p className="pk-notice">
          {`${t("room.bulk.result.created")}: ${String(result.created)} / ` +
            `${t("room.bulk.result.skipped")}: ${String(result.skipped ?? 0)}`}
        </p>
      )}
      {result?.rejectedRows === undefined || result.rejectedRows === 0 ? null : (
        <p className="pk-notice">
          {`${t("room.csv.invalidRows")}: ${String(result.rejectedRows)}`}
        </p>
      )}

      <Form method="post" className="pk-form">
        <input type="hidden" name="intent" value="range" />
        <h2>{t("room.bulk.title")}</h2>
        <label htmlFor="from">{t("room.bulk.from")}</label>
        <input id="from" name="from" inputMode="numeric" required />
        <label htmlFor="to">{t("room.bulk.to")}</label>
        <input id="to" name="to" inputMode="numeric" required />
        <label htmlFor="exclude">{t("room.bulk.exclude")}</label>
        <input id="exclude" name="exclude" placeholder={t("room.bulk.exclude.hint")} />
        <button className="pk-button" type="submit">
          {t("room.bulk.submit")}
        </button>
      </Form>

      <Form method="post" className="pk-form">
        <input type="hidden" name="intent" value="csv" />
        <h2>{t("room.csv.title")}</h2>
        <label htmlFor="csv">{t("room.csv.hint")}</label>
        <textarea id="csv" name="csv" rows={6} required />
        <button className="pk-button" type="submit">
          {t("room.csv.submit")}
        </button>
      </Form>

      <h2>{`${t("room.section.sellable")}（${t("room.count.sellable")}: ${String(data.sellable.length)}）`}</h2>
      <ul className="pk-room-list">
        {data.sellable.map((room) => (
          <li key={room.id}>{room.roomNumber}</li>
        ))}
      </ul>

      <h2>{t("room.section.nonSellable")}</h2>
      <ul className="pk-room-list pk-room-list--nonSellable">
        {data.nonSellable.map((room) => (
          <li key={room.id}>{room.roomNumber}</li>
        ))}
      </ul>
    </section>
  );
}
