import { shiftUpsertRequestSchema, SHIFT_TYPE_VALUES } from "@pk/contracts";
import {
  copyShiftWeek,
  deleteShift,
  listOrgStaff,
  listProperties,
  listShifts,
  listTasks,
  upsertShift,
  type ShiftRow,
} from "@pk/db";
import {
  Form,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { WORKLOAD_LIMIT_MINUTES } from "@pk/engine";

import { ORGANIZATION_TARGET, assertPermission } from "../../lib/auth/permission.js";
import { businessDateOf } from "../../lib/businessDate.js";
import { t } from "../../lib/i18n.js";
import {
  buildShiftBoard,
  weekOf,
  type ShiftBoard,
  type ShiftBoardRow,
} from "../../lib/staff/shiftBoard.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

/**
 * シフトと当日の割当（P8-03 / プロトタイプ ops 02）。
 *
 *   /app/shifts?businessDate=YYYY-MM-DD
 *
 * task: docs/tasks/P8-03.md
 * 決定: docs/DECISIONS.md #221
 *
 * ── 週間グリッドは無い ──────────────────────────────────
 * プロトタイプ 02 にあるのは**日次の割当表と出勤者数の棒グラフだけ**
 * （DECISIONS #221）。入力もその日 1 日ぶんをまとめて保存する形にする。
 * ヘッダーの操作は日付・前週の複製・保存（プロトタイプの並び）。
 *
 * ── 「自動割当」のボタンを置かない ──────────────────────
 * 自動配分は施設ごとの操作で、W-04（タスク管理）に既にある。
 * この画面から二重に押せる形にすると、**どちらの結果が生きているか**が
 * 分からなくなる。迷ったら少ない方（簡素化の原則）。
 *
 * ── 門は `shift.manage`（OWNER / ORG_ADMIN のみ）────────
 * スタッフ名を組織全体で並べる画面。プロトタイプの
 * 「担当者名は運営管理者のみ閲覧できます」に合わせて狭い
 * （OPEN_QUESTIONS #112 / 仕様 §3 の表より狭いことを記録済み）。
 */

interface ShiftProperty {
  id: string;
  name: string;
}

interface ShiftEntryRow {
  membershipId: string;
  displayName: string;
  /** 表示中の業務日のシフト。未登録なら `null`。 */
  shiftType: string | null;
  propertyId: string | null;
}

interface ShiftsData {
  businessDate: string;
  board: ShiftBoard;
  entries: ShiftEntryRow[];
  properties: ShiftProperty[];
}

type ShiftsActionResult =
  { saved: number } | { copied: number; copySkipped: number } | { invalid: true };

export async function loader({ request, context }: LoaderFunctionArgs): Promise<ShiftsData> {
  const env = getEnv(context);
  const now = new Date();
  const { tenant } = await requireAppContext(env, request, now);
  assertPermission(tenant, "shift.manage", ORGANIZATION_TARGET);

  const url = new URL(request.url);
  const businessDate = normalizeDate(url.searchParams.get("businessDate")) ?? businessDateOf(now);
  const week = weekOf(businessDate);
  const weekFrom = week[0] ?? businessDate;
  const weekTo = week[6] ?? businessDate;

  const [staff, weekShifts, tasks, properties] = await Promise.all([
    listOrgStaff(env, tenant),
    // 週で 1 回読み、当日ぶんは JS で絞る（同じ表を 2 度引かない）。
    listShifts(env, tenant, { from: weekFrom, to: weekTo }),
    listTasks(env, tenant, { businessDate }),
    listProperties(env, tenant, {}),
  ]);
  const dayShifts = weekShifts.filter((row) => row.businessDate === businessDate);

  const board = buildShiftBoard({
    staff,
    shifts: dayShifts,
    tasks: tasks.map((task) => ({
      assigneeId: task.assigneeId,
      status: task.status,
      startedAtMs: task.startedAt === null ? null : task.startedAt.getTime(),
    })),
    weekShifts,
    weekDates: week,
    propertyNames: new Map(properties.map((property) => [property.id, property.name])),
  });

  const shiftByMembership = new Map<string, ShiftRow>(
    dayShifts.map((row) => [row.membershipId, row]),
  );
  const entries: ShiftEntryRow[] = staff
    // 退職者にシフトを組ませない。**当日の行が残っていれば出す**
    // （退職処理より前に組んだ予定は見えたままにする）。
    .filter((person) => person.isActive || shiftByMembership.has(person.membershipId))
    .map((person) => {
      const shift = shiftByMembership.get(person.membershipId);
      return {
        membershipId: person.membershipId,
        displayName: person.displayName,
        shiftType: shift?.shiftType ?? null,
        propertyId: shift?.propertyId ?? null,
      };
    });

  return {
    businessDate,
    board,
    entries,
    properties: properties
      .filter((property) => property.isActive)
      .map((property) => ({ id: property.id, name: property.name })),
  };
}

/** `YYYY-MM-DD` 以外を受け付けない（URL は利用者が書き換えられる）。 */
function normalizeDate(value: string | null): string | null {
  return value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function fieldOf(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export async function action({
  request,
  context,
}: ActionFunctionArgs): Promise<ShiftsActionResult> {
  const env = getEnv(context);
  const now = new Date();
  const { tenant } = await requireAppContext(env, request, now);
  assertPermission(tenant, "shift.manage", ORGANIZATION_TARGET);

  const form = await request.formData();
  const businessDate = normalizeDate(fieldOf(form, "businessDate"));
  if (businessDate === null) return { invalid: true };

  // ── 前週の複製（仕様 §1.5 MUST）─────────────────────────
  if (fieldOf(form, "intent") === "copy-week") {
    const week = weekOf(businessDate);
    const from = week[0] ?? businessDate;
    const result = await copyShiftWeek(env, tenant, {
      sourceFrom: addDays(from, -7),
      sourceTo: addDays(from, -1),
      targetFrom: from,
    });
    return { copied: result.copied, copySkipped: result.skipped };
  }

  // ── その日のシフトをまとめて保存 ────────────────────────
  const memberIds = form
    .getAll("memberId")
    .filter((value): value is string => typeof value === "string");
  let saved = 0;
  for (const membershipId of memberIds) {
    const rawType = fieldOf(form, `shiftType:${membershipId}`);
    if (rawType === "") {
      // 「未登録」へ戻す。`OFF`（休みと決めた）とは別（`deleteShift()` の注記）。
      await deleteShift(env, tenant, { membershipId, businessDate });
      continue;
    }
    const rawProperty = fieldOf(form, `propertyId:${membershipId}`);
    const parsed = shiftUpsertRequestSchema.safeParse({
      membershipId,
      businessDate,
      shiftType: rawType,
      // `WORK` 以外に施設が残っていても弾かず落とす（select が隠れているだけ）。
      propertyId: rawType === "WORK" && rawProperty !== "" ? rawProperty : null,
      breakMinutes: 60,
    });
    if (!parsed.success) return { invalid: true };
    await upsertShift(env, tenant, {
      membershipId: parsed.data.membershipId,
      businessDate: parsed.data.businessDate,
      shiftType: parsed.data.shiftType,
      propertyId: parsed.data.propertyId ?? null,
      startAt: null,
      endAt: null,
      breakMinutes: parsed.data.breakMinutes,
      note: null,
    });
    saved += 1;
  }
  return { saved };
}

/** `YYYY-MM-DD` に日を足す。 */
function addDays(date: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return date;
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days);
  return new Date(at).toISOString().slice(0, 10);
}

const ROW_STATUS_KEY = {
  DONE: "shifts.row.done",
  WORKING: "shifts.row.working",
  NOT_STARTED: "shifts.row.notStarted",
} as const;

/** 当日の割当（プロトタイプの「👥 本日の割当」）。**読むだけの表。** */
function BoardTable({ rows }: { rows: readonly ShiftBoardRow[] }) {
  if (rows.length === 0) return <p className="pk-muted">{t("shifts.board.empty")}</p>;
  return (
    <table className="pk-grid">
      <thead>
        <tr>
          <th>{t("shifts.board.name")}</th>
          <th>{t("shifts.board.property")}</th>
          <th>{t("shifts.board.assigned")}</th>
          <th>{t("shifts.board.completed")}</th>
          <th>{t("shifts.board.percent")}</th>
          <th>{t("shifts.board.status")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.membershipId}>
            <th scope="row">{row.displayName}</th>
            <td>{row.propertyName ?? "—"}</td>
            <td>{String(row.assigned)}</td>
            <td>{String(row.completed)}</td>
            <td>{row.percent === null ? "—" : `${String(row.percent)}%`}</td>
            <td>{t(ROW_STATUS_KEY[row.status])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function Shifts() {
  const data = useLoaderData<ShiftsData>();
  const result = useActionData<ShiftsActionResult>();

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("shifts.title")}</h1>
        <div className="pk-pagehead__actions">
          <Form method="get">
            <input
              className="pk-input"
              type="date"
              name="businessDate"
              defaultValue={data.businessDate}
            />
            <button className="pk-button" type="submit">
              {t("shifts.show")}
            </button>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value="copy-week" />
            <input type="hidden" name="businessDate" value={data.businessDate} />
            <button className="pk-button" type="submit">
              {t("shifts.copyWeek")}
            </button>
          </Form>
        </div>
      </div>

      {result !== undefined && "invalid" in result ? (
        <p className="pk-notice">{t("shifts.invalid")}</p>
      ) : null}
      {result !== undefined && "saved" in result ? (
        <p className="pk-notice">{`${t("shifts.saved")}: ${String(result.saved)}`}</p>
      ) : null}
      {result !== undefined && "copied" in result ? (
        <p className="pk-notice">
          {`${t("shifts.copied")}: ${String(result.copied)} / ${t("shifts.copySkipped")}: ${String(result.copySkipped)}`}
        </p>
      ) : null}

      <ul className="pk-board__counts">
        <li>{`${t("shifts.kpi.planned")} ${String(data.board.summary.planned)}`}</li>
        <li>{`${t("shifts.kpi.present")} ${String(data.board.summary.present)}`}</li>
        <li>{`${t("shifts.kpi.absent")} ${String(data.board.summary.absent)}`}</li>
        <li>{`${t("shifts.kpi.unassigned")} ${String(data.board.summary.unassignedTasks)}`}</li>
      </ul>

      <h2 className="pk-section__title">{t("shifts.board.title")}</h2>
      <BoardTable rows={data.board.rows} />

      {/* 今週のシフト = 出勤者数の棒グラフ 1 本（プロトタイプ ops 02）。 */}
      <h2 className="pk-section__title">{t("shifts.week.title")}</h2>
      <div className="pk-bars">
        {data.board.week.map((bar) => {
          const max = Math.max(1, ...data.board.week.map((point) => point.count));
          return (
            <div
              className={`pk-bars__col${bar.businessDate === data.businessDate ? " pk-bars__col--on" : ""}`}
              key={bar.businessDate}
            >
              <span className="pk-bars__value">{String(bar.count)}</span>
              <span
                className="pk-bars__bar"
                style={{ height: `${String(Math.round((bar.count / max) * 100))}%` }}
              />
              <span className="pk-bars__label">{bar.businessDate.slice(5)}</span>
            </div>
          );
        })}
      </div>
      <p className="pk-muted">
        {`${t("shifts.week.registered")}: ${String(data.board.registeredStaff)} / ${t("shifts.week.average")}: ${String(data.board.weekAverage)}`}
      </p>

      {/* その日のシフトの入力。**1 日ぶんをまとめて保存**（ヘッダーの並びどおり）。 */}
      <h2 className="pk-section__title">{t("shifts.entry.title")}</h2>
      <Form method="post" className="pk-form">
        <input type="hidden" name="businessDate" value={data.businessDate} />
        <table className="pk-grid">
          <thead>
            <tr>
              <th>{t("shifts.board.name")}</th>
              <th>{t("shifts.entry.type")}</th>
              <th>{t("shifts.entry.property")}</th>
            </tr>
          </thead>
          <tbody>
            {data.entries.map((entry) => (
              <tr key={entry.membershipId}>
                <th scope="row">
                  {entry.displayName}
                  <input type="hidden" name="memberId" value={entry.membershipId} />
                </th>
                <td>
                  <select
                    className="pk-select"
                    name={`shiftType:${entry.membershipId}`}
                    defaultValue={entry.shiftType ?? ""}
                  >
                    <option value="">{t("shifts.type.none")}</option>
                    {SHIFT_TYPE_VALUES.map((value) => (
                      <option key={value} value={value}>
                        {t(`shifts.type.${value}` as Parameters<typeof t>[0])}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    className="pk-select"
                    name={`propertyId:${entry.membershipId}`}
                    defaultValue={entry.propertyId ?? ""}
                  >
                    <option value="">—</option>
                    {data.properties.map((property) => (
                      <option key={property.id} value={property.id}>
                        {property.name}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="pk-form__note">{t("shifts.entry.note")}</p>
        <button className="pk-button pk-button--primary" type="submit">
          {t("shifts.save")}
        </button>
      </Form>

      {/* ⚙️ 自動割当のルール（プロトタイプ ops 02 / P8-04 の実装を説明する）。
          **表示だけ。** ここから変えられる形にしない。

          **書いてあるのは実装どおりのことだけ。** プロトタイプの
          「連続勤務日数の上限 5日」「前回の担当を優先する」は実装が無いので
          出さない — 効いていない規則を並べると、効いていると読まれる。
          上限も「16室」ではなく実装どおり標準時間の合計で書く。 */}
      <section className="pk-panel">
        <div className="pk-panel__head">
          <span className="pk-panel__icon" aria-hidden="true">
            ⚙️
          </span>
          {t("shifts.rules.title")}
          <span className="pk-lock">{t("shifts.rules.lock")}</span>
        </div>
        <div className="pk-panel__body">
          {RULE_ROWS.map((rule) => (
            <div key={rule.label} className="pk-qrow">
              <div>
                <div className="pk-qrow__label">{t(rule.label)}</div>
                <p className="pk-qrow__note">{t(rule.note)}</p>
              </div>
              {rule.value === undefined ? null : (
                <span className="pk-qrow__value">{rule.value}</span>
              )}
            </div>
          ))}
        </div>
        <div className="pk-panel__foot">{t("shifts.rules.note")}</div>
      </section>
    </section>
  );
}

/**
 * ルールカードの行（P8-04 の実装と 1 対 1）。
 *
 * 規則を足したら**ここにも 1 行足す。** 実装だけ変えて説明を据え置くと、
 * 画面が嘘をつく。
 */
const RULE_ROWS: readonly {
  label: Parameters<typeof t>[0];
  note: Parameters<typeof t>[0];
  value?: string;
}[] = [
  { label: "shifts.rules.property", note: "shifts.rules.propertyNote" },
  { label: "shifts.rules.skill", note: "shifts.rules.skillNote" },
  { label: "shifts.rules.experience", note: "shifts.rules.experienceNote" },
  { label: "shifts.rules.training", note: "shifts.rules.trainingNote" },
  {
    label: "shifts.rules.limit",
    note: "shifts.rules.limitNote",
    value: `${String(WORKLOAD_LIMIT_MINUTES)}${t("shifts.rules.unit.minutes")}`,
  },
];
