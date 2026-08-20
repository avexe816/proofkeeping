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
 *
 * ── タイムゾーンは画面に出さない（人間の指示 2026-08-19）─
 * 国内専用のため常に既定の `Asia/Tokyo`。**列は残す**（`businessDate` の
 * 計算が読む / architecture.md §7。列の削除は破壊的変更）。海外施設を
 * 扱う要件が出たら入力欄を戻す。既存行の値は更新時も**変更しない**。
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
  phone: string | null;
  contactName: string | null;
  dayCutoffTime: string;
  /** 忘れ物の保持日数（§7.3 / OQ #052）。`null` = 既定（90 日 / 食品は当日）。 */
  lostItemRetentionDays: number | null;
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
        phone: row.phone,
        contactName: row.contactName,
        dayCutoffTime: row.dayCutoffTime,
        lostItemRetentionDays: row.lostItemRetentionDays,
        isActive: row.isActive,
      }))
      .sort((a, b) => a.code.localeCompare(b.code)),
    canCreate: can(tenant, "property.write", ORGANIZATION_TARGET),
  };
}

type ActionFailure = "INVALID" | "CODE_TAKEN" | "BAD_CUTOFF" | "BAD_RETENTION";

interface PropertySettingsActionResult {
  created?: boolean;
  updated?: boolean;
  failure?: ActionFailure;
}

/** `HH:MM`（architecture.md §7）。 */
const CUTOFF_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 施設コード。取込ファイルのキーになるので英数とハイフンだけに絞る。 */
const CODE_PATTERN = /^[A-Za-z0-9-]{1,16}$/;

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
  const phone = optionalTextOf(form.get("phone"), 20);
  const contactName = optionalTextOf(form.get("contactName"), 64);
  const dayCutoffTime = textOf(form.get("dayCutoffTime"), 5) ?? "05:00";

  if (name === null) return { failure: "INVALID" };
  if (!CUTOFF_PATTERN.test(dayCutoffTime)) return { failure: "BAD_CUTOFF" };

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
      phone: phone ?? undefined,
      contactName: contactName ?? undefined,
      // 国内専用の既定（冒頭の注記）。入力欄は無い。
      timezone: "Asia/Tokyo",
      dayCutoffTime,
    });
    await recordAudit(env, tenant, {
      actorId: session.membershipId,
      action: "property.created",
      targetType: "property",
      targetId: row.id,
      propertyId: row.id,
      after: { code, name, dayCutoffTime },
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

    // 忘れ物の保持日数（§7.3 / OQ #052）。空欄 = 既定に従う（null）。
    // 1〜365 日。0 を許さない（当日破棄の運用は食品の固定規則が担う —
    // engine の `retentionDaysFor()`）。
    const retentionRaw = optionalTextOf(form.get("lostItemRetentionDays"), 3);
    const lostItemRetentionDays = retentionRaw === null ? null : Number(retentionRaw);
    if (
      lostItemRetentionDays !== null &&
      (!Number.isInteger(lostItemRetentionDays) ||
        lostItemRetentionDays < 1 ||
        lostItemRetentionDays > 365)
    ) {
      return { failure: "BAD_RETENTION" };
    }

    // `timezone` を渡さない = 変更しない（既存行の値を保つ / 冒頭の注記）。
    await updateProperty(env, tenant, {
      propertyId,
      name,
      postalCode,
      address,
      phone,
      contactName,
      dayCutoffTime,
      lostItemRetentionDays,
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
        dayCutoffTime: before.dayCutoffTime,
        lostItemRetentionDays: before.lostItemRetentionDays,
        isActive: before.isActive,
      },
      after: { name, dayCutoffTime, lostItemRetentionDays, isActive },
    });
    return { updated: true };
  }

  return { failure: "INVALID" };
}

const FAILURE_MESSAGE: Record<ActionFailure, Parameters<typeof t>[0]> = {
  INVALID: "propSettings.error.invalid",
  CODE_TAKEN: "propSettings.error.codeTaken",
  BAD_CUTOFF: "propSettings.error.badCutoff",
  BAD_RETENTION: "propSettings.error.badRetention",
};

