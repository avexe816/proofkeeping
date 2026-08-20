/**
 * W-21 ベースライン確認・上書き（PK-SPEC-P3 §5.5 / §6.2）。
 *
 *   /app/settings/baseline
 *
 * task: docs/tasks/P3-10.md
 *
 * ── 施設ごとの値である ──────────────────────────────────
 * `consumptionBaseline` の一意制約は施設を含む。§6.1 の担当ロールは
 * `ORG_ADMIN` だが、**対象は表示中の施設**（W-17 / W-20 と同じ形）。
 *
 * ── 出すのは統計量だけ ──────────────────────────────────
 * 中央値・p10・p90・最大・サンプル数と、その信頼性。**「多い」「少ない」の
 * 判定を出さない**（§0.2）。閾値との突き合わせは P4。
 *
 * ── 信頼性 × の行 ───────────────────────────────────────
 * §6.2 のとおりグレーで出し、「P4 の照合では使用されません」と注記する。
 * **隠さない。** 隠すと「まだ貯まっていない組み合わせ」が見えず、
 * P3-13（4 週間の蓄積）の判断ができない。
 *
 * ── 上書きできるのは p90 だけ ───────────────────────────
 * §5.5。理由必須で、算出値（`p90Qty`）は残したまま別列に持つ。
 * 週次バッチは上書き列に触れない（`repositories/baseline.ts`）。
 */

import { MAX_BASELINE_QTY, type ItemCodeValue } from "@pk/contracts";
import {
  clearBaselineOverride,
  findBaselineById,
  listBaselines,
  listRoomTypes,
  NotFoundError,
  recordAudit,
  setBaselineOverride,
  TASK_TYPES,
  type TaskType,
} from "@pk/db";
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

/** 表示用に絞った 1 行。 */
interface BaselineRow {
  id: string;
  itemCode: ItemCodeValue;
  sampleSize: number;
  medianQty: number;
  p10Qty: number;
  p90Qty: number;
  maxQty: number;
  isReliable: boolean;
  manualOverride: number | null;
  overrideReason: string | null;
}

interface RoomTypeOption {
  id: string;
  name: string;
}

interface BaselineSettingsData {
  propertyId: string | null;
  propertyName: string | null;
  roomTypes: RoomTypeOption[];
  /** 実際にベースラインのある人数（§6.2 のセレクタ）。 */
  guestCounts: number[];
  selected: { roomTypeId: string | null; guestCount: number | null; taskType: TaskType };
  rows: BaselineRow[];
  /** 集計期間（§6.2 の見出し）。行が無ければ `null`。 */
  computedFrom: string | null;
  computedTo: string | null;
  canWrite: boolean;
}

/** 上書きできる作業種別。**語彙は `TASK_TYPES` を共有する。** */
const DEFAULT_TASK_TYPE: TaskType = "CHECKOUT";

function toRow(row: Awaited<ReturnType<typeof listBaselines>>[number]): BaselineRow {
  return {
    id: row.id,
    itemCode: row.itemCode,
    sampleSize: row.sampleSize,
    medianQty: row.medianQty,
    p10Qty: row.p10Qty,
    p90Qty: row.p90Qty,
    maxQty: row.maxQty,
    isReliable: row.isReliable,
    manualOverride: row.manualOverride,
    overrideReason: row.overrideReason,
  };
}

