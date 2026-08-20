import { NotFoundError, listRoomPlans, listRoomTypes, listRooms, upsertRoomPlans } from "@pk/db";
import {
  Form,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { assertPermission, can, propertyTarget } from "../../lib/auth/permission.js";
import { businessDateOf } from "../../lib/businessDate.js";
import { MAX_CSV_FILE_BYTES, decodeCsvBuffer } from "../../lib/csv/decode.js";
import { t } from "../../lib/i18n.js";
import { parsePlanCsv } from "../../lib/plan/csv.js";
import {
  GUEST_COUNT_MAX,
  GUEST_COUNT_MIN,
  buildPlanGrid,
  planFieldName,
  toPlanInputs,
  type PlanGrid,
} from "../../lib/plan/grid.js";
import { switchProperty } from "../../lib/property/selection.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

/**
 * W-05 当日の客室状況入力（PK-SPEC-P1 §3.4 / §10.3）。
 *
 *   /app/p/{propertyId}/plan
 *
 * task: docs/tasks/P1-04.md（API は同 task が実装済み。**画面がこれ**）
 *
 * ── 「全室アウト清掃として生成」は必ず残す ──────────────
 * §3.4 の MUST。**データ入力を諦めても運用できる逃げ道。** 既に入力済みの
 * 行も上書きするので、押す前に確認を挟む（`intent=all-checkout` を
 * 2 段にしてある）。
 *
 * ── 取り込めなかったものを黙って捨てない ────────────────
 * CSV の読めなかった行番号と、客室マスタに無い部屋番号を必ず数で出す
 * （P1-04 の判断 1 / PK-IMPL-CONTRACT §11.3）。
 *
 * ── CSV はファイルが主、貼り付けは逃げ道 ────────────────
 * PMS から出すのはファイルで、貼り付けは「開いて全選択してコピー」を
 * 挟む。しかも Excel のコピーはタブ区切りになる（DECISIONS #211）。
 * ファイルは Shift_JIS を含めて `decodeCsvBuffer()` で読む。
 *
 * ── 宿泊者の情報を受け取らない ──────────────────────────
 * security.md §3。入力欄は §10.3 の 5 つ（OUT / IN / 連泊 / 人数 / 清掃辞退）
 * だけ。氏名・連絡先・予約参照番号の欄を足さないこと。
 *
 * ── ここはタスクを作らない ──────────────────────────────
 * 客室状況は生成の材料。タスクの生成は W-04（`/app/p/:propertyId/tasks` の
 * 「タスクを再生成」）が行う。**同じボタンにまとめない**（入力の途中で
 * タスクが立つと、着手済みのタスクとの関係が読めなくなる）。
 */

interface PlanData {
  propertyId: string;
  businessDate: string;
  grid: PlanGrid;
  canWrite: boolean;
}

export async function loader({ request, params, context }: LoaderFunctionArgs): Promise<PlanData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant, cookieValue } = await requireAppContext(env, request, now);

  const propertyId = params["propertyId"];
  if (propertyId === undefined) throw new NotFoundError();

  // URL を正としてセッションを更新する（W-03 / W-04 と同じ）。
  await switchProperty(env, tenant, cookieValue, propertyId, now, session.membershipId);

  assertPermission(tenant, "roomPlan.read", propertyTarget([propertyId]));

  const businessDate = businessDateParam(request) ?? businessDateOf(now);
  const [rooms, roomTypes, plans] = await Promise.all([
    listRooms(env, tenant, { propertyId, isActive: true }),
    listRoomTypes(env, tenant, propertyId),
    listRoomPlans(env, tenant, propertyId, businessDate),
  ]);

  return {
    propertyId,
    businessDate,
    grid: buildPlanGrid({
      rooms: rooms.map((room) => ({
        id: room.id,
        roomNumber: room.roomNumber,
        roomTypeId: room.roomTypeId,
        isSellable: room.isSellable,
      })),
      roomTypes: roomTypes.map((type) => ({ id: type.id, name: type.name })),
      plans: plans.map((plan) => ({
        roomId: plan.roomId,
        hasCheckout: plan.hasCheckout,
        hasCheckin: plan.hasCheckin,
        isStayover: plan.isStayover,
        guestCount: plan.guestCount,
        declineClean: plan.declineClean,
        source: plan.source,
      })),
    }),
    canWrite: can(tenant, "roomPlan.write", propertyTarget([propertyId])),
  };
}

