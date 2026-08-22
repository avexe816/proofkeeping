import {
  NotFoundError,
  countRoomsByRoomType,
  createRoomType,
  findRoomTypeById,
  listRoomTypes,
  listStandardTimes,
  recordAudit,
  updateRoomType,
  upsertStandardTimes,
} from "@pk/db";
import { roomTypeCodeSchema } from "@pk/contracts";
import {
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { assertPermission, can, propertyTarget } from "../../lib/auth/permission.js";
import { t, type MessageKey } from "../../lib/i18n.js";
import { listSelectableProperties, resolveSelectedScope } from "../../lib/property/selection.js";
import {
  EDITABLE_TASK_TYPES,
  MINUTES_MAX,
  MINUTES_MIN,
  buildMatrix,
  fieldName,
  toInputs,
  type MatrixRow,
} from "../../lib/standardTime/matrix.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

/**
 * W-25 客室タイプ管理 ＋ W-17 標準時間設定（PK-SPEC-P0 §24.3・§24.5 /
 * PK-SPEC-P1 §3.1・§10.1）。
 *
 *   /app/settings/room-types
 *
 * task: docs/tasks/P1-24.md（客室タイプ）/ docs/tasks/P1-02.md（標準時間）
 *
 * ── 2 枚を 1 枚にした（人間の指示 2026-08-22）────────────
 * 標準時間は `/app/settings/standard-times` という別画面だった。
 * **表の行が客室タイプそのもの**で、列が作業種別というだけの画面で、
 * 客室タイプを 1 つ足すたびに設定へ戻って別の画面を開き直す必要があった。
 * 目安時間は客室タイプの属性なので、**同じ画面の 2 枚目のカード**にした。
 * 旧 URL は `standardTimes.tsx` がここへ 301 で送る。
 *
 * ── 権限は 2 系統のまま ─────────────────────────────────
 * 画面が 1 枚になっても門は混ぜない（security.md §1）。
 *
 *   客室タイプ … `property.read` / `property.write`（`PROPERTY_MANAGER` も可）
 *   標準時間   … `standardTime.read` / `standardTime.write`（`ORG_ADMIN` 以上）
 *
 * **`PROPERTY_MANAGER` に目安時間のカードを出さない。** 読めない相手には
 * loader が引かない（戻り値＝HTML に載る JSON に残さない）。
 *
 * ── 一覧とレイヤー（`staff.tsx` と同じ組み立て）──────────
 * 行末の「詳細」で右からレイヤーが出て、その中で編集と無効化を行う。
 * 開閉は URL（`?panel=`）。CSS は `staff.tsx` / `counterparties.tsx` と
 * 同じものを使う。**この画面のためのクラスを足さない。**
 *
 * ── 物理削除の経路を作らない ────────────────────────────
 * CLAUDE.md §4。無効化（`isActive = false`）だけ。**`intent` に
 * `delete` を足さないこと。** `standardTime` と `checklistTemplate` が
 * この ID を参照している。
 *
 * ── 無効化は割当客室数を先に見せる ──────────────────────
 * §24.5。**客室のタイプを自動で外さない。** 件数を提示して明示操作を
 * 求めるところまで。確認はレイヤーの中に出す（直す場所と同じ場所）。
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

/**
 * 右からスライドインするレイヤーの中身。
 *
 * `?panel=new` で登録、`?panel={roomTypeId}` で 1 件の編集。
 * **開いているかどうかを URL に持つ**（`staff.tsx` の注記と同じ理由）。
 */
type RoomTypePanel = { mode: "NEW" } | { mode: "DETAIL"; row: RoomTypeRow };

/** 保存の種類。**この 4 つ以外は出さない**（URL から来る値なので絞る）。 */
const SAVED_KINDS = ["CREATED", "UPDATED", "DEACTIVATED", "REACTIVATED", "MINUTES"] as const;

type SavedKind = (typeof SAVED_KINDS)[number];

function parseSaved(value: string | null): SavedKind | null {
  return (SAVED_KINDS as readonly string[]).includes(value ?? "") ? (value as SavedKind) : null;
}

interface RoomTypesData {
  propertyId: string | null;
  propertyName: string | null;
  rows: readonly RoomTypeRow[];
  canWrite: boolean;
  /** 目安時間のカードを出すか（`standardTime.read`）。 */
  canReadMinutes: boolean;
  /** 目安時間を保存できるか（`standardTime.write`）。 */
  canWriteMinutes: boolean;
  /** 目安時間の表。読めないときは空（**引かない**）。 */
  minutes: readonly MatrixRow[];
  /** レイヤー。閉じているときは `null`。 */
  panel: RoomTypePanel | null;
  /** 直前の保存の結果。無ければ `null`。 */
  saved: SavedKind | null;
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<RoomTypesData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  const properties = await listSelectableProperties(env, tenant);
  const { property } = resolveSelectedScope(session.selectedPropertyId, tenant, properties);
  if (property === null) {
    return {
      propertyId: null,
      propertyName: null,
      rows: [],
      canWrite: false,
      canReadMinutes: false,
      canWriteMinutes: false,
      minutes: [],
      panel: null,
      saved: null,
    };
  }

  assertPermission(tenant, "property.read", propertyTarget([property.id]));

  const canWrite = can(tenant, "property.write", propertyTarget([property.id]));
  // **読めるかどうかで引くかどうかを決める。** 引いてから画面で隠すと、
  // loader の戻り値（= HTML に載る JSON）に目安時間が残る。
  const canReadMinutes = can(tenant, "standardTime.read", propertyTarget([property.id]));
  const canWriteMinutes = can(tenant, "standardTime.write", propertyTarget([property.id]));

  // **無効化済みも並べる**（`{}` は「絞らない」）。取り消せない無効化を作らない。
  const [types, roomCounts, saved] = await Promise.all([
    listRoomTypes(env, tenant, property.id, {}),
    countRoomsByRoomType(env, tenant, property.id),
    canReadMinutes ? listStandardTimes(env, tenant, property.id) : Promise.resolve([]),
  ]);

  const rows: RoomTypeRow[] = types.map((type) => ({
    roomTypeId: type.id,
    code: type.code,
    name: type.name,
    bedCount: type.bedCount,
    capacity: type.capacity,
    sortOrder: type.sortOrder,
    isActive: type.isActive,
    roomCount: roomCounts.get(type.id) ?? 0,
  }));

  const url = new URL(request.url);

  return {
    propertyId: property.id,
    propertyName: property.name,
    rows,
    // 読めるが書けないロール（`AUDITOR`）に入力欄を出さないため。
    // **これは権限制御ではない**（action 側の `assertPermission` が守る）。
    canWrite,
    canReadMinutes,
    canWriteMinutes,
    minutes: canReadMinutes
      ? buildMatrix({
          // **目安時間は有効な客室タイプだけ。** 無効にしたタイプの行を
          // 出しても新しいタスクは生まれない（`isActive` で絞る）。
          roomTypes: rows
            .filter((row) => row.isActive)
            .map((row) => ({ id: row.roomTypeId, code: row.code, name: row.name })),
          saved: saved.map((row) => ({
            roomTypeId: row.roomTypeId,
            taskType: row.taskType,
            minutes: row.minutes,
          })),
        })
      : [],
    panel: resolvePanel(url.searchParams.get("panel"), rows, canWrite),
    saved: parseSaved(url.searchParams.get("saved")),
  };
}

/**
 * `?panel=` をレイヤーの中身へ。**知らない値は閉じたまま返す。**
 *
 * **書けない相手には開かない。** 中身は登録・編集・無効化の口しか無く、
 * `AUDITOR` に押せないフォームを見せる意味が無い（差し止めは `action` 側の
 * `assertPermission()` が受け持つ / security.md §1）。
 */
function resolvePanel(
  param: string | null,
  rows: readonly RoomTypeRow[],
  canWrite: boolean,
): RoomTypePanel | null {
  if (param === null || param === "" || !canWrite) return null;
  if (param === "new") return { mode: "NEW" };
  const found = rows.find((row) => row.roomTypeId === param);
  return found === undefined ? null : { mode: "DETAIL", row: found };
}

const ROOM_TYPE_PATH = "/app/settings/room-types";

/**
 * レイヤーの開閉を表す URL。
 *
 * @param panel `null` で閉じる。`"new"` で登録、それ以外は `roomTypeId`。
 */
function panelHref(panel: string | null): string {
  return panel === null ? ROOM_TYPE_PATH : `${ROOM_TYPE_PATH}?panel=${encodeURIComponent(panel)}`;
}

/**
 * 保存に成功したときの行き先（`staff.tsx` の `savedRedirect()` と同じ作り）。
 *
 * **成功したらレイヤーを閉じる。** 画面側で閉じるのではなくサーバーが
 * 行き先を返すので、JS が動かなくても同じように閉じ、戻るボタンで
 * 開いたままの状態に戻らない（POST → リダイレクト → GET）。
 */
function savedRedirect(saved: SavedKind): Response {
  return redirect(`${ROOM_TYPE_PATH}?saved=${saved}`);
}

interface RoomTypesActionResult {
  /** コードが既に使われている（`uq_room_type_property_code`）。 */
  duplicateCode?: string;
  invalid?: boolean;
  /**
   * 無効化の確認待ち（§24.5）。**`0` を返さない。**
   * 客室が 1 室も無ければ確認を挟まず無効化する。
   */
  confirmDeactivate?: { roomTypeId: string; name: string; roomCount: number };
  /** 目安時間の保存結果（保存した欄／範囲外で保存しなかった欄）。 */
  minutesRejected?: number;
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
}: ActionFunctionArgs): Promise<RoomTypesActionResult | Response> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  const properties = await listSelectableProperties(env, tenant);
  const { property } = resolveSelectedScope(session.selectedPropertyId, tenant, properties);
  if (property === null) throw new NotFoundError();

  const form = await request.formData();
  const intent = form.get("intent");

  // ── 目安時間は別の門（security.md §1）───────────────────
  // 画面が 1 枚になっても権限は混ぜない。`PROPERTY_MANAGER` は客室タイプを
  // 直せるが、目安時間は直せない（§10.1 の担当ロールは `ORG_ADMIN`）。
  if (intent === "minutes") {
    assertPermission(tenant, "standardTime.write", propertyTarget([property.id]));
    return saveMinutes(env, tenant, session.membershipId, property.id, form);
  }

  assertPermission(tenant, "property.write", propertyTarget([property.id]));

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
    return savedRedirect("CREATED");
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
      return savedRedirect("DEACTIVATED");
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
      return savedRedirect("REACTIVATED");
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
    return savedRedirect("UPDATED");
  }

  return { invalid: true };
}