export async function loader({
  request,
  context,
}: LoaderFunctionArgs): Promise<BaselineSettingsData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  const properties = await listSelectableProperties(env, tenant);
  const { property } = resolveSelectedScope(session.selectedPropertyId, tenant, properties);
  if (property === null) {
    return {
      propertyId: null,
      propertyName: null,
      roomTypes: [],
      guestCounts: [],
      selected: { roomTypeId: null, guestCount: null, taskType: DEFAULT_TASK_TYPE },
      rows: [],
      computedFrom: null,
      computedTo: null,
      canWrite: false,
    };
  }

  assertPermission(tenant, "baseline.read", propertyTarget([property.id]));

  const url = new URL(request.url);
  const taskTypeRaw = url.searchParams.get("taskType");
  const taskType: TaskType = (TASK_TYPES as readonly string[]).includes(taskTypeRaw ?? "")
    ? (taskTypeRaw as TaskType)
    : DEFAULT_TASK_TYPE;

  const [roomTypes, all] = await Promise.all([
    listRoomTypes(env, tenant, property.id, {}),
    listBaselines(env, tenant, { propertyId: property.id }),
  ]);

  // **選択肢は実データから作る。** 客室タイプ × 人数の全組み合わせを
  // 並べると、1 件も観察の無い組み合わせが大量に出る。
  const roomTypeIds = new Set(all.map((row) => row.roomTypeId));
  const roomTypeOptions = roomTypes
    .filter((roomType) => roomTypeIds.has(roomType.id))
    .map((roomType) => ({ id: roomType.id, name: roomType.name }));

  const selectedRoomTypeId = url.searchParams.get("roomTypeId") ?? roomTypeOptions[0]?.id ?? null;

  const guestCounts = [
    ...new Set(
      all.filter((row) => row.roomTypeId === selectedRoomTypeId).map((row) => row.guestCount),
    ),
  ].sort((a, b) => a - b);

  const guestCountRaw = url.searchParams.get("guestCount");
  const parsedGuestCount = guestCountRaw === null ? Number.NaN : Number.parseInt(guestCountRaw, 10);
  const selectedGuestCount = guestCounts.includes(parsedGuestCount)
    ? parsedGuestCount
    : (guestCounts[0] ?? null);

  const rows = all.filter(
    (row) =>
      row.roomTypeId === selectedRoomTypeId &&
      row.guestCount === selectedGuestCount &&
      row.taskType === taskType,
  );

  return {
    propertyId: property.id,
    propertyName: property.name,
    roomTypes: roomTypeOptions,
    guestCounts,
    selected: { roomTypeId: selectedRoomTypeId, guestCount: selectedGuestCount, taskType },
    rows: rows.map(toRow),
    computedFrom: rows[0]?.computedFrom ?? null,
    computedTo: rows[0]?.computedTo ?? null,
    canWrite: can(tenant, "baseline.override", propertyTarget([property.id])),
  };
}

interface BaselineSettingsResult {
  saved?: boolean;
  cleared?: boolean;
  /** 理由が空・値の形が違う。**保存していない。** */
  rejected?: boolean;
}

/**
 * p90 の上書き・解除（§5.5）。**理由必須。**
 *
 * API（`routes/api/v1/baselines.ts`）と同じことをするが、画面は
 * リポジトリを直に呼ぶ（W-20 と同じ形 / DECISIONS #099）。**判定と
 * 監査ログを両方に書くことになるので、片方だけ直さないこと。**
 */
export async function action({
  request,
  context,
}: ActionFunctionArgs): Promise<BaselineSettingsResult> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  const form = await request.formData();
  const baselineId = form.get("baselineId");
  if (typeof baselineId !== "string") throw new NotFoundError();

  const before = await findBaselineById(env, tenant, baselineId);
  if (before === undefined) throw new NotFoundError();

  assertPermission(tenant, "baseline.override", propertyTarget([before.propertyId]));

  const reasonRaw = form.get("reason");
  const reason = typeof reasonRaw === "string" ? reasonRaw.trim() : "";
  if (reason === "") return { rejected: true };

  const intent = form.get("intent");
  const clearing = intent === "clear";

  let applied: number | null = null;
  if (!clearing) {
    const raw = form.get("manualOverride");
    const parsed = typeof raw === "string" ? Number.parseFloat(raw) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_BASELINE_QTY) {
      return { rejected: true };
    }
    applied = parsed;
  }

  if (applied === null) await clearBaselineOverride(env, tenant, baselineId);
  else await setBaselineOverride(env, tenant, { baselineId, manualOverride: applied, reason });

  // security.md §6。`AUDIT_ACTIONS` は閉じたレジストリで、ベースライン専用の
  // 行は根拠が無いため施設設定の更新として残す（W-20 と同じ扱い）。
  await recordAudit(env, tenant, {
    actorId: session.membershipId,
    action: "property.updated",
    targetType: "consumptionBaseline",
    targetId: baselineId,
    propertyId: before.propertyId,
    before: { manualOverride: before.manualOverride, overrideReason: before.overrideReason },
    after: { manualOverride: applied, overrideReason: applied === null ? null : reason, reason },
  });

  return applied === null ? { cleared: true } : { saved: true };
}

