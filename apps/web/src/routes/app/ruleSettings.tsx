/**
 * W-25 ルール設定（PK-SPEC-P4 §2.7）。
 *
 *   /app/settings/rules
 *
 * task:  docs/tasks/P4-13.md
 * ルール: .claude/rules/security.md §1 / .claude/rules/ui-writing.md §2
 *
 * ── 画面番号が重なっている ──────────────────────────────
 * PK-SPEC-P1 §10.1 の W-25 は「客室タイプ管理」（P1-24 /
 * `/app/settings/room-types`）で、PK-SPEC-P4 §2.7 の W-25 はこの画面。
 * **仕様書どうしで番号が衝突している**（OPEN_QUESTIONS #067）。
 * 経路を分けてあるので実害は無い。
 *
 * ── engine を変えずに調整できること（完了条件）──────────
 * 触れるのは**有効・無効／重要度の上書き／閾値**の 3 つだけ。
 * ルールの条件そのものは `packages/engine` にあり、この画面からは動かせない。
 *
 * ── 実装されていないルールも並べる ──────────────────────
 * §3.1 は 14 個で閉じているが、engine にあるのは 10 個
 * （OPEN_QUESTIONS #066）。**隠さずに「未実装」として出す。**
 * 隠すと「設定したのに何も起きない」理由が画面から読めない。
 *
 * ── 対象は表示中の施設 ──────────────────────────────────
 * 施設ごとの調整が §2.7 の目的（「engine 側を書き換えずに調整できる
 * ようにするための表」）。組織の既定は API（`propertyId: null`）で
 * 触れるが、**画面は施設 1 つぶんに絞ってある**（どちらを編集して
 * いるのかが読めない画面にしない）。
 */

import {
  FINDING_SEVERITIES,
  type FindingSeverityValue,
  type RuleConfigSummary,
} from "@pk/contracts";
import { NotFoundError, recordAudit, upsertRuleConfig, type RuleCode } from "@pk/db";
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
import { SEVERITY_LABEL } from "../../lib/reconciliation/labels.js";
import { collectRuleConfigs } from "../../lib/reconciliation/ruleConfig.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

interface RuleSettingsData {
  propertyId: string | null;
  propertyName: string | null;
  rules: RuleConfigSummary[];
  canWrite: boolean;
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<RuleSettingsData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  const properties = await listSelectableProperties(env, tenant);
  const { property } = resolveSelectedScope(session.selectedPropertyId, tenant, properties);

  // **施設が決まっていなくても門は通す。** 権限の無いロールをここで
  // 落とす（施設が無いことを理由に 200 を返さない）。
  assertPermission(
    tenant,
    "ruleConfig.read",
    propertyTarget(property === null ? [] : [property.id]),
  );

  if (property === null) {
    return { propertyId: null, propertyName: null, rules: [], canWrite: false };
  }

  return {
    propertyId: property.id,
    propertyName: property.name,
    rules: await collectRuleConfigs(env, tenant, property.id),
    canWrite: can(tenant, "ruleConfig.write", propertyTarget([property.id])),
  };
}

interface RuleSettingsResult {
  saved?: boolean;
  rejected?: boolean;
}

/**
 * 1 ルールの設定を保存する（§2.7）。
 *
 * API（`routes/api/v1/ruleConfigs.ts`）と同じことをする。**判定と監査ログを
 * 両方に書いているので、片方だけ直さないこと**（W-20 / W-21 と同じ形 /
 * DECISIONS #099）。
 */