type Env = ReturnType<typeof getEnv>;
type Tenant = Awaited<ReturnType<typeof requireAppContext>>["tenant"];

/**
 * 目安時間の保存（旧 `standardTimes.tsx` の `action` をそのまま持ってきた）。
 *
 * **表を作り直してから読む。** フォームが送ってきた `roomTypeId` を
 * そのまま信用しない（その施設の客室タイプに限る / INV-32 と同じ向き）。
 */
async function saveMinutes(
  env: Env,
  tenant: Tenant,
  actorId: string,
  propertyId: string,
  form: FormData,
): Promise<RoomTypesActionResult | Response> {
  const [roomTypes, before] = await Promise.all([
    listRoomTypes(env, tenant, propertyId),
    listStandardTimes(env, tenant, propertyId),
  ]);

  const rows = buildMatrix({
    roomTypes: roomTypes.map((type) => ({ id: type.id, code: type.code, name: type.name })),
    saved: before.map((row) => ({
      roomTypeId: row.roomTypeId,
      taskType: row.taskType,
      minutes: row.minutes,
    })),
  });
  const parsed = toInputs(rows, (name) => {
    const value = form.get(name);
    return typeof value === "string" ? value : null;
  });

  // **範囲外の欄があったらレイヤーの外に理由を出す。** 保存できた欄が
  // 0 件のときにリダイレクトすると、何も起きなかったように見える。
  if (parsed.rejected.length > 0) return { minutesRejected: parsed.rejected.length };
  if (parsed.entries.length === 0) return savedRedirect("MINUTES");

  await upsertStandardTimes(env, tenant, propertyId, parsed.entries);

  await recordAudit(env, tenant, {
    actorId,
    // API 側（`routes/api/v1/standardTimes.ts`）と同じ `action` を使う。
    // `AUDIT_ACTIONS` は閉じたレジストリで、標準時間専用の行は
    // security.md §6 に根拠が無い。
    action: "property.updated",
    targetType: "standardTime",
    targetId: propertyId,
    propertyId,
    before: before.map((row) => ({
      roomTypeId: row.roomTypeId,
      taskType: row.taskType,
      minutes: row.minutes,
    })),
    after: parsed.entries,
  });

  return savedRedirect("MINUTES");
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

  // 無効化の確認は**レイヤーを開いたまま**出す（直す場所と同じ場所）。
  const panel =
    result?.confirmDeactivate === undefined
      ? data.panel
      : (data.rows
          .filter((row) => row.roomTypeId === result.confirmDeactivate?.roomTypeId)
          .map((row): RoomTypePanel => ({ mode: "DETAIL", row }))[0] ?? data.panel);

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <div>
          <h1 className="pk-pagehead__title">{t("roomType.title")}</h1>
          <p className="pk-pagehead__sub">{data.propertyName}</p>
        </div>
        {data.canWrite ? (
          <div className="pk-pagehead__actions">
            <Link className="pk-button pk-button--primary" to={panelHref("new")}>
              {t("roomType.create.title")}
            </Link>
          </div>
        ) : null}
      </div>
      <p className="pk-page__lede">{t("roomType.scopeNotice")}</p>

      {/* **成功の知らせは画面の側に出す。** レイヤーはもう閉じている
          （`savedRedirect()`）。理由は `?saved=` で運ばれてくる。 */}
      {data.saved === null ? null : (
        <p className="pk-message">{t(`roomType.saved.${data.saved}` as MessageKey)}</p>
      )}
      {result?.minutesRejected === undefined ? null : (
        <p className="pk-notice pk-notice--warn">
          {`${t("stdtime.rejected")}: ${String(result.minutesRejected)}`}
        </p>
      )}

      <RoomTypeList rows={data.rows} canWrite={data.canWrite} />

      {/* 目安時間（旧 W-17）。**読める相手にだけ出す**（loader の注記）。 */}
      {data.canReadMinutes ? (
        <MinutesCard rows={data.minutes} canWrite={data.canWriteMinutes} />
      ) : null}

      {panel === null ? null : (
        <RoomTypeDrawer
          title={panel.mode === "NEW" ? t("roomType.create.title") : panel.row.name}
          closeHref={panelHref(null)}
          error={drawerErrorKey(result)}
        >
          {panel.mode === "NEW" ? (
            <CreateForm />
          ) : (
            <EditForm
              row={panel.row}
              confirm={
                result?.confirmDeactivate?.roomTypeId === panel.row.roomTypeId
                  ? result.confirmDeactivate
                  : null
              }
            />
          )}
        </RoomTypeDrawer>
      )}
    </section>
  );
}

