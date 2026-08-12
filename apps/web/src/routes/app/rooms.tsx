import {
  NotFoundError,
  OPEN_TASK_STATUSES,
  createRooms,
  findRoomById,
  listRoomTypes,
  listRooms,
  listTasks,
  recordAudit,
  updateRoom,
} from "@pk/db";
import { Form, useActionData, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";

import { t } from "../../lib/i18n.js";
import { assertPermission } from "../../lib/auth/permission.js";
import { listSelectableProperties, resolveSelectedScope } from "../../lib/property/selection.js";
import {
  expandRoomRange,
  parseExcludedNumbers,
  parseRoomCsv,
} from "../../lib/room/bulk.js";
import { buildRoomTypeIndex, resolveRoomTypeCodes } from "../../lib/room/roomTypes.js";
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
 *
 * ── 無効化は未完了タスクの件数を先に見せる ──────────────
 * §24.5 MUST。**未完了タスクを自動キャンセルしない。** 件数を提示して
 * 明示操作を求めるところまでがこの画面の責務で、タスクをどうするかは
 * W-04（`/app/p/:propertyId/tasks`）で決める。同じボタンに
 * 「まとめて取消す」を足さないこと（P0-22 は P1 のタスク表を待っていた）。
 *
 * ── 客室タイプ（P1-24 で追加）────────────────────────────
 * CSV の `room_type_code` を客室タイプのマスタと突き合わせる。
 * **マスタに無いコードで取込全体を落とさない**（§24.2 の「エラーにしない」）。
 * 未設定として取り込み、コードを画面へ返す。
 *
 * `PANTRY` を `isSellable = false` に写す既存の扱いは**変えていない。**
 * マスタに `PANTRY` を登録していない施設でも、清掃専用の場所の判定は
 * 従来どおり効く必要がある（突き合わせの成否と結びつけない）。
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

/** 一覧の 1 行。`roomTypeId` は付け替えの `select` の初期値に使う。 */
interface RoomRow {
  id: string;
  roomNumber: string;
  note: string | null;
  roomTypeId: string | null;
}

/** 付け替えの選択肢。**有効な客室タイプだけ**（無効化したものを選ばせない）。 */
interface RoomTypeChoice {
  id: string;
  code: string;
  name: string;
}

interface RoomsData {
  propertyId: string | null;
  sellable: readonly RoomRow[];
  nonSellable: readonly RoomRow[];
  roomTypes: readonly RoomTypeChoice[];
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<RoomsData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  const properties = await listSelectableProperties(env, tenant);
  const { property } = resolveSelectedScope(session.selectedPropertyId, tenant, properties);
  if (property === null) {
    return { propertyId: null, sellable: [], nonSellable: [], roomTypes: [] };
  }

  assertPermission(tenant, "property.read", { kind: "PROPERTY", propertyIds: [property.id] });

  // 客室タイプは**有効なものだけ**（既定の絞り込み）。無効化したタイプを
  // 付け替えの選択肢に戻すと、無効化した意味が消える。
  const [rows, roomTypes] = await Promise.all([
    listRooms(env, tenant, { propertyId: property.id, isActive: true }),
    listRoomTypes(env, tenant, property.id),
  ]);
  const shape = (row: (typeof rows)[number]): RoomRow => ({
    id: row.id,
    roomNumber: row.roomNumber,
    note: row.note,
    roomTypeId: row.roomTypeId,
  });

  return {
    propertyId: property.id,
    sellable: rows.filter((row) => row.isSellable).map(shape),
    nonSellable: rows.filter((row) => !row.isSellable).map(shape),
    roomTypes: roomTypes.map((type) => ({ id: type.id, code: type.code, name: type.name })),
  };
}

/** 操作の結果。**件数を必ず返す**（§24.2「スキップ件数を表示する」）。 */
interface RoomsActionResult {
  created?: number;
  skipped?: number;
  rejectedRows?: number;
  invalid?: boolean;
  /**
   * CSV にあってマスタに無かった客室タイプのコード（P1-24）。
   *
   * **件数ではなくコードそのものを返す。** 何を登録すればよいのかが
   * 分からないと、取り込み直す判断ができない。
   */
  unknownRoomTypeCodes?: readonly string[];
  /**
   * 無効化の確認待ち（§24.5）。未完了タスクを抱えた客室。
   *
   * **`0` を返さない。** 未完了が無ければ確認を挟まず無効化する。
   */
  confirmDeactivate?: { roomId: string; roomNumber: string; openTasks: number };
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

    // P1-24: `room_type_code` を客室タイプのマスタと突き合わせる。
    // **マスタに無いコードは未設定として取り込む**（§24.2 の「エラーにしない」）。
    const roomTypes = await listRoomTypes(env, tenant, property.id);
    const resolved = resolveRoomTypeCodes(parsed.rows, buildRoomTypeIndex(roomTypes));

    const result = await createRooms(
      env,
      tenant,
      parsed.rows.map((row, index) => {
        const roomTypeId = resolved.rows[index]?.roomTypeId;
        return {
          propertyId: property.id,
          roomNumber: row.roomNumber,
          // §24.2 の例で清掃専用の場所は PANTRY という客室タイプで表される。
          // **突き合わせの成否と結びつけない。** マスタに PANTRY を登録して
          // いない施設でも、清掃専用の場所の判定は効く必要がある。
          isSellable: row.roomTypeCode !== "PANTRY",
          ...(roomTypeId === undefined ? {} : { roomTypeId }),
          sourceType: "CSV" as const,
          note: row.note ?? undefined,
        };
      }),
    );
    await recordAudit(env, tenant, {
      actorId: session.membershipId,
      action: "room.created",
      targetType: "room",
      propertyId: property.id,
      after: {
        created: result.created,
        skipped: result.skipped,
        unknownRoomTypeCodes: resolved.unknownCodes,
      },
    });
    return {
      created: result.created,
      skipped: result.skipped,
      rejectedRows: parsed.rejected.length,
      unknownRoomTypeCodes: resolved.unknownCodes,
    };
  }

  // P1-24: 客室タイプの付け替え。W-05 のタイプ列を埋める経路。
  if (intent === "assignRoomType") {
    const roomId = fieldOf(form, "roomId");
    const raw = fieldOf(form, "roomTypeId");
    if (roomId === "") return { invalid: true };

    // **フォームの `roomTypeId` をそのまま信用しない。** その施設の
    // 有効な客室タイプに限る（W-17 の `buildMatrix()` と同じ向き / INV-32）。
    const roomTypes = await listRoomTypes(env, tenant, property.id);
    const roomTypeId = roomTypes.some((type) => type.id === raw) ? raw : null;
    if (raw !== "" && roomTypeId === null) return { invalid: true };

    const before = await findRoomById(env, tenant, roomId);
    if (before === undefined || before.propertyId !== property.id) throw new NotFoundError();

    await updateRoom(env, tenant, roomId, { roomTypeId });
    await recordAudit(env, tenant, {
      actorId: session.membershipId,
      action: "room.updated",
      targetType: "room",
      targetId: roomId,
      propertyId: property.id,
      before: { roomTypeId: before.roomTypeId },
      after: { roomTypeId },
    });
    return {};
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

    // §24.5 MUST: 未完了タスクがあることを先に伝える。**自動キャンセルしない。**
    // `listTasks()` は業務日で絞らない（明日以降に立っているタスクも
    // 客室が無効になれば行き先を失う）。
    const openTasks = await listTasks(env, tenant, {
      propertyId: property.id,
      roomId,
      status: OPEN_TASK_STATUSES,
    });
    if (openTasks.length > 0 && fieldOf(form, "confirm") !== "yes") {
      return {
        confirmDeactivate: {
          roomId,
          roomNumber: fieldOf(form, "roomNumber"),
          openTasks: openTasks.length,
        },
      };
    }

    await updateRoom(env, tenant, roomId, { isActive: false });
    await recordAudit(env, tenant, {
      actorId: session.membershipId,
      action: "room.deactivated",
      targetType: "room",
      targetId: roomId,
      propertyId: property.id,
      // 何件を抱えたまま無効化したかを残す。あとで「タスクが宙に浮いた」
      // 事象を追えるようにするため。
      after: { openTasks: openTasks.length },
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
      {/* P1-24: どのコードが未登録だったかを出す。件数だけでは直せない。 */}
      {result?.unknownRoomTypeCodes === undefined ||
      result.unknownRoomTypeCodes.length === 0 ? null : (
        <p className="pk-notice pk-notice--warn">
          {`${t("room.csv.unknownRoomTypes")} ${result.unknownRoomTypeCodes.join(" / ")}`}
        </p>
      )}

      {/* §24.5: 件数を提示して明示操作を求める。タスクは取消さない。 */}
      {result?.confirmDeactivate === undefined ? null : (
        <div className="pk-notice pk-notice--warn">
          <p>{t("room.deactivate.pendingTasks")}</p>
          <p>
            {`${result.confirmDeactivate.roomNumber} — ` +
              `${t("room.deactivate.openTasks")}: ${String(result.confirmDeactivate.openTasks)}`}
          </p>
          <p>{t("room.deactivate.notice")}</p>
          <p>{t("room.deactivate.confirm")}</p>
          <Form method="post">
            <input type="hidden" name="intent" value="deactivate" />
            <input type="hidden" name="roomId" value={result.confirmDeactivate.roomId} />
            <input type="hidden" name="roomNumber" value={result.confirmDeactivate.roomNumber} />
            <input type="hidden" name="confirm" value="yes" />
            <button className="pk-button" type="submit">
              {t("room.deactivate.submit")}
            </button>
          </Form>
        </div>
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

      {/* P1-24: 客室タイプが 1 件も無いと付け替えができない。行き先を示す。 */}
      {data.roomTypes.length === 0 ? (
        <p className="pk-notice">{t("room.type.noneRegistered")}</p>
      ) : null}

      <h2>{`${t("room.section.sellable")}（${t("room.count.sellable")}: ${String(data.sellable.length)}）`}</h2>
      <ul className="pk-room-list">
        {data.sellable.map((room) => (
          <li key={room.id}>
            {room.roomNumber}
            <RoomTypePicker room={room} roomTypes={data.roomTypes} />
            <DeactivateButton roomId={room.id} roomNumber={room.roomNumber} />
          </li>
        ))}
      </ul>

      <h2>{t("room.section.nonSellable")}</h2>
      <ul className="pk-room-list pk-room-list--nonSellable">
        {data.nonSellable.map((room) => (
          <li key={room.id}>
            {room.roomNumber}
            <RoomTypePicker room={room} roomTypes={data.roomTypes} />
            <DeactivateButton roomId={room.id} roomNumber={room.roomNumber} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * 客室タイプの付け替え（P1-24）。**W-05 のタイプ列を埋める経路。**
 *
 * 選択肢に「未設定」を残す。客室タイプを決めずに部屋番号だけ登録するのは
 * 正常な使い方で、一度付けたら外せない状態にしない。
 *
 * 選んだ時点で送る（保存ボタンを置かない）。100 室の付け替えで
 * 1 行ごとにボタンを押させると、現場の設定作業として重い。
 */
function RoomTypePicker({
  room,
  roomTypes,
}: {
  room: RoomRow;
  roomTypes: readonly RoomTypeChoice[];
}) {
  if (roomTypes.length === 0) return null;

  return (
    <Form method="post" className="pk-inline">
      <input type="hidden" name="intent" value="assignRoomType" />
      <input type="hidden" name="roomId" value={room.id} />
      <select
        name="roomTypeId"
        aria-label={t("room.type.assign")}
        defaultValue={room.roomTypeId ?? ""}
        // JS が無い環境でも `submit` で送れるよう、ボタンも残す。
        onChange={(event) => event.currentTarget.form?.requestSubmit()}
      >
        <option value="">{t("room.type.unset")}</option>
        {roomTypes.map((type) => (
          <option key={type.id} value={type.id}>
            {`${type.name}（${type.code}）`}
          </option>
        ))}
      </select>
      <button className="pk-button" type="submit">
        {t("room.type.assign")}
      </button>
    </Form>
  );
}

/**
 * 無効化のボタン。**「削除」ではない**（§26 の絶対ルール）。
 *
 * 1 回目の送信では未完了タスクの件数を返しうる（§24.5）。
 */
function DeactivateButton({ roomId, roomNumber }: { roomId: string; roomNumber: string }) {
  return (
    <Form method="post" className="pk-inline">
      <input type="hidden" name="intent" value="deactivate" />
      <input type="hidden" name="roomId" value={roomId} />
      <input type="hidden" name="roomNumber" value={roomNumber} />
      <button className="pk-button" type="submit">
        {t("room.deactivate")}
      </button>
    </Form>
  );
}