export async function action({
  request,
  context,
}: ActionFunctionArgs): Promise<RuleSettingsResult> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  const form = await request.formData();
  const propertyId = form.get("propertyId");
  const ruleCode = form.get("ruleCode");
  if (typeof propertyId !== "string" || typeof ruleCode !== "string") throw new NotFoundError();

  assertPermission(tenant, "ruleConfig.write", propertyTarget([propertyId]));

  const severityRaw = form.get("severityOverride");
  const severityOverride =
    typeof severityRaw === "string" &&
    (FINDING_SEVERITIES as readonly string[]).includes(severityRaw)
      ? (severityRaw as FindingSeverityValue)
      : null;

  // **チェックボックスは「入っていれば有効」。** 未送信を「無効」と読む。
  const isEnabled = form.get("isEnabled") === "on";

  await upsertRuleConfig(env, tenant, {
    propertyId,
    ruleCode: ruleCode as RuleCode,
    isEnabled,
    severityOverride,
    // **画面から閾値を触らせていない。** 鍵の名前はルールごとに違い
    // （§2.7「engine が知っている形だけを入れること」）、自由入力にすると
    // 効かない鍵が並ぶ。閾値の調整は API から行う（OPEN_QUESTIONS #068）。
    thresholds: {},
  });

  await recordAudit(env, tenant, {
    actorId: session.membershipId,
    action: "organization.updated",
    targetType: "ruleConfig",
    targetId: ruleCode,
    propertyId,
    after: { isEnabled, severityOverride },
  });

  return { saved: true };
}

export default function RuleSettings() {
  const data = useLoaderData<RuleSettingsData>();
  const result = useActionData<RuleSettingsResult>();

  if (data.propertyId === null) {
    return (
      <section className="pk-page">
        <div className="pk-pagehead">
          <h1 className="pk-pagehead__title">{t("ruleConfig.title")}</h1>
        </div>
        <p className="pk-notice">{t("ruleConfig.noProperty")}</p>
      </section>
    );
  }

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <div>
          <h1 className="pk-pagehead__title">{t("ruleConfig.title")}</h1>
          <p className="pk-pagehead__sub">{data.propertyName}</p>
        </div>
      </div>
      <p className="pk-notice">{t("ruleConfig.intro")}</p>

      {result?.saved === true ? <p className="pk-message">{t("ruleConfig.saved")}</p> : null}

      <table className="pk-grid">
        <thead>
          <tr>
            <th>{t("ruleConfig.column.code")}</th>
            <th>{t("ruleConfig.column.name")}</th>
            <th>{t("ruleConfig.column.enabled")}</th>
            <th>{t("ruleConfig.column.severity")}</th>
            <th>{t("ruleConfig.column.scope")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.rules.map((rule) => (
            <tr key={rule.ruleCode} className={rule.isImplemented ? undefined : "pk-row--muted"}>
              <th scope="row">{rule.ruleCode}</th>
              <td>{rule.isImplemented ? rule.title : t("ruleConfig.notImplemented")}</td>
              <td>
                <Form method="post" className="pk-inline">
                  <input type="hidden" name="propertyId" value={data.propertyId ?? ""} />
                  <input type="hidden" name="ruleCode" value={rule.ruleCode} />
                  <input
                    type="checkbox"
                    name="isEnabled"
                    defaultChecked={rule.isEnabled}
                    disabled={!data.canWrite}
                  />
                  <select
                    className="pk-select"
                    name="severityOverride"
                    defaultValue={rule.severityOverride ?? ""}
                    disabled={!data.canWrite}
                  >
                    <option value="">{t("ruleConfig.severityDefault")}</option>
                    {FINDING_SEVERITIES.map((severity) => (
                      <option key={severity} value={severity}>
                        {t(SEVERITY_LABEL[severity])}
                      </option>
                    ))}
                  </select>
                  {data.canWrite ? (
                    <button className="pk-button" type="submit">
                      {t("ruleConfig.save")}
                    </button>
                  ) : null}
                </Form>
              </td>
              <td>
                {rule.severityOverride === null
                  ? t("ruleConfig.severityDefault")
                  : t(SEVERITY_LABEL[rule.severityOverride])}
              </td>
              <td>
                {rule.isDefault
                  ? t("ruleConfig.scope.default")
                  : rule.hasPropertyOverride
                    ? t("ruleConfig.scope.property")
                    : t("ruleConfig.scope.organization")}
              </td>
              <td />
            </tr>
          ))}
        </tbody>
      </table>

      {data.canWrite ? null : <p className="pk-muted">{t("ruleConfig.readOnly")}</p>}
    </section>
  );
}
