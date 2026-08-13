/**
 * W-20 観察項目の設定（PK-SPEC-P3 §2.6 / §6.1）。
 *
 *   /app/settings/observation
 *
 * task: docs/tasks/P3-11.md
 *
 * ── 施設ごとの設定である ────────────────────────────────
 * `observationConfig` の一意制約は `(organizationId, propertyId)`。
 * §6.1 の担当ロールは `ORG_ADMIN` だが、**設定の対象は表示中の施設。**
 * 施設セレクタを切り替えると別の施設の設定になる（W-17 と同じ形）。
 *
 * ── 品目を減らすと画面から消えるだけ ────────────────────
 * `enabledItemCodes` から外した品目は M-05b / M-06 に出なくなる
 * （§2.5 MUST）。**過去の記録は消えない。** ベースライン（§5）は
 * 蓄積済みの `linenRecord` / `roomObservation` をそのまま読む。
 *
 * ── API を作っていない ──────────────────────────────────
 * §7 の API 一覧に観察設定の口は無い。**画面の action から
 * リポジトリを呼ぶ**（docs/DECISIONS.md #099）。外部から設定を変える
 * 経路を仕様の外に増やさないため。
 */

import {
  ITEM_CODES,
  LINEN_ITEM_CODES,
  type ItemCodeValue,
  type ObservationConfig,
} from "@pk/contracts";
import { NotFoundError, recordAudit, upsertObservationConfig } from "@pk/db";
import {
  Form,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { assertPermission, can, propertyTarget } from "../../lib/auth/permission.js";
import { t } from "../../lib/i18n.js";
import { resolveObservationConfig } from "../../lib/observation/config.js";
import { listSelectableProperties, resolveSelectedScope } from "../../lib/property/selection.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

interface ObservationSettingsData {
  propertyId: string | null;
  propertyName: string | null;
  config: ObservationConfig | null;
  canWrite: boolean;
}

/** 画面に並べる真偽の設定（§2.6）。**順序は仕様の宣言順。** */
const TOGGLES = [
  { name: "enabled", label: "obs.settings.enabled" },
  { name: "requireBeds", label: "obs.settings.requireBeds" },
  { name: "requireTrash", label: "obs.settings.requireTrash" },
  { name: "requireTowels", label: "obs.settings.requireTowels" },
  { name: "requireAmenities", label: "obs.settings.requireAmenities" },
  { name: "requireLinen", label: "obs.settings.requireLinen" },
] as const;

export async function loader({
  request,
  context,
}: LoaderFunctionArgs): Promise<ObservationSettingsData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  const properties = await listSelectableProperties(env, tenant);
  const { property } = resolveSelectedScope(session.selectedPropertyId, tenant, properties);
  if (property === null) {
    return { propertyId: null, propertyName: null, config: null, canWrite: false };
  }

  assertPermission(tenant, "observationConfig.read", propertyTarget([property.id]));

  return {
    propertyId: property.id,
    propertyName: property.name,
    config: await resolveObservationConfig(env, tenant, property.id),
    // 読めるが書けないロール（`PROPERTY_MANAGER` / `AUDITOR`）で入力欄を出さない。
    // **これは権限制御ではない**（action 側の `assertPermission` が守る）。
    canWrite: can(tenant, "observationConfig.write", propertyTarget([property.id])),
  };
}

interface ObservationSettingsResult {
  saved?: boolean;
}