export default function PropertySettings() {
  const data = useLoaderData<PropertySettingsData>();
  const result = useActionData<PropertySettingsActionResult>();

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <div>
          <h1 className="pk-pagehead__title">{t("propSettings.title")}</h1>
          <p className="pk-pagehead__sub">{t("propSettings.lede")}</p>
        </div>
      </div>

      {/* 変えられる範囲を最初に述べる（プロトタイプ D-11 の確定事項）。 */}
      <p className="pk-notice pk-notice--info">{t("propSettings.scopeNote")}</p>

      {result?.failure !== undefined ? (
        <p className="pk-notice pk-notice--warn">{t(FAILURE_MESSAGE[result.failure])}</p>
      ) : null}
      {result?.created === true ? <p className="pk-notice">{t("propSettings.created")}</p> : null}
      {result?.updated === true ? <p className="pk-notice">{t("propSettings.updated")}</p> : null}

      {/* 1 施設 = 1 カード（プロトタイプ D-11 のカード配置）。 */}
      <div className="pk-cols pk-cols--2">
        {data.properties.map((property) => (
          <Form method="post" key={property.id} className="pk-panel">
            <input type="hidden" name="intent" value="update" />
            <input type="hidden" name="propertyId" value={property.id} />
            <div className="pk-panel__head">
              {`${property.name}（${property.code}）`}
              {property.isActive ? null : (
                <span className="pk-badge pk-badge--warn">{t("propSettings.inactive")}</span>
              )}
            </div>
            <div className="pk-panel__body">
              <div className="pk-formgrid">
                <label className="pk-field">
                  <span className="pk-field__label">{t("propSettings.field.name")}</span>
                  <input className="pk-input" name="name" defaultValue={property.name} required maxLength={64} />
                </label>
                <label className="pk-field">
                  <span className="pk-field__label">{t("propSettings.field.postalCode")}</span>
                  <input className="pk-input" name="postalCode" defaultValue={property.postalCode ?? ""} maxLength={8} />
                </label>
                <label className="pk-field pk-field--wide">
                  <span className="pk-field__label">{t("propSettings.field.address")}</span>
                  <input className="pk-input" name="address" defaultValue={property.address ?? ""} maxLength={128} />
                </label>
                <label className="pk-field">
                  <span className="pk-field__label">{t("propSettings.field.phone")}</span>
                  <input className="pk-input" name="phone" defaultValue={property.phone ?? ""} maxLength={20} inputMode="tel" />
                </label>
                <label className="pk-field">
                  <span className="pk-field__label">{t("propSettings.field.contactName")}</span>
                  <input className="pk-input" name="contactName" defaultValue={property.contactName ?? ""} maxLength={64} />
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
                  {/* 日締めは全集計の区切り（architecture.md §7）。軽く変える項目ではない。 */}
                  <span className="pk-field__hint">{t("propSettings.cutoffNote")}</span>
                </label>
                <label className="pk-field">
                  <span className="pk-field__label">{t("propSettings.field.lostItemRetentionDays")}</span>
                  <input
                    className="pk-input"
                    name="lostItemRetentionDays"
                    defaultValue={property.lostItemRetentionDays ?? ""}
                    inputMode="numeric"
                    pattern="[0-9]{1,3}"
                  />
                  {/* §7.3。貴重品等の 7 日・食品の当日はこの設定より優先される固定規則。 */}
                  <span className="pk-field__hint">{t("propSettings.retentionNote")}</span>
                </label>
                <label className="pk-field pk-field--check">
                  <span className="pk-field__label">{t("propSettings.field.isActive")}</span>
                  <input type="checkbox" name="isActive" defaultChecked={property.isActive} />
                </label>
                <div className="pk-formgrid__actions">
                  <button className="pk-button pk-button--primary" type="submit">
                    {t("propSettings.save")}
                  </button>
                </div>
              </div>
            </div>
          </Form>
        ))}
      </div>

      {data.canCreate ? (
        <Form method="post" className="pk-panel pk-panel--new">
          <input type="hidden" name="intent" value="create" />
          <div className="pk-panel__head">{t("propSettings.createTitle")}</div>
          <div className="pk-panel__body">
            <div className="pk-formgrid">
              <label className="pk-field">
                <span className="pk-field__label">{t("propSettings.field.code")}</span>
                <input
                  className="pk-input"
                  name="code"
                  required
                  maxLength={16}
                  pattern="[A-Za-z0-9-]{1,16}"
                />
                <span className="pk-field__hint">{t("propSettings.codeNote")}</span>
              </label>
              <label className="pk-field">
                <span className="pk-field__label">{t("propSettings.field.name")}</span>
                <input className="pk-input" name="name" required maxLength={64} />
              </label>
              <label className="pk-field">
                <span className="pk-field__label">{t("propSettings.field.postalCode")}</span>
                <input className="pk-input" name="postalCode" maxLength={8} />
              </label>
              <label className="pk-field pk-field--wide">
                <span className="pk-field__label">{t("propSettings.field.address")}</span>
                <input className="pk-input" name="address" maxLength={128} />
              </label>
              <label className="pk-field">
                <span className="pk-field__label">{t("propSettings.field.phone")}</span>
                <input className="pk-input" name="phone" maxLength={20} inputMode="tel" />
              </label>
              <label className="pk-field">
                <span className="pk-field__label">{t("propSettings.field.contactName")}</span>
                <input className="pk-input" name="contactName" maxLength={64} />
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
              <div className="pk-formgrid__actions">
                <button className="pk-button pk-button--primary" type="submit">
                  {t("propSettings.create")}
                </button>
                <span className="pk-muted">{t("propSettings.nextSteps")}</span>
              </div>
            </div>
          </div>
        </Form>
      ) : null}
    </section>
  );
}
