/**
 * W-11 施設設定（施設マスタの作成・編集）。
 *
 *   /app/settings/properties
 *
 * 経緯:  OPEN_QUESTIONS #103（施設の作成画面が無い）の残り半分。
 *        人間の指示 2026-08-17「施設設定の機能を考えて実現」。
 * 参照:  ui-prototypes/owner/pkown-v3-D-billing-settings-perm.html（11）
 * ルール: .claude/rules/architecture.md §7（業務日）/ security.md §6（監査）
 *
 * ── プロトタイプとの関係（DECISIONS #200）────────────────
 * プロトタイプの 11 は「外部のオーナー利用者」を想定した通知・表示設定が
 * 主で、施設マスタは表示専用だった。実装のロール模型では施設マスタを
 * 作る画面そのものが存在せず（#103）、運用が始められない。**この画面は
 * マスタの作成・編集を先に埋める。** 通知の受け取り・テーマ等は
 * 対応する仕組み（Web Push は人間の設定待ち / ダークモード未実装）が
 * 揃ってから足す。
 *
 * ── 変えられないもの ────────────────────────────────────
 * - `code`: CSV 取込・連携の突合キー（`updateProperty()` の注記）。
 * - 検査の要否・方式: 検査ポリシーの画面（`upsertInspectionPolicy()`）が窓口。
 * - **物理削除の口は無い**（PK-SPEC-P0 §26）。無効化のみ。
 *
 * ── 日締め時刻は運用の根幹 ──────────────────────────────
 * `dayCutoffTime` を変えると全ての日次集計の区切りが動く（architecture.md
 * §7）。フォームに注意書きを常設し、変更は必ず監査ログに残る。
 */

import {
  NotFoundError,
  createProperty,
  findPropertyByCode,
  listProperties,
  recordAudit,
  updateProperty,
} from "@pk/db";
import { Form, useActionData, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";

import {
  ORGANIZATION_TARGET,
  assertPermission,
  can,
  propertyTarget,
} from "../../lib/auth/permission.js";
import { t } from "../../lib/i18n.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

interface PropertyRow {
  id: string;
  code: string;
  name: string;
  postalCode: string | null;
  address: string | null;
  timezone: string;
  dayCutoffTime: string;
  isActive: boolean;
}

interface PropertySettingsData {
  properties: PropertyRow[];
  /** 施設の新規作成は組織全体の `property.write` を持つ相手だけ。 */
  canCreate: boolean;
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<PropertySettingsData> {
  const env = getEnv(context);
  const now = new Date();
  const { tenant } = await requireAppContext(env, request, now);

  // 施設スコープの `PROPERTY_MANAGER` は担当施設の編集だけができる。
  // 担当が 1 つも無ければ（= 書ける対象が無い）404。
  assertPermission(
    tenant,
    "property.write",
    can(tenant, "property.write", ORGANIZATION_TARGET)
      ? ORGANIZATION_TARGET
      : propertyTarget(tenant.allowedPropertyIds),
  );

  // 無効化済みも出す（isActive で絞らない）。**消えたように見せない** —
  // 無効化した施設を再有効化する入口がこの画面しか無い。
  const rows = await listProperties(env, tenant);

  return {
    properties: rows
      .map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        postalCode: row.postalCode,
        address: row.address,
        timezone: row.timezone,
        dayCutoffTime: row.dayCutoffTime,
        isActive: row.isActive,
      }))
      .sort((a, b) => a.code.localeCompare(b.code)),
    canCreate: can(tenant, "property.write", ORGANIZATION_TARGET),
  };
}

type ActionFailure =
  | "INVALID"
  | "CODE_TAKEN"
  | "BAD_CUTOFF"
  | "BAD_TIMEZONE";

interface PropertySettingsActionResult {
  created?: boolean;
  updated?: boolean;
  failure?: ActionFailure;
}

/** `HH:MM`（architecture.md §7）。 */
const CUTOFF_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 施設コード。取込ファイルのキーになるので英数とハイフンだけに絞る。 */
const CODE_PATTERN = /^[A-Za-z0-9-]{1,16}$/;

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function textOf(value: FormDataEntryValue | null, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > maxLength) return null;
  return trimmed;
}

