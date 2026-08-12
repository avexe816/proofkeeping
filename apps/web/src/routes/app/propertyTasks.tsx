/**
 * W-04 タスク管理・人員配分（PK-SPEC-P1 §4・§10.2）。
 *
 *   /app/p/{propertyId}/tasks
 *
 * task:  docs/tasks/P1-14.md
 * 契約:  docs/PK-IMPL-CONTRACT.md §1.2（INV-06）
 *
 * ── 自動配分は必ずプレビューを挟む ──────────────────────
 * §4.1 MUST / §10.2。**「自動配分」で配られない。** 提案を描いてから、
 * 「この内容で確定する」を押して初めて DB が変わる。action の intent が
 * `preview` と `apply-auto` に分かれているのはそのため。**片方に
 * まとめないこと。**
 *
 * ── 作業中の担当変更は警告してから ──────────────────────
 * §4.2。`applyAssignments()` は確認の無い引き継ぎを見送り、
 * 対象のタスクを返す。画面はそれを示し、確認のうえで送り直す。
 *
 * ── 負荷は評価ではない ──────────────────────────────────
 * §4.3 の棒グラフは当日の割り当ての偏りを見るためのもの。
 * 実績（実作業時間）を混ぜない。画面にも「評価には使用しません」を出す
 * （security.md §5）。
 *
 * ── 氏名の出し分け ──────────────────────────────────────
 * INV-06。`OWNER` / `AUDITOR` の画面ではスタッフ番号だけを出し、
 * 氏名の位置に「非表示」バッジを置く（`lib/ui/staffName.ts`）。
 */

import { NotFoundError } from "@pk/db";
import { useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useSubmit,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { assertPermission, propertyTarget } from "../../lib/auth/permission.js";
import { businessDateOf } from "../../lib/businessDate.js";
import { t } from "../../lib/i18n.js";
import { switchProperty } from "../../lib/property/selection.js";
import {
  applyAssignments,
  loadAssignmentBoard,
  previewAutoAssignment,
} from "../../lib/task/assign.js";
import { generateTasksForProperty } from "../../lib/task/generate.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";
import { canViewStaffName } from "../../lib/ui/staffName.js";

/** 画面に出す 1 タスク。**担当者の氏名を持たない**（列は下の `staff`）。 */
interface TaskChip {
  taskId: string;
  roomNumber: string;
  standardMinutes: number;
  /** 作業中・中断中・入室不可。引き継ぎに確認が要る（§4.2）。 */
  isActive: boolean;
  assigneeId: string | null;
}

interface StaffRow {
  membershipId: string;
  staffNumber: string;
  /** 氏名。**伏せるロールでは `null`**（INV-06）。 */
  displayName: string | null;
  taskCount: number;
  minutes: number;
  overLimit: boolean;
}

interface TasksData {
  propertyId: string;
  businessDate: string;
  limitMinutes: number;
  staff: readonly StaffRow[];
  tasks: readonly TaskChip[];
  unassigned: { taskCount: number; minutes: number };
}

export async function loader({ request, params, context }: LoaderFunctionArgs): Promise<TasksData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant, cookieValue } = await requireAppContext(env, request, now);

  const propertyId = params["propertyId"];
  if (propertyId === undefined) throw new NotFoundError();

  // URL を正としてセッションを更新する（PK-SPEC-P0 §23.5 / W-03 と同じ）。
  await switchProperty(env, tenant, cookieValue, propertyId, now, session.membershipId);

  const businessDate = new URL(request.url).searchParams.get("date") ?? businessDateOf(now);
  const board = await loadAssignmentBoard(env, tenant, propertyId, businessDate);
  const showName = canViewStaffName(tenant.role);
  const loadByStaff = new Map(board.loads.map((row) => [row.membershipId, row]));

  return {
    propertyId,
    businessDate,
    limitMinutes: board.limitMinutes,
    staff: board.staff.map((person) => ({
      membershipId: person.membershipId,
      staffNumber: person.staffNumber,
      displayName: showName ? person.displayName : null,
      taskCount: loadByStaff.get(person.membershipId)?.taskCount ?? 0,
      minutes: loadByStaff.get(person.membershipId)?.minutes ?? 0,
      overLimit: loadByStaff.get(person.membershipId)?.overLimit ?? false,
    })),
    tasks: board.tasks.map((task) => ({
      taskId: task.taskId,
      roomNumber: task.roomNumber,
      standardMinutes: task.standardMinutes,
      isActive: task.status !== "CREATED" && task.status !== "ASSIGNED",
      assigneeId: task.assigneeId,
    })),
    unassigned: board.unassigned,
  };
}

