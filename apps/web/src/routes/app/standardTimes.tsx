import { NotFoundError, listRoomTypes, listStandardTimes, recordAudit, upsertStandardTimes } from "@pk/db";
import { Form, useActionData, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";

import { assertPermission, can, propertyTarget } from "../../lib/auth/permission.js";
import { t } from "../../lib/i18n.js";
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
 * W-17 標準時間設定（PK-SPEC-P1 §3.1 / §10.1）。
 *
 *   /app/settings/standard-times
 *
 * task: docs/tasks/P1-02.md（API は同 task が実装済み。**画面がこれ**）
 *
 * ── 施設ごとの設定である ────────────────────────────────
 * `standardTime` の一意制約は `(organizationId, propertyId, roomTypeId, taskType)`。
 * §10.1 の担当ロールは `ORG_ADMIN` だが、**設定の対象は表示中の施設**。
 * 施設セレクタを切り替えると別の施設の表になる。
 *
 * ── 既定分数を空欄にしない ──────────────────────────────
 * 未設定のセルには §3.1 の既定分数が効いている。判断は
 * `lib/standardTime/matrix.ts` にある（`isDefault`）。
 *
 * ── 過去のタスクは変わらない ────────────────────────────
 * PK-SPEC-P0 §24.5。`cleaningTask.standardMinutes` は生成時に写した値で、
 * ここを変えても既存タスクは動かない。画面にその旨を出す。
 */

interface StandardTimesData {
  propertyId: string | null;
  propertyName: string | null;
  rows: readonly MatrixRow[];
  canWrite: boolean;
}

export async function loader({
  request,
  context,
}: LoaderFunctionArgs): Promise<StandardTimesData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  const properties = await listSelectableProperties(env, tenant);
  const { property } = resolveSelectedScope(session.selectedPropertyId, tenant, properties);
  if (property === null) {
    return { propertyId: null, propertyName: null, rows: [], canWrite: false };
  }

  assertPermission(tenant, "standardTime.read", propertyTarget([property.id]));

  const [roomTypes, saved] = await Promise.all([
    listRoomTypes(env, tenant, property.id),
    listStandardTimes(env, tenant, property.id),
  ]);

  return {
    propertyId: property.id,
    propertyName: property.name,
    rows: buildMatrix({
      roomTypes: roomTypes.map((type) => ({ id: type.id, code: type.code, name: type.name })),
      saved: saved.map((row) => ({
        roomTypeId: row.roomTypeId,
        taskType: row.taskType,
        minutes: row.minutes,
      })),
    }),
    // 読めるが書けないロール（`AUDITOR`）で入力欄を出さないため。
    // **これは権限制御ではない**（action 側の `assertPermission` が守る）。
    canWrite: can(tenant, "standardTime.write", propertyTarget([property.id])),
  };
}

interface StandardTimesActionResult {
  applied?: number;
  rejected?: number;
}

export async function action({
  request,
  context,
}: ActionFunctionArgs): Promise<StandardTimesActionResult> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  const properties = await listSelectableProperties(env, tenant);
  const { property } = resolveSelectedScope(session.selectedPropertyId, tenant, properties);
  if (property === null) throw new NotFoundError();

  assertPermission(tenant, "standardTime.write", propertyTarget([property.id]));

  const form = await request.formData();
  const [roomTypes, before] = await Promise.all([
    listRoomTypes(env, tenant, property.id),
    listStandardTimes(env, tenant, property.id),
  ]);

  // **表を作り直してから読む。** フォームが送ってきた `roomTypeId` を
  // そのまま信用しない（その施設の客室タイプに限る / INV-32 と同じ向き）。
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

  if (parsed.entries.length === 0) {
    return { applied: 0, rejected: parsed.rejected.length };
  }

  const applied = await upsertStandardTimes(env, tenant, property.id, parsed.entries);

  await recordAudit(env, tenant, {
    actorId: session.membershipId,
    // API 側（`routes/api/v1/standardTimes.ts`）と同じ `action` を使う。
    // `AUDIT_ACTIONS` は閉じたレジストリで、標準時間専用の行は
    // security.md §6 に根拠が無い。
    action: "property.updated",
    targetType: "standardTime",
    targetId: property.id,
    propertyId: property.id,
    before: before.map((row) => ({
      roomTypeId: row.roomTypeId,
      taskType: row.taskType,
      minutes: row.minutes,
    })),
    after: parsed.entries,
  });

  return { applied, rejected: parsed.rejected.length };
}

export default function StandardTimes() {
  const data = useLoaderData<StandardTimesData>();
  const result = useActionData<StandardTimesActionResult>();

  if (data.propertyId === null) {
    return (
      <section className="pk-page">
        <h1 className="pk-page__title">{t("stdtime.title")}</h1>
        <p className="pk-notice">{t("stdtime.noProperty")}</p>
      </section>
    );
  }

  return (
    <section className="pk-page">
      <h1 className="pk-page__title">{t("stdtime.title")}</h1>
      <p className="pk-muted">{data.propertyName}</p>

      {result?.applied === undefined ? null : (
        <p className="pk-notice">{`${t("stdtime.saved")}: ${String(result.applied)}`}</p>
      )}
      {result?.rejected === undefined || result.rejected === 0 ? null : (
        <p className="pk-notice pk-notice--warn">
          {`${t("stdtime.rejected")}: ${String(result.rejected)}`}
        </p>
      )}

      {/* §24.5: 既存タスクの標準時間は変わらない。事実として述べる。 */}
      <p className="pk-notice">{t("stdtime.appliesToNewTasks")}</p>

      {data.rows.length === 0 ? (
        <p className="pk-notice">{t("stdtime.noRoomTypes")}</p>
      ) : (
        <Form method="post">
          <table className="pk-grid">
            <thead>
              <tr>
                <th>{t("stdtime.roomType")}</th>
                {EDITABLE_TASK_TYPES.map((taskType) => (
                  <th key={taskType}>{t(`stdtime.taskType.${taskType}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.roomTypeId}>
                  <th scope="row">
                    {row.name}
                    <span className="pk-muted">{` (${row.code})`}</span>
                  </th>
                  {row.cells.map((cell) => (
                    <td key={cell.taskType}>
                      {data.canWrite ? (
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
                        <span className="pk-badge pk-badge--hidden">{t("stdtime.isDefault")}</span>
                      ) : null}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {data.canWrite ? (
            <button className="pk-button pk-button--primary" type="submit">
              {t("stdtime.save")}
            </button>
          ) : null}
        </Form>
      )}
    </section>
  );
}