/** 空欄を許す任意項目。空文字は `null` に寄せる。 */
function optionalTextOf(value: FormDataEntryValue | null, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" || trimmed.length > maxLength ? null : trimmed;
}

export async function action({
  request,
  context,
}: ActionFunctionArgs): Promise<PropertySettingsActionResult> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  const form = await request.formData();
  const intent = form.get("intent");

  const name = textOf(form.get("name"), 64);
  const postalCode = optionalTextOf(form.get("postalCode"), 8);
  const address = optionalTextOf(form.get("address"), 128);
  const timezone = textOf(form.get("timezone"), 64) ?? "Asia/Tokyo";
  const dayCutoffTime = textOf(form.get("dayCutoffTime"), 5) ?? "05:00";

  if (name === null) return { failure: "INVALID" };
  if (!CUTOFF_PATTERN.test(dayCutoffTime)) return { failure: "BAD_CUTOFF" };
  if (!isValidTimezone(timezone)) return { failure: "BAD_TIMEZONE" };

  if (intent === "create") {
    // 作成は組織全体の権限（施設スコープの相手は自分の担当を増やせない）。
    assertPermission(tenant, "property.write", ORGANIZATION_TARGET);

    const code = textOf(form.get("code"), 16);
    if (code === null || !CODE_PATTERN.test(code)) return { failure: "INVALID" };
    if ((await findPropertyByCode(env, tenant, code)) !== undefined) {
      return { failure: "CODE_TAKEN" };
    }

    const row = await createProperty(env, tenant, {
      code,
      name,
      postalCode: postalCode ?? undefined,
      address: address ?? undefined,
      timezone,
      dayCutoffTime,
    });
    await recordAudit(env, tenant, {
      actorId: session.membershipId,
      action: "property.created",
      targetType: "property",
      targetId: row.id,
      propertyId: row.id,
      after: { code, name, timezone, dayCutoffTime },
    });
    return { created: true };
  }

  if (intent === "update") {
    const propertyId = form.get("propertyId");
    if (typeof propertyId !== "string") return { failure: "INVALID" };

    assertPermission(tenant, "property.write", propertyTarget([propertyId]));

    // 監査の before を取るついでに、存在しない ID をここで 404 にする。
    const before = (await listProperties(env, tenant)).find((row) => row.id === propertyId);
    if (before === undefined) throw new NotFoundError();

    const isActive = form.get("isActive") === "on";

    await updateProperty(env, tenant, {
      propertyId,
      name,
      postalCode,
      address,
      timezone,
      dayCutoffTime,
      isActive,
    });
    // 無効化は別の監査語彙（security.md §6「施設・客室マスタの無効化」）。
    await recordAudit(env, tenant, {
      actorId: session.membershipId,
      action: before.isActive && !isActive ? "property.deactivated" : "property.updated",
      targetType: "property",
      targetId: propertyId,
      propertyId,
      before: {
        name: before.name,
        timezone: before.timezone,
        dayCutoffTime: before.dayCutoffTime,
        isActive: before.isActive,
      },
      after: { name, timezone, dayCutoffTime, isActive },
    });
    return { updated: true };
  }

  return { failure: "INVALID" };
}

const FAILURE_MESSAGE: Record<ActionFailure, Parameters<typeof t>[0]> = {
  INVALID: "propSettings.error.invalid",
  CODE_TAKEN: "propSettings.error.codeTaken",
  BAD_CUTOFF: "propSettings.error.badCutoff",
  BAD_TIMEZONE: "propSettings.error.badTimezone",
};