/** action の結果。**文言を持たない。** 画面が i18n キーへ写す。 */
interface TasksActionResult {
  /** 自動配分の提案（プレビュー）。確定するまで DB は変わらない。 */
  preview?: {
    pairs: readonly { taskId: string; membershipId: string }[];
    loads: readonly { membershipId: string; taskCount: number; minutes: number; overLimit: boolean }[];
    unassignedTaskIds: readonly string[];
  };
  applied?: number;
  /** 作業中のため見送った（§4.2 の警告）。確認して送り直す。 */
  activeTaskIds?: readonly string[];
  /** 見送ったぶんの送り先。**再送のときに取り違えないための持ち回り。** */
  pendingMembershipId?: string;
  generated?: { created: number; updated: number; cancelled: number; revived: number };
  invalid?: boolean;
}

function fieldOf(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export async function action({
  request,
  params,
  context,
}: ActionFunctionArgs): Promise<TasksActionResult> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  const propertyId = params["propertyId"];
  if (propertyId === undefined) throw new NotFoundError();
  // **クライアントの `propertyId` を権限の対象にしない。** ここはパス変数だが、
  // `loadAssignmentBoard()` / `applyAssignments()` が資源を引き直して判定する。
  assertPermission(tenant, "task.manage", propertyTarget([propertyId]));

  const form = await request.formData();
  const intent = form.get("intent");
  const businessDate = fieldOf(form, "businessDate") || businessDateOf(now);
  const ip = request.headers.get("CF-Connecting-IP") ?? undefined;

  if (intent === "regenerate") {
    const result = await generateTasksForProperty(env, tenant, propertyId, businessDate);
    return { generated: result };
  }

  if (intent === "preview") {
    const board = await loadAssignmentBoard(env, tenant, propertyId, businessDate);
    return { preview: previewAutoAssignment(board) };
  }

  if (intent === "apply-auto") {
    const pairs = parsePairs(fieldOf(form, "pairs"));
    if (pairs === null) return { invalid: true };
    const result = await applyAssignments(env, tenant, {
      propertyId,
      businessDate,
      pairs,
      actorId: session.membershipId,
      // 自動配分が触るのは未着手だけ（`isAssignable()`）。引き継ぎは起きない。
      confirmActive: false,
      ip,
    });
    return { applied: result.applied, activeTaskIds: result.activeTaskIds };
  }

  if (intent === "assign") {
    const taskIds = form.getAll("taskId").filter((value): value is string => typeof value === "string");
    if (taskIds.length === 0) return { invalid: true };
    const raw = fieldOf(form, "membershipId");
    const result = await applyAssignments(env, tenant, {
      propertyId,
      businessDate,
      pairs: taskIds.map((taskId) => ({ taskId, membershipId: raw === "" ? null : raw })),
      actorId: session.membershipId,
      confirmActive: fieldOf(form, "confirmActive") === "1",
      ip,
    });
    return {
      applied: result.applied,
      activeTaskIds: result.activeTaskIds,
      pendingMembershipId: raw,
    };
  }

  return { invalid: true };
}

/** プレビューの組み合わせを読む。**形が違えば拒否**（`null`）。 */
function parsePairs(raw: string): { taskId: string; membershipId: string }[] | null {
  if (raw === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const pairs: { taskId: string; membershipId: string }[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) return null;
    const record = entry as Record<string, unknown>;
    if (typeof record["taskId"] !== "string" || typeof record["membershipId"] !== "string") {
      return null;
    }
    pairs.push({ taskId: record["taskId"], membershipId: record["membershipId"] });
  }
  return pairs;
}