/** action の結果。**文言を持たない。** 画面が i18n キーへ写す。 */
interface PlanActionResult {
  applied?: number;
  /** CSV で読めなかった行の番号。 */
  skippedLines?: readonly number[];
  /** 客室マスタに無い部屋番号。 */
  unknownRoomNumbers?: readonly string[];
  /** 人数が範囲外だった客室の部屋番号。 */
  rejectedRoomNumbers?: readonly string[];
  /** 「全室アウト清掃として生成」の確認待ち。対象件数を添える。 */
  confirmAllCheckout?: number;
  /** CSV のファイルも貼り付けも無かった。 */
  csvMissing?: boolean;
  /** CSV ファイルが大きすぎる（`MAX_CSV_FILE_BYTES` 超）。 */
  csvTooLarge?: boolean;
  invalid?: boolean;
}

export async function action({
  request,
  params,
  context,
}: ActionFunctionArgs): Promise<PlanActionResult> {
  const env = getEnv(context);
  const now = new Date();
  const { tenant } = await requireAppContext(env, request, now);

  const propertyId = params["propertyId"];
  if (propertyId === undefined) throw new NotFoundError();

  assertPermission(tenant, "roomPlan.write", propertyTarget([propertyId]));

  const form = await request.formData();
  const intent = form.get("intent");
  const businessDate = fieldOf(form, "businessDate");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) return { invalid: true };

  const rooms = await listRooms(env, tenant, { propertyId, isActive: true });

  if (intent === "manual") {
    const roomTypes = await listRoomTypes(env, tenant, propertyId);
    const plans = await listRoomPlans(env, tenant, propertyId, businessDate);
    // **表を作り直してから読む。** フォームが送ってきた `roomId` を
    // そのまま信用しない（その施設の有効な客室に限る / INV-32）。
    const grid = buildPlanGrid({
      rooms: rooms.map((room) => ({
        id: room.id,
        roomNumber: room.roomNumber,
        roomTypeId: room.roomTypeId,
        isSellable: room.isSellable,
      })),
      roomTypes: roomTypes.map((type) => ({ id: type.id, name: type.name })),
      plans: plans.map((plan) => ({
        roomId: plan.roomId,
        hasCheckout: plan.hasCheckout,
        hasCheckin: plan.hasCheckin,
        isStayover: plan.isStayover,
        guestCount: plan.guestCount,
        declineClean: plan.declineClean,
        source: plan.source,
      })),
    });

    const parsed = toPlanInputs(grid.rooms, (name) => {
      const value = form.get(name);
      return typeof value === "string" ? value : null;
    });
    const applied = await upsertRoomPlans(
      env,
      tenant,
      propertyId,
      businessDate,
      parsed.entries,
      "MANUAL",
    );
    return { applied, rejectedRoomNumbers: parsed.rejectedRoomNumbers };
  }

  if (intent === "csv") {
    // ファイルを主、貼り付けを逃げ道にする（DECISIONS #211）。ファイルが
    // 選ばれていればそちらを採り、貼り付け欄は見ない（両方あるとき
    // どちらが効いたか分からない状態を作らない）。
    const file = form.get("csvFile");
    let csvText: string;
    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_CSV_FILE_BYTES) return { csvTooLarge: true };
      csvText = decodeCsvBuffer(await file.arrayBuffer());
    } else {
      csvText = fieldOf(form, "csv");
    }
    if (csvText.trim() === "") return { csvMissing: true };

    const parsed = parsePlanCsv(csvText, businessDate);
    const roomByNumber = new Map(rooms.map((room) => [room.roomNumber, room.id]));

    const unknownRoomNumbers: string[] = [];
    const entries = [];
    for (const row of parsed.rows) {
      const roomId = roomByNumber.get(row.roomNumber);
      if (roomId === undefined) {
        unknownRoomNumbers.push(row.roomNumber);
        continue;
      }
      entries.push({
        roomId,
        hasCheckout: row.hasCheckout,
        hasCheckin: row.hasCheckin,
        isStayover: row.isStayover,
        guestCount: row.guestCount,
        declineClean: row.declineClean,
      });
    }

    const applied = await upsertRoomPlans(env, tenant, propertyId, businessDate, entries, "CSV");
    return { applied, skippedLines: parsed.skippedLines, unknownRoomNumbers };
  }

  if (intent === "all-checkout") {
    // 売れる客室だけ（パントリーにアウト清掃は立たない / §24.3）。
    const sellable = rooms.filter((room) => room.isSellable);

    // **既存の入力を上書きする操作なので確認を挟む。** §3.4 は逃げ道を
    // 必ず用意せよと定めるが、押し間違いで朝の入力が消えてよいとは
    // 書いていない。1 タップにしないのは管理画面だから
    // （現場の `/m/*` の「確認ダイアログを挟まない」は別の話）。
    if (fieldOf(form, "confirm") !== "yes") {
      return { confirmAllCheckout: sellable.length };
    }

    const applied = await upsertRoomPlans(
      env,
      tenant,
      propertyId,
      businessDate,
      sellable.map((room) => ({
        roomId: room.id,
        hasCheckout: true,
        hasCheckin: false,
        isStayover: false,
        guestCount: 0,
        declineClean: false,
      })),
      "MANUAL",
    );
    return { applied };
  }

  return { invalid: true };
}

