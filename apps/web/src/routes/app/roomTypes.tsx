import {
  NotFoundError,
  countRoomsByRoomType,
  createRoomType,
  findRoomTypeById,
  listRoomTypes,
  recordAudit,
  updateRoomType,
} from "@pk/db";
import { roomTypeCodeSchema } from "@pk/contracts";
import {
  Form,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { assertPermission, can, propertyTarget } from "../../lib/auth/permission.js";
import { t } from "../../lib/i18n.js";
import { listSelectableProperties, resolveSelectedScope } from "../../lib/property/selection.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

/**
 * W-25 客室タイプ管理（PK-SPEC-P0 §24.3 / §24.5）。
 *
 *   /app/settings/room-types
 *
 * task: docs/tasks/P1-24.md
 *
 * ── なぜ独立の画面なのか ────────────────────────────────
 * `/app/settings/rooms`（P0-22）の中に節を足す案もあった。分けたのは、
 * 客室タイプが**客室とは別の一意制約を持つマスタ**で、W-16（チェックリストの
 * 第 3 階層）と W-17（標準時間の行）が客室ではなくこちらを参照するため。
 * docs/DECISIONS.md #054。
 *
 * ── 物理削除の経路を作らない ────────────────────────────
 * CLAUDE.md §4。無効化（`isActive = false`）だけ。**`intent` に
 * `delete` を足さないこと。** `standardTime` と `checklistTemplate` が
 * この ID を参照している。
 *
 * ── 無効化は割当客室数を先に見せる ──────────────────────
 * §24.5。`rooms.tsx` の `confirmDeactivate` と同じ形。**客室のタイプを
 * 自動で外さない。** 件数を提示して明示操作を求めるところまで。
 *
 * ── リポジトリを直接呼ぶ ────────────────────────────────
 * PC 管理画面の方針（docs/DECISIONS.md #049）。`/api/v1/room-types` は
 * 実装してあるが画面は通らない。**そのため `assertPermission()` を
 * loader と action の両方で呼ぶ。** middleware の権限判定に頼れない。
 */

/** 画面に出す 1 件。 */
interface RoomTypeRow {
  roomTypeId: string;
  code: string;
  name: string;
  bedCount: number | null;
  capacity: number | null;
  sortOrder: number;
  isActive: boolean;
  /** 割り当てられた有効な客室の数（§24.5 の提示に使う）。 */
  roomCount: number;
}

interface RoomTypesData {
  propertyId: string | null;
  propertyName: string | null;
  rows: readonly RoomTypeRow[];
  canWrite: boolean;
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<RoomTypesData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  const properties = await listSelectableProperties(env, tenant);
  const { property } = resolveSelectedScope(session.selectedPropertyId, tenant, properties);
  if (property === null) {
    return { propertyId: null, propertyName: null, rows: [], canWrite: false };
  }

  assertPermission(tenant, "property.read", propertyTarget([property.id]));

  // **無効化済みも並べる**（`{}` は「絞らない」）。取り消せない無効化を作らない。
  const [types, roomCounts] = await Promise.all([
    listRoomTypes(env, tenant, property.id, {}),
    countRoomsByRoomType(env, tenant, property.id),
  ]);

  return {
    propertyId: property.id,
    propertyName: property.name,
    rows: types.map((type) => ({
      roomTypeId: type.id,
      code: type.code,
      name: type.name,
      bedCount: type.bedCount,
      capacity: type.capacity,
      sortOrder: type.sortOrder,
      isActive: type.isActive,
      roomCount: roomCounts.get(type.id) ?? 0,
    })),
    // 読めるが書けないロール（`AUDITOR`）に入力欄を出さないため。
    // **これは権限制御ではない**（action 側の `assertPermission` が守る）。
    canWrite: can(tenant, "property.write", propertyTarget([property.id])),
  };
}

interface RoomTypesActionResult {
  created?: boolean;
  updated?: boolean;
  /** コードが既に使われている（`uq_room_type_property_code`）。 */
  duplicateCode?: string;
  invalid?: boolean;
  /**
   * 無効化の確認待ち（§24.5）。**`0` を返さない。**
   * 客室が 1 室も無ければ確認を挟まず無効化する。
   */
  confirmDeactivate?: { roomTypeId: string; name: string; roomCount: number };
}

/**
 * `FormData` から文字列だけを取り出す。`get()` は `File` も返しうる
 * （`rooms.tsx` と同じ理由。`String()` で潰さない）。
 */
function fieldOf(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * 数値欄。空欄は `null`（未入力）。**`0` を `null` に落とさない。**
 * ベッドの無い場所（`PANTRY`）は 0 が正しい値で、未入力とは別物。
 */
function numberOf(form: FormData, name: string): number | null {
  const raw = fieldOf(form, name).trim();
  if (raw === "") return null;
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

export async function action({
  request,
  context,
}: ActionFunctionArgs): Promise<RoomTypesActionResult> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  const properties = await listSelectableProperties(env, tenant);
  const { property } = resolveSelectedScope(session.selectedPropertyId, tenant, properties);
  if (property === null) throw new NotFoundError();

  assertPermission(tenant, "property.write", propertyTarget([property.id]));

  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "create") {
    const code = roomTypeCodeSchema.safeParse(fieldOf(form, "code"));
    const name = fieldOf(form, "name").trim();
    if (!code.success || name === "") return { invalid: true };

    const bedCount = numberOf(form, "bedCount");
    const capacity = numberOf(form, "capacity");
    const result = await createRoomType(env, tenant, {
      propertyId: property.id,
      code: code.data,
      name,
      ...(bedCount === null ? {} : { bedCount }),
      ...(capacity === null ? {} : { capacity }),
    });
    // 重複はエラーにせず、どのコードがぶつかったかを画面に返す。
    if (!result.created) return { duplicateCode: code.data };

    await recordAudit(env, tenant, {
      actorId: session.membershipId,
      action: "property.created",
      targetType: "roomType",
      targetId: result.id,
      propertyId: property.id,
      after: { code: code.data, name, bedCount, capacity },
    });
    return { created: true };
  }

  if (intent === "update" || intent === "deactivate" || intent === "reactivate") {
    const roomTypeId = fieldOf(form, "roomTypeId");
    if (roomTypeId === "") return { invalid: true };

    // **フォームの `roomTypeId` をそのまま信用しない。** 越境 ID は
    // `findRoomTypeById()` が DB へ行く前に落とす（→ 404）。
    const before = await findRoomTypeById(env, tenant, roomTypeId);
    if (before === undefined || before.propertyId !== property.id) throw new NotFoundError();

    if (intent === "deactivate") {
      // §24.5 MUST: 割り当てられた客室の件数を先に伝える。
      // **客室のタイプを自動で外さない。**
      const roomCounts = await countRoomsByRoomType(env, tenant, property.id);
      const roomCount = roomCounts.get(roomTypeId) ?? 0;
      if (roomCount > 0 && fieldOf(form, "confirm") !== "yes") {
        return { confirmDeactivate: { roomTypeId, name: before.name, roomCount } };
      }

      await updateRoomType(env, tenant, roomTypeId, { isActive: false });
      await recordAudit(env, tenant, {
        actorId: session.membershipId,
        action: "property.updated",
        targetType: "roomType",
        targetId: roomTypeId,
        propertyId: property.id,
        before: { isActive: true },
        // 何室を抱えたまま無効にしたかを残す。あとで「タイプの無い客室が
        // 増えた」事象を追えるようにするため（`rooms.tsx` と同じ向き）。
        after: { isActive: false, roomCount },
      });
      return { updated: true };
    }

    if (intent === "reactivate") {
      await updateRoomType(env, tenant, roomTypeId, { isActive: true });
      await recordAudit(env, tenant, {
        actorId: session.membershipId,
        action: "property.updated",
        targetType: "roomType",
        targetId: roomTypeId,
        propertyId: property.id,
        before: { isActive: false },
        after: { isActive: true },
      });
      return { updated: true };
    }

    const name = fieldOf(form, "name").trim();
    if (name === "") return { invalid: true };
    const bedCount = numberOf(form, "bedCount");
    const capacity = numberOf(form, "capacity");
    const sortOrder = numberOf(form, "sortOrder");

    await updateRoomType(env, tenant, roomTypeId, {
      name,
      bedCount,
      capacity,
      ...(sortOrder === null ? {} : { sortOrder }),
    });
    await recordAudit(env, tenant, {
      actorId: session.membershipId,
      action: "property.updated",
      targetType: "roomType",
      targetId: roomTypeId,
      propertyId: property.id,
      before: {
        name: before.name,
        bedCount: before.bedCount,
        capacity: before.capacity,
        sortOrder: before.sortOrder,
      },
      after: { name, bedCount, capacity, sortOrder },
    });
    return { updated: true };
  }

  return { invalid: true };
}

export default function RoomTypes() {
  const data = useLoaderData<RoomTypesData>();
  const result = useActionData<RoomTypesActionResult>();

  if (data.propertyId === null) {
    return (
      <section className="pk-page">
        <div className="pk-pagehead">
          <h1 className="pk-pagehead__title">{t("roomType.title")}</h1>
        </div>
        <p className="pk-notice">{t("roomType.noProperty")}</p>
      </section>
    );
  }

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <div>
          <h1 className="pk-pagehead__title">{t("roomType.title")}</h1>
          <p className="pk-pagehead__sub">{data.propertyName}</p>
        </div>
      </div>
      <p className="pk-notice">{t("roomType.scopeNotice")}</p>

      {result?.invalid === true ? <p className="pk-notice">{t("roomType.invalid")}</p> : null}
      {result?.duplicateCode === undefined ? null : (
        <p className="pk-notice pk-notice--warn">
          {`${t("roomType.duplicateCode")}: ${result.duplicateCode}`}
        </p>
      )}
      {result?.created === true ? <p className="pk-notice">{t("roomType.created")}</p> : null}
      {result?.updated === true ? <p className="pk-notice">{t("roomType.updated")}</p> : null}

      {/* §24.5: 件数を提示して明示操作を求める。客室のタイプは外さない。 */}
      {result?.confirmDeactivate === undefined ? null : (
        <div className="pk-notice pk-notice--warn">
          <p>{t("roomType.deactivate.assignedRooms")}</p>
          <p>
            {`${result.confirmDeactivate.name} — ` +
              `${t("roomType.deactivate.roomCount")}: ${String(result.confirmDeactivate.roomCount)}`}
          </p>
          <p>{t("roomType.deactivate.notice")}</p>
          <p>{t("roomType.deactivate.confirm")}</p>
          <Form method="post">
            <input type="hidden" name="intent" value="deactivate" />
            <input type="hidden" name="roomTypeId" value={result.confirmDeactivate.roomTypeId} />
            <input type="hidden" name="confirm" value="yes" />
            <button className="pk-button" type="submit">
              {t("roomType.deactivate.submit")}
            </button>
          </Form>
        </div>
      )}

      {data.canWrite ? (
        <Form method="post" className="pk-form">
          <input type="hidden" name="intent" value="create" />
          <h2>{t("roomType.create.title")}</h2>
          <label htmlFor="code">{t("roomType.code")}</label>
          <input id="code" name="code" required placeholder={t("roomType.code.hint")} />
          <label htmlFor="name">{t("roomType.name")}</label>
          <input id="name" name="name" required />
          <label htmlFor="bedCount">{t("roomType.bedCount")}</label>
          <input id="bedCount" name="bedCount" inputMode="numeric" />
          <label htmlFor="capacity">{t("roomType.capacity")}</label>
          <input id="capacity" name="capacity" inputMode="numeric" />
          <button className="pk-button pk-button--primary" type="submit">
            {t("roomType.create.submit")}
          </button>
        </Form>
      ) : null}

      {data.rows.length === 0 ? (
        <p className="pk-notice">{t("roomType.empty")}</p>
      ) : (
        <table className="pk-grid">
          <thead>
            <tr>
              <th>{t("roomType.code")}</th>
              <th>{t("roomType.name")}</th>
              <th>{t("roomType.bedCount")}</th>
              <th>{t("roomType.capacity")}</th>
              <th>{t("roomType.sortOrder")}</th>
              <th>{t("roomType.roomCount")}</th>
              <th>{t("roomType.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.roomTypeId} className={row.isActive ? undefined : "pk-row--muted"}>
                <th scope="row">
                  {row.code}
                  {row.isActive ? null : <span className="pk-badge">{t("roomType.inactive")}</span>}
                </th>
                {data.canWrite ? (
                  <EditableCells row={row} />
                ) : (
                  <>
                    <td>{row.name}</td>
                    <td>{row.bedCount === null ? "—" : String(row.bedCount)}</td>
                    <td>{row.capacity === null ? "—" : String(row.capacity)}</td>
                    <td>{String(row.sortOrder)}</td>
                  </>
                )}
                <td>{String(row.roomCount)}</td>
                <td>
                  {data.canWrite ? (
                    <Form method="post" className="pk-inline">
                      <input
                        type="hidden"
                        name="intent"
                        value={row.isActive ? "deactivate" : "reactivate"}
                      />
                      <input type="hidden" name="roomTypeId" value={row.roomTypeId} />
                      <button className="pk-button" type="submit">
                        {row.isActive ? t("roomType.deactivate") : t("roomType.reactivate")}
                      </button>
                    </Form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * 編集できる 4 セル。**`code` は編集できない。**
 *
 * CSV 取込と外部連携（P6）が突き合わせる鍵で、変えると過去の取込が
 * 別のタイプを指す（`updateRoomType()` の注記）。打ち間違えたら
 * 無効化して作り直す。
 */
function EditableCells({ row }: { row: RoomTypeRow }) {
  return (
    <>
      <td>
        <Form method="post" className="pk-inline" id={`edit-${row.roomTypeId}`}>
          <input type="hidden" name="intent" value="update" />
          <input type="hidden" name="roomTypeId" value={row.roomTypeId} />
          <input name="name" aria-label={t("roomType.name")} defaultValue={row.name} required />
        </Form>
      </td>
      <td>
        <input
          form={`edit-${row.roomTypeId}`}
          name="bedCount"
          aria-label={t("roomType.bedCount")}
          inputMode="numeric"
          defaultValue={row.bedCount === null ? "" : String(row.bedCount)}
        />
      </td>
      <td>
        <input
          form={`edit-${row.roomTypeId}`}
          name="capacity"
          aria-label={t("roomType.capacity")}
          inputMode="numeric"
          defaultValue={row.capacity === null ? "" : String(row.capacity)}
        />
      </td>
      <td>
        <input
          form={`edit-${row.roomTypeId}`}
          name="sortOrder"
          aria-label={t("roomType.sortOrder")}
          inputMode="numeric"
          defaultValue={String(row.sortOrder)}
        />
        <button form={`edit-${row.roomTypeId}`} className="pk-button" type="submit">
          {t("roomType.save")}
        </button>
      </td>
    </>
  );
}