/**
 * 直前の保存が失敗した理由 → 文言のキー。**成功はここに来ない**
 * （成功はリダイレクトになるので `useActionData` に残らない）。
 * 無効化の確認待ちは失敗ではないので、ここでは扱わない。
 */
function drawerErrorKey(result: RoomTypesActionResult | undefined): MessageKey | null {
  if (result === undefined) return null;
  if (result.duplicateCode !== undefined) return "roomType.duplicateCode";
  if (result.invalid === true) return "roomType.invalid";
  return null;
}

/** 客室タイプの一覧。行末の「詳細」でレイヤーが出る。 */
function RoomTypeList({ rows, canWrite }: { rows: readonly RoomTypeRow[]; canWrite: boolean }) {
  return (
    <section className="pk-panel">
      <div className="pk-panel__head">
        <span className="pk-panel__icon" aria-hidden="true">
          🛎️
        </span>
        {t("roomType.list.card")}
      </div>
      {rows.length === 0 ? (
        <div className="pk-panel__body">
          <p className="pk-muted">{t("roomType.empty")}</p>
        </div>
      ) : (
        <div className="pk-panel__body pk-panel__body--flush pk-scroll-x">
          <table className="pk-tbl">
            <thead>
              <tr>
                <th>{t("roomType.code")}</th>
                <th>{t("roomType.name")}</th>
                <th>{t("roomType.bedCount")}</th>
                <th>{t("roomType.capacity")}</th>
                <th>{t("roomType.sortOrder")}</th>
                <th>{t("roomType.roomCount")}</th>
                <th>{t("roomType.status")}</th>
                {/* 「詳細」の列。**見出しを空にしない** — 読み上げで
                    列の意味が消える（表の他の列と同じ扱いにする）。 */}
                {canWrite ? <th>{t("roomType.detailColumn")}</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.roomTypeId} className={row.isActive ? undefined : "pk-row--muted"}>
                  <th scope="row">{row.code}</th>
                  <td>{row.name}</td>
                  <td className="pk-num">{row.bedCount === null ? "—" : String(row.bedCount)}</td>
                  <td className="pk-num">{row.capacity === null ? "—" : String(row.capacity)}</td>
                  <td className="pk-num">{String(row.sortOrder)}</td>
                  <td className="pk-num">{String(row.roomCount)}</td>
                  <td>
                    <span className={row.isActive ? "pk-tag pk-tag--ok" : "pk-tag pk-tag--muted"}>
                      {t(row.isActive ? "roomType.active" : "roomType.inactive")}
                    </span>
                  </td>
                  {canWrite ? (
                    <td>
                      {/* **`<Link>` にしてある** — 素の `<a>` だと画面ごと
                          読み直しになり、レイヤーが出てくる動きが消える。 */}
                      <Link className="pk-button" to={panelHref(row.roomTypeId)}>
                        {t("roomType.detail")}
                      </Link>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * 目安時間（旧 W-17 標準時間設定 / PK-SPEC-P1 §3.1）。
 *
 * ── 既定分数を空欄にしない ──────────────────────────────
 * 未設定のセルには §3.1 の既定分数が効いている。判断は
 * `lib/standardTime/matrix.ts` にある（`isDefault`）。
 *
 * ── 過去のタスクは変わらない ────────────────────────────
 * PK-SPEC-P0 §24.5。`cleaningTask.standardMinutes` は生成時に写した値で、
 * ここを変えても既存タスクは動かない。カードの下にその旨を出す。
 */
function MinutesCard({ rows, canWrite }: { rows: readonly MatrixRow[]; canWrite: boolean }) {
  return (
    <section className="pk-panel">
      <div className="pk-panel__head">
        <span className="pk-panel__icon" aria-hidden="true">
          ⏱
        </span>
        {t("stdtime.card")}
      </div>
      {rows.length === 0 ? (
        <div className="pk-panel__body">
          <p className="pk-muted">{t("stdtime.noRoomTypes")}</p>
        </div>
      ) : (
        <Form method="post">
          <input type="hidden" name="intent" value="minutes" />
          <div className="pk-panel__body pk-panel__body--flush pk-scroll-x">
            <table className="pk-tbl">
              <thead>
                <tr>
                  <th>{t("stdtime.roomType")}</th>
                  {EDITABLE_TASK_TYPES.map((taskType) => (
                    <th key={taskType}>{t(`stdtime.taskType.${taskType}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.roomTypeId}>
                    <th scope="row">
                      {row.name}
                      <span className="pk-muted">{` (${row.code})`}</span>
                    </th>
                    {row.cells.map((cell) => (
                      <td key={cell.taskType}>
                        {canWrite ? (
                          <input
                            name={fieldName(row.roomTypeId, cell.taskType)}
                            aria-label={`${row.name} ${t(`stdtime.taskType.${cell.taskType}`)}`}
                            inputMode="numeric"
                            min={MINUTES_MIN}
                            max={MINUTES_MAX}
                            defaultValue={String(cell.minutes)}
                          />
                        ) : (
                          <span>{String(cell.minutes)}</span>
                        )}
                        {cell.isDefault ? (
                          <span className="pk-badge pk-badge--hidden">
                            {t("stdtime.isDefault")}
                          </span>
                        ) : null}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {canWrite ? (
            <div className="pk-panel__foot">
              <button className="pk-button pk-button--primary" type="submit">
                {t("stdtime.save")}
              </button>
            </div>
          ) : null}
        </Form>
      )}
      {/* §24.5: 既存タスクの標準時間は変わらない。事実として述べる。 */}
      <div className="pk-panel__foot">{t("stdtime.appliesToNewTasks")}</div>
    </section>
  );
}

/**
 * 右からスライドインするレイヤー（`staff.tsx` の `StaffDrawer` と同じもの）。
 *
 * 中身はサーバーが描き、閉じるのはリンク 1 本。**JS が動かなくても
 * 開閉する。** 閉じるは左端に置く（右上だとトップバーのログアウトの
 * 真下に来る / `staff.tsx` の注記）。
 */
function RoomTypeDrawer({
  title,
  closeHref,
  error,
  children,
}: {
  title: string;
  closeHref: string;
  error: MessageKey | null;
  children: React.ReactNode;
}) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <div className={busy ? "pk-drawer pk-drawer--busy" : "pk-drawer"} aria-busy={busy}>
      <Link className="pk-drawer__scrim" to={closeHref} aria-label={t("roomType.panel.close")} />
      <aside className="pk-drawer__panel" aria-label={title}>
        <div className="pk-drawer__head">
          {/* **文字ではなく図形で描く。** `×` は字面の位置がフォントごとに
              違い、見出しとの上下が環境によってずれる。 */}
          <Link className="pk-drawer__close" to={closeHref} aria-label={t("roomType.panel.close")}>
            <svg
              className="pk-drawer__closeIcon"
              viewBox="0 0 12 12"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M1.5 1.5 L10.5 10.5 M10.5 1.5 L1.5 10.5" />
            </svg>
          </Link>
          <h2 className="pk-drawer__title">{title}</h2>
        </div>
        <div className="pk-drawer__body">
          {error === null ? null : <p className="pk-notice pk-notice--warn">{t(error)}</p>}
          {children}
        </div>
      </aside>
    </div>
  );
}

/** レイヤーの中の送信ボタン。**送信中は押せなくする。** */
function SubmitButton({ label }: { label: string }) {
  const navigation = useNavigation();

  return (
    <button type="submit" disabled={navigation.state !== "idle"}>
      {label}
    </button>
  );
}

/** 新規登録（レイヤーの中）。 */
function CreateForm() {
  return (
    <Form method="post" className="pk-form">
      <input type="hidden" name="intent" value="create" />

      <label htmlFor="new-code">{t("roomType.code")}</label>
      <input id="new-code" name="code" required placeholder={t("roomType.code.hint")} />
      <p className="pk-form__note">{t("roomType.code.immutable")}</p>

      <label htmlFor="new-name">{t("roomType.name")}</label>
      <input id="new-name" name="name" required />

      <label htmlFor="new-bedCount">{t("roomType.bedCount")}</label>
      <input id="new-bedCount" name="bedCount" inputMode="numeric" />

      <label htmlFor="new-capacity">{t("roomType.capacity")}</label>
      <input id="new-capacity" name="capacity" inputMode="numeric" />

      <SubmitButton label={t("roomType.create.submit")} />
    </Form>
  );
}

/**
 * 編集（レイヤーの中）。
 *
 * ── `code` は編集できない ───────────────────────────────
 * CSV 取込と外部連携（P6）が突き合わせる鍵で、変えると過去の取込が
 * 別のタイプを指す（`updateRoomType()` の注記）。打ち間違えたら
 * 無効化して作り直す。
 *
 * ── 「削除」ではなく「無効化」──────────────────────────
 * 行は消えない（CLAUDE.md §4）。`standardTime` と `checklistTemplate` が
 * この ID を参照している。**戻せる。**
 */
function EditForm({
  row,
  confirm,
}: {
  row: RoomTypeRow;
  /** 無効化の確認待ち（§24.5）。無ければ `null`。 */
  confirm: { roomTypeId: string; name: string; roomCount: number } | null;
}) {
  return (
    <>
      <dl className="pk-drawer__facts">
        <dt>{t("roomType.code")}</dt>
        <dd>{row.code}</dd>
        <dt>{t("roomType.roomCount")}</dt>
        <dd>{String(row.roomCount)}</dd>
        <dt>{t("roomType.status")}</dt>
        <dd>
          <span className={row.isActive ? "pk-tag pk-tag--ok" : "pk-tag pk-tag--muted"}>
            {t(row.isActive ? "roomType.active" : "roomType.inactive")}
          </span>
        </dd>
      </dl>

      <h3 className="pk-drawer__section">{t("roomType.panel.section.profile")}</h3>
      <Form method="post" className="pk-form">
        <input type="hidden" name="intent" value="update" />
        <input type="hidden" name="roomTypeId" value={row.roomTypeId} />

        <label htmlFor="edit-name">{t("roomType.name")}</label>
        <input id="edit-name" name="name" defaultValue={row.name} required />

        <label htmlFor="edit-bedCount">{t("roomType.bedCount")}</label>
        <input
          id="edit-bedCount"
          name="bedCount"
          inputMode="numeric"
          defaultValue={row.bedCount === null ? "" : String(row.bedCount)}
        />

        <label htmlFor="edit-capacity">{t("roomType.capacity")}</label>
        <input
          id="edit-capacity"
          name="capacity"
          inputMode="numeric"
          defaultValue={row.capacity === null ? "" : String(row.capacity)}
        />

        <label htmlFor="edit-sortOrder">{t("roomType.sortOrder")}</label>
        <input
          id="edit-sortOrder"
          name="sortOrder"
          inputMode="numeric"
          defaultValue={String(row.sortOrder)}
        />
        <p className="pk-form__note">{t("roomType.code.immutable")}</p>

        <SubmitButton label={t("roomType.save")} />
      </Form>

      {/* 無効化と再開。**編集と同じフォームに混ぜない** —「保存」を
          押したつもりでタイプが止まることになる。 */}
      <h3 className="pk-drawer__section pk-drawer__section--danger">
        {t("roomType.panel.section.status")}
      </h3>
      <Form method="post" className="pk-form pk-drawer__danger">
        <input type="hidden" name="intent" value={row.isActive ? "deactivate" : "reactivate"} />
        <input type="hidden" name="roomTypeId" value={row.roomTypeId} />
        {/* §24.5 MUST: 割り当てられた客室の件数を先に伝え、明示操作を求める。
         **客室のタイプを自動で外さない。** 2 回目の押下で `confirm` を送る。 */}
        {confirm === null ? null : (
          <>
            <p className="pk-notice pk-notice--warn">
              {`${t("roomType.deactivate.assignedRooms")} ` +
                `${t("roomType.deactivate.roomCount")}: ${String(confirm.roomCount)}`}
            </p>
            <p className="pk-form__note">{t("roomType.deactivate.notice")}</p>
            <input type="hidden" name="confirm" value="yes" />
          </>
        )}
        <p className="pk-form__note">
          {t(row.isActive ? "roomType.panel.deactivateNote" : "roomType.panel.reactivateNote")}
        </p>
        <SubmitButton
          label={t(
            confirm !== null
              ? "roomType.deactivate.submit"
              : row.isActive
                ? "roomType.deactivate"
                : "roomType.reactivate",
          )}
        />
      </Form>
    </>
  );
}