export default function PropertyPlan() {
  const data = useLoaderData<PlanData>();
  const result = useActionData<PlanActionResult>();

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <div>
          <h1 className="pk-pagehead__title">{t("plan.title")}</h1>
          <p className="pk-pagehead__sub">{data.businessDate}</p>
        </div>
        {/* 業務日の切替。**カレンダー日ではなく業務日**（architecture.md §7）。
            見出しの右端に置く（A01 §3.2 / DECISIONS #227）。 */}
        <Form method="get" className="pk-pagehead__actions">
          <label className="pk-field">
            <span className="pk-field__label">{t("plan.businessDate")}</span>
            <input
              className="pk-input"
              id="date"
              name="date"
              type="date"
              defaultValue={data.businessDate}
            />
          </label>
          <button className="pk-button pk-button--primary" type="submit">
            {t("plan.businessDate.show")}
          </button>
        </Form>
      </div>

      {result?.invalid === true ? <p className="pk-notice">{t("plan.invalid")}</p> : null}
      {result?.csvMissing === true ? (
        <p className="pk-notice pk-notice--warn">{t("plan.csv.missing")}</p>
      ) : null}
      {result?.csvTooLarge === true ? (
        <p className="pk-notice pk-notice--warn">{t("plan.csv.tooLarge")}</p>
      ) : null}
      {result?.applied === undefined ? null : (
        <p className="pk-notice">{`${t("plan.applied")}: ${String(result.applied)}`}</p>
      )}
      {result?.skippedLines === undefined || result.skippedLines.length === 0 ? null : (
        <p className="pk-notice pk-notice--warn">
          {`${t("plan.csv.skippedLines")}: ${result.skippedLines.join(", ")}`}
        </p>
      )}
      {result?.unknownRoomNumbers === undefined || result.unknownRoomNumbers.length === 0 ? null : (
        <p className="pk-notice pk-notice--warn">
          {`${t("plan.csv.unknownRooms")}: ${result.unknownRoomNumbers.join(", ")}`}
        </p>
      )}
      {result?.rejectedRoomNumbers === undefined ||
      result.rejectedRoomNumbers.length === 0 ? null : (
        <p className="pk-notice pk-notice--warn">
          {`${t("plan.guests.rejected")}: ${result.rejectedRoomNumbers.join(", ")}`}
        </p>
      )}

      {/* 未入力が残っていることを事実として述べる。入力は強制しない。 */}
      {data.grid.unfilled === 0 ? null : (
        <p className="pk-notice">{`${t("plan.unfilled")}: ${String(data.grid.unfilled)}`}</p>
      )}

      {data.canWrite ? (
        <div className="pk-toolbar">
          {/* §3.4 MUST の逃げ道。確認を挟んでから効く。 */}
          <Form method="post">
            <input type="hidden" name="intent" value="all-checkout" />
            <input type="hidden" name="businessDate" value={data.businessDate} />
            {result?.confirmAllCheckout === undefined ? (
              <button className="pk-button" type="submit">
                {t("plan.allCheckout")}
              </button>
            ) : (
              <>
                <span className="pk-notice pk-notice--warn">
                  {`${t("plan.allCheckout.confirm")}（${String(result.confirmAllCheckout)}）`}
                </span>
                <input type="hidden" name="confirm" value="yes" />
                <button className="pk-button pk-button--primary" type="submit">
                  {t("plan.allCheckout.submit")}
                </button>
              </>
            )}
          </Form>
        </div>
      ) : null}

      {data.canWrite ? (
        <Form method="post" encType="multipart/form-data" className="pk-form">
          <input type="hidden" name="intent" value="csv" />
          <input type="hidden" name="businessDate" value={data.businessDate} />
          <h2>{t("plan.csv.title")}</h2>
          {/* ファイルが主経路。貼り付けは逃げ道として残す（DECISIONS #211）。 */}
          <label htmlFor="csvFile">{t("plan.csv.file")}</label>
          <input
            id="csvFile"
            name="csvFile"
            type="file"
            accept=".csv,.tsv,text/csv,text/tab-separated-values"
          />
          <p className="pk-hint">{t("plan.csv.file.hint")}</p>
          <label htmlFor="csv">{t("plan.csv.paste")}</label>
          <textarea id="csv" name="csv" rows={6} />
          <p className="pk-hint">{t("plan.csv.hint")}</p>
          <button className="pk-button" type="submit">
            {t("plan.csv.submit")}
          </button>
        </Form>
      ) : null}

      <Form method="post">
        <input type="hidden" name="intent" value="manual" />
        <input type="hidden" name="businessDate" value={data.businessDate} />
        <table className="pk-grid">
          <thead>
            <tr>
              <th>{t("plan.room")}</th>
              <th>{t("plan.roomType")}</th>
              <th>{t("plan.hasCheckout")}</th>
              <th>{t("plan.hasCheckin")}</th>
              <th>{t("plan.isStayover")}</th>
              <th>{t("plan.guestCount")}</th>
              <th>{t("plan.declineClean")}</th>
              <th>{t("plan.source")}</th>
            </tr>
          </thead>
          <tbody>
            {data.grid.rooms.map((row) => (
              <tr key={row.roomId}>
                <th scope="row">{row.roomNumber}</th>
                <td>{row.roomTypeName ?? "—"}</td>
                <td>
                  <PlanFlag
                    roomId={row.roomId}
                    field="checkout"
                    checked={row.hasCheckout}
                    editable={data.canWrite}
                  />
                </td>
                <td>
                  <PlanFlag
                    roomId={row.roomId}
                    field="checkin"
                    checked={row.hasCheckin}
                    editable={data.canWrite}
                  />
                </td>
                <td>
                  <PlanFlag
                    roomId={row.roomId}
                    field="stayover"
                    checked={row.isStayover}
                    editable={data.canWrite}
                  />
                </td>
                <td>
                  {data.canWrite ? (
                    <input
                      name={planFieldName(row.roomId, "guests")}
                      aria-label={`${row.roomNumber} ${t("plan.guestCount")}`}
                      inputMode="numeric"
                      min={GUEST_COUNT_MIN}
                      max={GUEST_COUNT_MAX}
                      defaultValue={String(row.guestCount)}
                    />
                  ) : (
                    <span>{String(row.guestCount)}</span>
                  )}
                </td>
                <td>
                  <PlanFlag
                    roomId={row.roomId}
                    field="decline"
                    checked={row.declineClean}
                    editable={data.canWrite}
                  />
                </td>
                <td className="pk-muted">
                  {row.source === null ? t("plan.source.none") : t(`plan.source.${row.source}`)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.canWrite ? (
          <button className="pk-button pk-button--primary" type="submit">
            {t("plan.save")}
          </button>
        ) : null}
      </Form>

      {data.grid.nonSellable.length === 0 ? null : (
        <>
          <h2>{t("plan.nonSellable")}</h2>
          {/* 清掃専用の場所。**入力欄を出さない**（§24.3）。 */}
          <p className="pk-muted">
            {data.grid.nonSellable.map((room) => room.roomNumber).join(" / ")}
          </p>
        </>
      )}
    </section>
  );
}

/** チェックボックス 1 つ。読み取り専用ロールでは印だけを出す。 */
function PlanFlag({
  roomId,
  field,
  checked,
  editable,
}: {
  roomId: string;
  field: "checkout" | "checkin" | "stayover" | "decline";
  checked: boolean;
  editable: boolean;
}) {
  if (!editable) return <span>{checked ? "☑" : "☐"}</span>;
  return (
    <input
      type="checkbox"
      name={planFieldName(roomId, field)}
      aria-label={`${roomId} ${field}`}
      defaultChecked={checked}
    />
  );
}

/** `?date=` を読む。形式が違えば `null`（既定の業務日へ落ちる）。 */
function businessDateParam(request: Request): string | null {
  const value = new URL(request.url).searchParams.get("date");
  return value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/**
 * `FormData` から文字列だけを取り出す。
 *
 * `get()` は `File` も返しうる。**`String()` で潰さない**（`rooms.tsx` と同じ）。
 */
function fieldOf(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}
