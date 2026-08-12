import {
  NotFoundError,
  createTemplate,
  deactivateTemplate,
  listRoomTypes,
  listTemplateItems,
  listTemplates,
  recordAudit,
  replaceTemplateItems,
  type Env,
  type TenantContext,
} from "@pk/db";
import {
  Form,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { ORGANIZATION_TARGET, assertPermission, can } from "../../lib/auth/permission.js";
import {
  buildTemplateViews,
  mergeTranslations,
  parseItems,
  resolveEffective,
  type TemplateView,
} from "../../lib/checklist/settings.js";
import { t } from "../../lib/i18n.js";
import { listSelectableProperties, resolveSelectedScope } from "../../lib/property/selection.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

/**
 * W-16 チェックリスト定義（PK-SPEC-P1 §6 / §10.1）。
 *
 *   /app/settings/checklists
 *
 * task: docs/tasks/P1-06.md（API は同 task が実装済み。**画面がこれ**）
 *
 * ── 3 階層のうち 1 つだけが効く ──────────────────────────
 * §6.1。テンプレートを並べただけでは「どれが現場に出るのか」に答えられない。
 * 表示中の施設について `resolveEffective()` を通し、効いているものに印を付ける。
 * **判定は生成と同じ `resolveTemplate()`**（実装を 2 つ持たない）。
 *
 * ── 項目の差し替えは版を上げる ──────────────────────────
 * §2.2。`replaceTemplateItems()` が版を 1 上げ、実施済みの記録は
 * `templateVersion` で当時の版に固定される。**画面にそれを明示する。**
 *
 * ── 削除の口を作らない ──────────────────────────────────
 * 無効化（`deactivateTemplate()`）だけ。過去の `taskChecklistResult` が
 * 項目行を参照しているため（CLAUDE.md §4「発行済み帳票…」と同じ向き）。
 *
 * ── 一括で必須を付け外しする欄を置かない ────────────────
 * §6.3 の「すべてチェック」を置かないのと同じ理由。必須をまとめて外せる
 * 操作は、記録の質を落とす方向にだけ効く。
 */

interface ChecklistsData {
  /** 効いているものを判定するための施設。無ければ印を付けない。 */
  propertyId: string | null;
  propertyName: string | null;
  templates: readonly TemplateView[];
  /** その施設で実際に選ばれるテンプレートの ID。 */
  effectiveIds: readonly string[];
  roomTypes: readonly { id: string; name: string }[];
  canWrite: boolean;
}

/** 画面が扱う清掃種別。P1 の生成が立てるのはこの 2 種（§3.2）。 */
const TASK_TYPES = ["CHECKOUT", "STAYOVER"] as const;

export async function loader({ request, context }: LoaderFunctionArgs): Promise<ChecklistsData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);
  assertPermission(tenant, "checklistTemplate.read", ORGANIZATION_TARGET);

  const properties = await listSelectableProperties(env, tenant);
  const { property } = resolveSelectedScope(session.selectedPropertyId, tenant, properties);

  // **テンプレートは組織条件だけで引く**（`listTemplates()` の注記。
  // 組織共通テンプレートは `propertyId = null` なので施設で絞れない）。
  const templates = await listTemplates(env, tenant);
  const items = await listTemplateItems(
    env,
    tenant,
    templates.map((template) => template.id),
  );
  const roomTypes = property === null ? [] : await listRoomTypes(env, tenant, property.id);

  const views = buildTemplateViews({
    templates: templates.map((template) => ({
      id: template.id,
      name: template.name,
      taskType: template.taskType,
      version: template.version,
      propertyId: template.propertyId,
      roomTypeId: template.roomTypeId,
      isActive: template.isActive,
    })),
    items: items.map((item) => ({
      templateId: item.templateId,
      section: item.section,
      labels: item.labels,
      isRequired: item.isRequired,
      photoRequired: item.photoRequired,
      sortOrder: item.sortOrder,
    })),
    roomTypes: roomTypes.map((type) => ({ id: type.id, name: type.name })),
  });

  // 客室タイプが 1 つも無い施設でも、タイプ未設定の客室に効くものは示せる。
  const scopes: readonly (string | null)[] =
    roomTypes.length === 0 ? [null] : [...roomTypes.map((type) => type.id), null];

  return {
    propertyId: property?.id ?? null,
    propertyName: property?.name ?? null,
    templates: views,
    effectiveIds:
      property === null
        ? []
        : [
            ...resolveEffective(
              templates.map((template) => ({
                id: template.id,
                propertyId: template.propertyId,
                roomTypeId: template.roomTypeId,
                taskType: template.taskType,
                isActive: template.isActive,
              })),
              property.id,
              scopes,
              TASK_TYPES,
            ),
          ],
    roomTypes: roomTypes.map((type) => ({ id: type.id, name: type.name })),
    canWrite: can(tenant, "checklistTemplate.write", ORGANIZATION_TARGET),
  };
}