export default function PropertyTasks(): React.ReactElement {
  const data = useLoaderData<TasksData>();
  const result = useActionData<TasksActionResult>();
  const submit = useSubmit();
  const [selected, setSelected] = useState<readonly string[]>([]);

  const byAssignee = (membershipId: string | null): readonly TaskChip[] =>
    data.tasks.filter((task) => task.assigneeId === membershipId);

  /** ドラッグで担当を移す。**送る値は担当者 1 人とタスク 1 件だけ。** */
  const drop = (taskId: string, membershipId: string | null): void => {
    const task = data.tasks.find((row) => row.taskId === taskId);
    if (task === undefined || task.assigneeId === membershipId) return;
    const form = new FormData();
    form.set("intent", "assign");
    form.set("businessDate", data.businessDate);
    form.set("membershipId", membershipId ?? "");
    form.set("taskId", taskId);
    void submit(form, { method: "post" });
  };

  const toggle = (taskId: string): void => {
    setSelected((current) =>
      current.includes(taskId) ? current.filter((id) => id !== taskId) : [...current, taskId],
    );
  };

  const previewLoad = new Map(
    (result?.preview?.loads ?? []).map((row) => [row.membershipId, row]),
  );

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("tasks.title")}</h1>
        <p className="pk-muted">{data.businessDate}</p>
      </div>

      <div className="pk-toolbar">
        <Form method="post">
          <input type="hidden" name="intent" value="regenerate" />
          <input type="hidden" name="businessDate" value={data.businessDate} />
          <button className="pk-button" type="submit">
            {t("tasks.regenerate")}
          </button>
        </Form>
        <Form method="post">
          <input type="hidden" name="intent" value="preview" />
          <input type="hidden" name="businessDate" value={data.businessDate} />
          <button className="pk-button pk-button--primary" type="submit">
            {t("tasks.autoAssign")}
          </button>
        </Form>
      </div>

      {result?.invalid === true ? <p className="pk-notice">{t("tasks.invalid")}</p> : null}
      {result?.generated === undefined ? null : (
        <p className="pk-notice">
          {`${t("tasks.generated")}: ${String(result.generated.created)} / ` +
            `${t("tasks.cancelled")}: ${String(result.generated.cancelled)}`}
        </p>
      )}
      {result?.applied === undefined ? null : (
        <p className="pk-notice">{`${t("tasks.applied")}: ${String(result.applied)}`}</p>
      )}

      {/* §4.2 の「作業中の担当変更は警告を出す」。確認して送り直す。 */}
      {result?.activeTaskIds === undefined || result.activeTaskIds.length === 0 ? null : (
        <Form method="post" className="pk-notice pk-notice--warn">
          <p>{t("tasks.handover.warning")}</p>
          <input type="hidden" name="intent" value="assign" />
          <input type="hidden" name="businessDate" value={data.businessDate} />
          <input type="hidden" name="confirmActive" value="1" />
          <input type="hidden" name="membershipId" value={result.pendingMembershipId ?? ""} />
          {result.activeTaskIds.map((taskId) => (
            <input key={taskId} type="hidden" name="taskId" value={taskId} />
          ))}
          <button className="pk-button" type="submit">
            {t("tasks.handover.confirm")}
          </button>
        </Form>
      )}

      {/* §4.1 MUST のプレビュー。**ここで確定するまで DB は変わらない。** */}
      {result?.preview === undefined ? null : (
        <Form method="post" className="pk-preview">
          <h2 className="pk-preview__title">{t("tasks.preview.title")}</h2>
          <p className="pk-muted">
            {`${t("tasks.preview.count")}: ${String(result.preview.pairs.length)} / ` +
              `${t("tasks.preview.unassigned")}: ${String(result.preview.unassignedTaskIds.length)}`}
          </p>
          <ul className="pk-preview__list">
            {data.staff.map((person) => (
              <li key={person.membershipId}>
                <StaffLabel staff={person} />
                {` ${String(previewLoad.get(person.membershipId)?.taskCount ?? 0)}${t("tasks.unit.count")} / ` +
                  `${String(previewLoad.get(person.membershipId)?.minutes ?? 0)}${t("tasks.unit.minutes")}`}
                {previewLoad.get(person.membershipId)?.overLimit === true
                  ? ` ⚠ ${t("tasks.overLimit")}`
                  : ""}
              </li>
            ))}
          </ul>
          <input type="hidden" name="intent" value="apply-auto" />
          <input type="hidden" name="businessDate" value={data.businessDate} />
          <input type="hidden" name="pairs" value={JSON.stringify(result.preview.pairs)} />
          <button className="pk-button pk-button--primary" type="submit">
            {t("tasks.preview.apply")}
          </button>
        </Form>
      )}

      {/* 一括選択 → 担当者変更（§10.2）。ドラッグできない環境でも配れる。 */}
      <Form method="post" className="pk-bulk">
        <input type="hidden" name="intent" value="assign" />
        <input type="hidden" name="businessDate" value={data.businessDate} />
        {selected.map((taskId) => (
          <input key={taskId} type="hidden" name="taskId" value={taskId} />
        ))}
        <label htmlFor="bulk-assignee">{t("tasks.bulk.assignee")}</label>
        <select id="bulk-assignee" name="membershipId" className="pk-select">
          <option value="">{t("tasks.unassigned")}</option>
          {data.staff.map((person) => (
            <option key={person.membershipId} value={person.membershipId}>
              {labelOf(person)}
            </option>
          ))}
        </select>
        <button className="pk-button" type="submit" disabled={selected.length === 0}>
          {`${t("tasks.bulk.apply")}（${String(selected.length)}）`}
        </button>
      </Form>

      <table className="pk-assign">
        <thead>
          <tr>
            <th>{t("tasks.column.staff")}</th>
            <th>{t("tasks.column.tasks")}</th>
          </tr>
        </thead>
        <tbody>
          {data.staff.map((person) => (
            <AssignRow
              key={person.membershipId}
              staff={person}
              limitMinutes={data.limitMinutes}
              tasks={byAssignee(person.membershipId)}
              selected={selected}
              onToggle={toggle}
              onDrop={(taskId) => {
                drop(taskId, person.membershipId);
              }}
            />
          ))}
          <AssignRow
            staff={null}
            limitMinutes={data.limitMinutes}
            tasks={byAssignee(null)}
            selected={selected}
            unassigned={data.unassigned}
            onToggle={toggle}
            onDrop={(taskId) => {
              drop(taskId, null);
            }}
          />
        </tbody>
      </table>

      {/* security.md §5。スタッフ別の数字を出す画面には必ず添える。 */}
      <p className="pk-muted pk-assign__note">{t("tasks.notForEvaluation")}</p>
    </section>
  );
}