export default function BaselineSettings() {
  const data = useLoaderData<BaselineSettingsData>();
  const result = useActionData<BaselineSettingsResult>();

  if (data.propertyId === null) {
    return (
      <section className="pk-page">
        <h1 className="pk-page__title">{t("baseline.title")}</h1>
        <p className="pk-notice">{t("baseline.noProperty")}</p>
      </section>
    );
  }

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <div>
          <h1 className="pk-pagehead__title">{t("baseline.title")}</h1>
          <p className="pk-pagehead__sub">{data.propertyName}</p>
        </div>
        <Form method="get" className="pk-pagehead__actions">
          <label className="pk-field">
            <span className="pk-field__label">{t("baseline.roomType")}</span>
            <select
              className="pk-select"
              name="roomTypeId"
              defaultValue={data.selected.roomTypeId ?? ""}
            >
              {data.roomTypes.map((roomType) => (
                <option key={roomType.id} value={roomType.id}>
                  {roomType.name}
                </option>
              ))}
            </select>
          </label>
          <label className="pk-field">
            <span className="pk-field__label">{t("baseline.guestCount")}</span>
            <select
              className="pk-select"
              name="guestCount"
              defaultValue={String(data.selected.guestCount ?? "")}
            >
              {data.guestCounts.map((guestCount) => (
                <option key={guestCount} value={String(guestCount)}>
                  {String(guestCount)}
                </option>
              ))}
            </select>
          </label>
          <label className="pk-field">
            <span className="pk-field__label">{t("baseline.taskType")}</span>
            <select className="pk-select" name="taskType" defaultValue={data.selected.taskType}>
              {TASK_TYPES.map((taskType) => (
                <option key={taskType} value={taskType}>
                  {t(`m.taskType.${taskType}`)}
                </option>
              ))}
            </select>
          </label>
          <button className="pk-button pk-button--primary" type="submit">
            {t("baseline.apply")}
          </button>
        </Form>
      </div>

      {data.computedFrom === null ? null : (
        <p className="pk-muted">
          {`${t("baseline.window")}: ${data.computedFrom} 〜 ${String(data.computedTo)}`}
        </p>
      )}

      {result?.saved === true ? <p className="pk-notice">{t("baseline.saved")}</p> : null}
      {result?.cleared === true ? <p className="pk-notice">{t("baseline.cleared")}</p> : null}
      {result?.rejected === true ? (
        <p className="pk-notice pk-notice--warn">{t("baseline.reasonRequired")}</p>
      ) : null}

      {/* §5.1。値は週次バッチが置き換える。人が直せるのは p90 だけ。 */}
      <p className="pk-notice">{t("baseline.weeklyNote")}</p>

      {data.rows.length === 0 ? (
        <p className="pk-notice">{t("baseline.empty")}</p>
      ) : (
        <table className="pk-grid">
          <thead>
            <tr>
              <th>{t("baseline.item")}</th>
              <th>{t("baseline.sampleSize")}</th>
              <th>{t("baseline.median")}</th>
              <th>{t("baseline.p10")}</th>
              <th>{t("baseline.p90")}</th>
              <th>{t("baseline.max")}</th>
              <th>{t("baseline.reliability")}</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.id} className={row.isReliable ? undefined : "pk-row--muted"}>
                <th scope="row">{t(`obs.item.${row.itemCode}`)}</th>
                <td>{String(row.sampleSize)}</td>
                <td>{formatQty(row.medianQty)}</td>
                <td>{formatQty(row.p10Qty)}</td>
                <td>
                  {data.canWrite ? (
                    <Form method="post" className="pk-inline">
                      <input type="hidden" name="baselineId" value={row.id} />
                      <input
                        className="pk-input"
                        name="manualOverride"
                        inputMode="decimal"
                        min={0}
                        max={MAX_BASELINE_QTY}
                        aria-label={t("baseline.p90")}
                        defaultValue={formatQty(row.manualOverride ?? row.p90Qty)}
                      />
                      <input
                        className="pk-input"
                        name="reason"
                        aria-label={t("baseline.reason")}
                        placeholder={t("baseline.reason")}
                        defaultValue=""
                      />
                      <button className="pk-button pk-button--primary" type="submit">
                        {t("baseline.save")}
                      </button>
                      {row.manualOverride === null ? null : (
                        <button className="pk-button" type="submit" name="intent" value="clear">
                          {t("baseline.clear")}
                        </button>
                      )}
                    </Form>
                  ) : (
                    <span>{formatQty(row.manualOverride ?? row.p90Qty)}</span>
                  )}
                  {row.manualOverride === null ? null : (
                    <span className="pk-badge pk-badge--warn">{t("baseline.overridden")}</span>
                  )}
                </td>
                <td>{formatQty(row.maxQty)}</td>
                <td>
                  {row.isReliable ? (
                    <span>{t("baseline.reliable")}</span>
                  ) : (
                    <span className="pk-badge">{t("baseline.notReliable")}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* §6.2「信頼性 × の行は…注記する」。 */}
      <p className="pk-muted">{t("baseline.notReliableNote")}</p>
      {/* §5.5「manualOverride が設定されている場合、管理画面に明示する」。 */}
      <p className="pk-muted">{t("baseline.overrideNote")}</p>
    </section>
  );
}

/** 統計量は小数。**画面では小数第 1 位まで**（§6.2 の例が `2.0`）。 */
function formatQty(value: number): string {
  return value.toFixed(1);
}