interface ChecklistsActionResult {
  savedTemplateId?: string;
  createdTemplateId?: string;
  deactivatedTemplateId?: string;
  /** 読めなかった行の番号。 */
  skippedLines?: readonly number[];
  invalid?: boolean;
}

export async function action({
  request,
  context,
}: ActionFunctionArgs): Promise<ChecklistsActionResult> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);
  assertPermission(tenant, "checklistTemplate.write", ORGANIZATION_TARGET);

  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "replace-items") {
    const templateId = fieldOf(form, "templateId");
    if (templateId === "") return { invalid: true };

    // **その組織のテンプレートであることを確かめる。** ID の越境は
    // `replaceTemplateItems()` の `assertIdBelongsToTenant()` が落とすが、
    // 「存在するか」は一覧で確かめる（無い ID を静かに通さない）。
    const templates = await listTemplates(env, tenant);
    const target = templates.find((template) => template.id === templateId);
    if (target === undefined) throw new NotFoundError();

    const parsed = parseItems(fieldOf(form, "items"));
    // 訳文（`labels.en`）を引き継ぐ。この画面は日本語しか編集できない（§12.1）。
    const existing = await listTemplateItems(env, tenant, [templateId]);
    const items = mergeTranslations(
      parsed.items,
      existing.map((item) => ({ labels: item.labels })),
    );

    const name = fieldOf(form, "name").trim();
    await replaceTemplateItems(env, tenant, templateId, {
      name: name === "" ? target.name : name,
      items,
    });

    await recordAudit(env, tenant, {
      actorId: session.membershipId,
      // `AUDIT_ACTIONS` は閉じたレジストリ。チェックリスト専用の行は
      // security.md §6 に根拠が無いため足していない（標準時間と同じ判断）。
      action: "property.updated",
      targetType: "checklistTemplate",
      targetId: templateId,
      before: { name: target.name, version: target.version, itemCount: existing.length },
      after: { name: name === "" ? target.name : name, itemCount: items.length },
    });

    return { savedTemplateId: templateId, skippedLines: parsed.skippedLines };
  }

  if (intent === "create") {
    const taskType = fieldOf(form, "taskType");
    const name = fieldOf(form, "name").trim();
    if (name === "" || (taskType !== "CHECKOUT" && taskType !== "STAYOVER")) {
      return { invalid: true };
    }

    // **施設 ID をフォームから受け取らない。** 表示中の施設（セッション）から
    // 解く。CLAUDE.md §4 が `organizationId` について定めるのと同じ向きで、
    // どの施設のテンプレートを作るかを画面に指定させない。
    const properties = await listSelectableProperties(env, tenant);
    const { property } = resolveSelectedScope(session.selectedPropertyId, tenant, properties);
    const scope = await resolveNewTemplateScope(
      env,
      tenant,
      fieldOf(form, "tier"),
      property?.id ?? null,
      fieldOf(form, "roomTypeId"),
    );
    if (scope === null) return { invalid: true };

    const parsed = parseItems(fieldOf(form, "items"));
    const templateId = await createTemplate(env, tenant, {
      propertyId: scope.propertyId,
      roomTypeId: scope.roomTypeId,
      taskType,
      name,
      items: parsed.items,
    });

    await recordAudit(env, tenant, {
      actorId: session.membershipId,
      action: "property.updated",
      targetType: "checklistTemplate",
      targetId: templateId,
      ...(scope.propertyId === null ? {} : { propertyId: scope.propertyId }),
      after: { name, taskType, itemCount: parsed.items.length },
    });

    return { createdTemplateId: templateId, skippedLines: parsed.skippedLines };
  }

  if (intent === "deactivate") {
    const templateId = fieldOf(form, "templateId");
    if (templateId === "") return { invalid: true };

    const templates = await listTemplates(env, tenant);
    const target = templates.find((template) => template.id === templateId);
    if (target === undefined) throw new NotFoundError();

    await deactivateTemplate(env, tenant, templateId);
    await recordAudit(env, tenant, {
      actorId: session.membershipId,
      action: "property.updated",
      targetType: "checklistTemplate",
      targetId: templateId,
      before: { isActive: true },
      after: { isActive: false },
    });

    return { deactivatedTemplateId: templateId };
  }

  return { invalid: true };
}