export async function action({
  request,
  context,
}: ActionFunctionArgs): Promise<ObservationSettingsResult> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  const properties = await listSelectableProperties(env, tenant);
  const { property } = resolveSelectedScope(session.selectedPropertyId, tenant, properties);
  if (property === null) throw new NotFoundError();

  assertPermission(tenant, "observationConfig.write", propertyTarget([property.id]));

  const form = await request.formData();
  const before = await resolveObservationConfig(env, tenant, property.id);

  const next = {
    propertyId: property.id,
    enabled: form.get("enabled") !== null,
    requireBeds: form.get("requireBeds") !== null,
    requireTrash: form.get("requireTrash") !== null,
    requireTowels: form.get("requireTowels") !== null,
    requireAmenities: form.get("requireAmenities") !== null,
    requireLinen: form.get("requireLinen") !== null,
    // **フォームの値をそのまま信用しない。** 語彙にあるコードだけを残す。
    enabledItemCodes: form
      .getAll("itemCode")
      .filter((value): value is string => typeof value === "string")
      .filter((value): value is ItemCodeValue =>
        (ITEM_CODES as readonly string[]).includes(value),
      ),
    skipWarnThreshold: parseThreshold(form.get("skipWarnThreshold"), before.skipWarnThreshold),
  };

  await upsertObservationConfig(env, tenant, next);

  // security.md §6「組織設定の変更」。`AUDIT_ACTIONS` は閉じたレジストリで、
  // 観察設定専用の行は根拠が無いため施設の更新として残す（W-17 と同じ扱い）。
  await recordAudit(env, tenant, {
    actorId: session.membershipId,
    action: "property.updated",
    targetType: "observationConfig",
    targetId: property.id,
    propertyId: property.id,
    before,
    after: next,
  });

  return { saved: true };
}

export default function ObservationSettings() {
  const data = useLoaderData<ObservationSettingsData>();
  const result = useActionData<ObservationSettingsResult>();

  if (data.propertyId === null || data.config === null) {
    return (
      <section className="pk-page">
        <h1 className="pk-page__title">{t("obs.settings.title")}</h1>
        <p className="pk-notice">{t("obs.settings.noProperty")}</p>
      </section>
    );
  }

  const config = data.config;
  const enabledItems = new Set<string>(config.enabledItemCodes);

  return (
    <section className="pk-page">
      <h1 className="pk-page__title">{t("obs.settings.title")}</h1>
      <p className="pk-muted">{data.propertyName}</p>

      {result?.saved === true ? <p className="pk-notice">{t("obs.settings.saved")}</p> : null}

      {/* §1.3。設定は「画面に出すか」であって、入力を強制する意味ではない。 */}
      <p className="pk-notice">{t("obs.settings.notMandatory")}</p>

      <Form method="post">
        <fieldset className="pk-fieldset">
          <legend>{t("obs.settings.sections")}</legend>
          {TOGGLES.map((toggle) => (
            <label key={toggle.name} className="pk-check">
              <input
                type="checkbox"
                name={toggle.name}
                defaultChecked={config[toggle.name]}
                disabled={!data.canWrite}
              />
              {t(toggle.label)}
            </label>
          ))}
        </fieldset>

        <fieldset className="pk-fieldset">
          <legend>{t("obs.settings.items")}</legend>
          <p className="pk-muted">{t("obs.settings.itemsHint")}</p>
          {ITEM_CODES.map((code) => (
            <label key={code} className="pk-check">
              <input
                type="checkbox"
                name="itemCode"
                value={code}
                defaultChecked={enabledItems.has(code)}
                disabled={!data.canWrite}
              />
              {t(`obs.item.${code}`)}
              {(LINEN_ITEM_CODES as readonly string[]).includes(code) ? (
                <span className="pk-badge">{t("obs.settings.linenItem")}</span>
              ) : null}
            </label>
          ))}
        </fieldset>

        <fieldset className="pk-fieldset">
          <legend>{t("obs.settings.threshold")}</legend>
          {/* §1.3「未記録率が閾値を超えたら管理画面で警告する」。 */}
          <p className="pk-muted">{t("obs.settings.thresholdHint")}</p>
          <input
            name="skipWarnThreshold"
            inputMode="numeric"
            min={0}
            max={100}
            defaultValue={String(config.skipWarnThreshold)}
            aria-label={t("obs.settings.threshold")}
            disabled={!data.canWrite}
          />
        </fieldset>

        {data.canWrite ? (
          <button className="pk-button pk-button--primary" type="submit">
            {t("obs.settings.save")}
          </button>
        ) : null}
      </Form>
    </section>
  );
}

/** 0〜100 の整数。**壊れていたら現在値のまま**（保存で 0 に落とさない）。 */
function parseThreshold(value: FormDataEntryValue | null, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return fallback;
  return parsed;
}