export default function PropertySettings() {
  const data = useLoaderData<PropertySettingsData>();
  const result = useActionData<PropertySettingsActionResult>();

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("propSettings.title")}</h1>
      </div>
      <p className="pk-muted">{t("propSettings.lede")}</p>

      {result?.failure !== undefined ? (
        <p className="pk-notice pk-notice--warn">{t(FAILURE_MESSAGE[result.failure])}</p>
      ) : null}
      {result?.created === true ? <p className="pk-notice">{t("propSettings.created")}</p> : null}
      {result?.updated === true ? <p className="pk-notice">{t("propSettings.updated")}</p> : null}

      {data.properties.map((property) => (
        <Form method="post" key={property.id} className="pk-propcard">
          <input type="hidden" name="intent" value="update" />
          <input type="hidden" name="propertyId" value={property.id} />
          <h2 className="pk-section__title">
            {`${property.name}（${property.code}）`}
            {property.isActive ? null : (
              <span className="pk-badge pk-badge--warn">{t("propSettings.inactive")}</span>
            )}
          </h2>
          <div className="pk-filter">
            <label className="pk-field">
              <span className="pk-field__label">{t("propSettings.field.name")}</span>
              <input className="pk-input" name="name" defaultValue={property.name} required maxLength={64} />
            </label>
            <label className="pk-field">
              <span className="pk-field__label">{t("propSettings.field.postalCode")}</span>
              <input className="pk-input" name="postalCode" defaultValue={property.postalCode ?? ""} maxLength={8} />
            </label>
            <label className="pk-field">
              <span className="pk-field__label">{t("propSettings.field.address")}</span>
              <input className="pk-input" name="address" defaultValue={property.address ?? ""} maxLength={128} />
            </label>
            <label className="pk-field">
              <span className="pk-field__label">{t("propSettings.field.timezone")}</span>
              <input className="pk-input" name="timezone" defaultValue={property.timezone} required maxLength={64} />
            </label>
            <label className="pk-field">
              <span className="pk-field__label">{t("propSettings.field.dayCutoffTime")}</span>
              <input
                className="pk-input"
                name="dayCutoffTime"
                defaultValue={property.dayCutoffTime}
                required
                pattern="([01][0-9]|2[0-3]):[0-5][0-9]"
              />
            </label>
            <label className="pk-field pk-field--check">
              <span className="pk-field__label">{t("propSettings.field.isActive")}</span>
              <input type="checkbox" name="isActive" defaultChecked={property.isActive} />
            </label>
            <button className="pk-button" type="submit">
              {t("propSettings.save")}
            </button>
          </div>
          {/* 日締めは全集計の区切り（architecture.md §7）。軽く変える項目ではない。 */}
          <p className="pk-muted">{t("propSettings.cutoffNote")}</p>
        </Form>
      ))}

      {data.canCreate ? (
        <Form method="post" className="pk-propcard pk-propcard--new">
          <input type="hidden" name="intent" value="create" />
          <h2 className="pk-section__title">{t("propSettings.createTitle")}</h2>
          <div className="pk-filter">
            <label className="pk-field">
              <span className="pk-field__label">{t("propSettings.field.code")}</span>
              <input
                className="pk-input"
                name="code"
                required
                maxLength={16}
                pattern="[A-Za-z0-9-]{1,16}"
              />
            </label>
            <label className="pk-field">
              <span className="pk-field__label">{t("propSettings.field.name")}</span>
              <input className="pk-input" name="name" required maxLength={64} />
            </label>
            <label className="pk-field">
              <span className="pk-field__label">{t("propSettings.field.postalCode")}</span>
              <input className="pk-input" name="postalCode" maxLength={8} />
            </label>
            <label className="pk-field">
              <span className="pk-field__label">{t("propSettings.field.address")}</span>
              <input className="pk-input" name="address" maxLength={128} />
            </label>
            <label className="pk-field">
              <span className="pk-field__label">{t("propSettings.field.timezone")}</span>
              <input className="pk-input" name="timezone" defaultValue="Asia/Tokyo" required maxLength={64} />
            </label>
            <label className="pk-field">
              <span className="pk-field__label">{t("propSettings.field.dayCutoffTime")}</span>
              <input
                className="pk-input"
                name="dayCutoffTime"
                defaultValue="05:00"
                required
                pattern="([01][0-9]|2[0-3]):[0-5][0-9]"
              />
            </label>
            <button className="pk-button" type="submit">
              {t("propSettings.create")}
            </button>
          </div>
          <p className="pk-muted">{t("propSettings.codeNote")}</p>
          <p className="pk-muted">{t("propSettings.nextSteps")}</p>
        </Form>
      ) : null}
    </section>
  );
}