/**
 * 新しいテンプレートの階層を解く。
 *
 * 客室タイプは**表示中の施設のものに限る。** フォームが送ってきた
 * `roomTypeId` をそのまま信用しない（INV-32 と同じ向き）。
 *
 * @param propertyId 表示中の施設。無ければ施設別・客室タイプ別は作れない。
 * @returns 判定できなければ `null`（画面は「入力が不正」を出す）。
 */
async function resolveNewTemplateScope(
  env: Env,
  tenant: TenantContext,
  tier: string,
  propertyId: string | null,
  roomTypeId: string,
): Promise<{ propertyId: string | null; roomTypeId: string | null } | null> {
  if (tier === "ORGANIZATION") return { propertyId: null, roomTypeId: null };
  if (propertyId === null) return null;
  if (tier === "PROPERTY") return { propertyId, roomTypeId: null };

  if (tier === "ROOM_TYPE") {
    const roomTypes = await listRoomTypes(env, tenant, propertyId);
    if (!roomTypes.some((type) => type.id === roomTypeId)) return null;
    return { propertyId, roomTypeId };
  }

  return null;
}

export default function Checklists() {
  const data = useLoaderData<ChecklistsData>();
  const result = useActionData<ChecklistsActionResult>();
  const effective = new Set(data.effectiveIds);

  return (
    <section className="pk-page">
      <h1 className="pk-page__title">{t("checklist.title")}</h1>
      {data.propertyName === null ? null : <p className="pk-muted">{data.propertyName}</p>}

      {result?.invalid === true ? <p className="pk-notice">{t("checklist.invalid")}</p> : null}
      {result?.savedTemplateId === undefined ? null : (
        <p className="pk-notice">{t("checklist.saved")}</p>
      )}
      {result?.createdTemplateId === undefined ? null : (
        <p className="pk-notice">{t("checklist.created")}</p>
      )}
      {result?.deactivatedTemplateId === undefined ? null : (
        <p className="pk-notice">{t("checklist.deactivated")}</p>
      )}
      {result?.skippedLines === undefined || result.skippedLines.length === 0 ? null : (
        <p className="pk-notice pk-notice--warn">
          {`${t("checklist.skippedLines")}: ${result.skippedLines.join(", ")}`}
        </p>
      )}

      {/* 版が上がることを先に述べる（§2.2）。 */}
      <p className="pk-notice">{t("checklist.versionNotice")}</p>
      {data.propertyId === null ? (
        <p className="pk-notice">{t("checklist.noProperty")}</p>
      ) : (
        <p className="pk-notice">{t("checklist.effectiveNotice")}</p>
      )}

      {data.templates.length === 0 ? <p className="pk-notice">{t("checklist.none")}</p> : null}

      {(["ORGANIZATION", "PROPERTY", "ROOM_TYPE"] as const).map((tier) => {
        const group = data.templates.filter((template) => template.tier === tier);
        if (group.length === 0) return null;
        return (
          <section key={tier} className="pk-tier">
            <h2>{t(`checklist.tier.${tier}`)}</h2>
            {group.map((template) => (
              <TemplateCard
                key={template.id}
                template={template}
                isEffective={effective.has(template.id)}
                canWrite={data.canWrite}
              />
            ))}
          </section>
        );
      })}

      {data.canWrite ? (
        <Form method="post" className="pk-form">
          <input type="hidden" name="intent" value="create" />
          <h2>{t("checklist.create")}</h2>

          <label htmlFor="tier">{t("checklist.tier")}</label>
          <select id="tier" name="tier" className="pk-select" defaultValue="ORGANIZATION">
            {(["ORGANIZATION", "PROPERTY", "ROOM_TYPE"] as const).map((tier) => (
              <option key={tier} value={tier}>
                {t(`checklist.tier.${tier}`)}
              </option>
            ))}
          </select>

          <label htmlFor="roomTypeId">{t("checklist.roomType")}</label>
          <select id="roomTypeId" name="roomTypeId" className="pk-select">
            {data.roomTypes.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>

          <label htmlFor="taskType">{t("checklist.taskType")}</label>
          <select id="taskType" name="taskType" className="pk-select" defaultValue="CHECKOUT">
            {TASK_TYPES.map((taskType) => (
              <option key={taskType} value={taskType}>
                {t(`checklist.taskType.${taskType}`)}
              </option>
            ))}
          </select>

          <label htmlFor="new-name">{t("checklist.name")}</label>
          <input id="new-name" name="name" required />

          <label htmlFor="new-items">{t("checklist.items")}</label>
          <textarea id="new-items" name="items" rows={8} placeholder={t("checklist.items.hint")} />
          <p className="pk-hint">{t("checklist.items.format")}</p>

          <button className="pk-button pk-button--primary" type="submit">
            {t("checklist.create.submit")}
          </button>
        </Form>
      ) : null}
    </section>
  );
}

/** テンプレート 1 件。項目はテキストで編集する。 */
function TemplateCard({
  template,
  isEffective,
  canWrite,
}: {
  template: TemplateView;
  isEffective: boolean;
  canWrite: boolean;
}) {
  return (
    <article className="pk-template">
      <h3>
        {template.name}
        {isEffective ? (
          <span className="pk-badge pk-badge--warn">{t("checklist.effective")}</span>
        ) : null}
        {template.isActive ? null : (
          <span className="pk-badge pk-badge--hidden">{t("checklist.inactive")}</span>
        )}
      </h3>
      <p className="pk-muted">
        {[
          t(`checklist.taskType.${template.taskType === "STAYOVER" ? "STAYOVER" : "CHECKOUT"}`),
          template.roomTypeName ?? "",
          `${t("checklist.version")} ${String(template.version)}`,
          `${t("checklist.itemCount")} ${String(template.itemCount)}`,
        ]
          .filter((part) => part !== "")
          .join(" · ")}
      </p>
      {/* §12.2 の「日本語のみ」。件数だけを出す（項目名の横は M-04 側）。 */}
      {template.untranslatedCount === 0 ? null : (
        <p className="pk-muted">
          {`${t("checklist.untranslated")}: ${String(template.untranslatedCount)}`}
        </p>
      )}

      {canWrite ? (
        <>
          <Form method="post" className="pk-form">
            <input type="hidden" name="intent" value="replace-items" />
            <input type="hidden" name="templateId" value={template.id} />
            <label htmlFor={`name-${template.id}`}>{t("checklist.name")}</label>
            <input id={`name-${template.id}`} name="name" defaultValue={template.name} />
            <label htmlFor={`items-${template.id}`}>{t("checklist.items")}</label>
            <textarea
              id={`items-${template.id}`}
              name="items"
              rows={Math.max(4, template.itemCount + 1)}
              defaultValue={template.itemsText}
            />
            <button className="pk-button" type="submit">
              {t("checklist.save")}
            </button>
          </Form>
          {template.isActive ? (
            <Form method="post">
              <input type="hidden" name="intent" value="deactivate" />
              <input type="hidden" name="templateId" value={template.id} />
              <button className="pk-button" type="submit">
                {t("checklist.deactivate")}
              </button>
            </Form>
          ) : null}
        </>
      ) : (
        <pre className="pk-items">{template.itemsText}</pre>
      )}
    </article>
  );
}

/** `FormData` から文字列だけを取り出す。 */
function fieldOf(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}