function labelOf(staff: StaffRow): string {
  return staff.displayName === null
    ? `${staff.staffNumber}（${t("staff.nameHidden")}）`
    : `${staff.displayName}（${staff.staffNumber}）`;
}

function StaffLabel({ staff }: { staff: StaffRow }): React.ReactElement {
  // INV-06: **空欄にしない。** 伏せていることを明示する。
  if (staff.displayName === null) {
    return (
      <span>
        {staff.staffNumber}
        <span className="pk-badge pk-badge--hidden">{t("staff.nameHidden")}</span>
      </span>
    );
  }
  return <span>{`${staff.displayName}（${staff.staffNumber}）`}</span>;
}

interface AssignRowProps {
  staff: StaffRow | null;
  limitMinutes: number;
  tasks: readonly TaskChip[];
  selected: readonly string[];
  unassigned?: { taskCount: number; minutes: number };
  onToggle: (taskId: string) => void;
  onDrop: (taskId: string) => void;
}

/**
 * 1 行（スタッフ 1 人ぶん、または未割当）。
 *
 * ドラッグ＆ドロップは**素の HTML5 DnD。** 触れない環境（キーボード操作・
 * タッチ）でも一括選択で同じことができる（上の `pk-bulk`）。
 * 片方しか無い実装にしないこと。
 */
function AssignRow({
  staff,
  limitMinutes,
  tasks,
  selected,
  unassigned,
  onToggle,
  onDrop,
}: AssignRowProps): React.ReactElement {
  const minutes = staff?.minutes ?? unassigned?.minutes ?? 0;
  const count = staff?.taskCount ?? unassigned?.taskCount ?? 0;
  const ratio = Math.min(100, Math.round((minutes / limitMinutes) * 100));

  return (
    <tr className={staff?.overLimit === true ? "pk-assign__row pk-assign__row--over" : "pk-assign__row"}>
      <th scope="row">
        {staff === null ? <span>{t("tasks.unassigned")}</span> : <StaffLabel staff={staff} />}
        <span className="pk-assign__load">
          {`${String(count)}${t("tasks.unit.count")} / ${String(minutes)}${t("tasks.unit.minutes")}`}
        </span>
        {/* §4.3 の棒。**超過はオレンジまで。赤にしない**（INV-05 の趣旨）。 */}
        <span className="pk-assign__bar" aria-hidden="true">
          <span className="pk-assign__bar-fill" style={{ width: `${String(ratio)}%` }} />
        </span>
        {staff?.overLimit === true ? (
          <span className="pk-badge pk-badge--warn">{t("tasks.overLimit")}</span>
        ) : null}
      </th>
      <td
        onDragOver={(event) => {
          event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          const taskId = event.dataTransfer.getData("text/plain");
          if (taskId !== "") onDrop(taskId);
        }}
      >
        {tasks.map((task) => (
          <label
            key={task.taskId}
            className={task.isActive ? "pk-chip pk-chip--active" : "pk-chip"}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData("text/plain", task.taskId);
            }}
          >
            <input
              type="checkbox"
              checked={selected.includes(task.taskId)}
              onChange={() => {
                onToggle(task.taskId);
              }}
            />
            {task.roomNumber}
          </label>
        ))}
      </td>
    </tr>
  );
}
