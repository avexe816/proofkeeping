/**
 * W-18 検査ポリシー（PK-SPEC-P2 §2.1 / §12.1）。
 *
 *   /app/settings/inspection
 *
 * ── なぜこの画面が要るのか ──────────────────────────────
 * 検査の要否は `propertyInspectionPolicy.mode` で決まる（§2.1）。表と
 * リポジトリ関数（`upsertInspectionPolicy()`）は P2-02 で入っていたが、
 * **書き込む経路が製品のどこにも無かった。** 施設を作ると
 * `createProperty()` が `legacyPolicyValues(false)` の行、つまり
 * `mode = NONE` を置く（`repositories/property.ts`）。`NONE` の施設では
 * `decideInspection()` が `POLICY_NONE` を返し、清掃完了タスクが
 * `AWAITING_INSPECTION` を通らず `COMPLETED` になるため、**検査担当の
 * 一覧（M-08）が永久に空**になっていた。この画面が `mode` を変える。
 *
 * ── 施設ごとの設定である ────────────────────────────────
 * `propertyInspectionPolicy` の一意制約は `(organizationId, propertyId)`。
 * 対象は表示中の施設で、施設セレクタを切り替えると別の施設の設定になる
 * （W-17 / W-20 と同じ形）。
 *
 * ── 門は `property.write` ────────────────────────────────
 * §12.1 は W-18 の担当ロールを定めていない。**根拠の無い権限を新設せず**
 * （workflow.md §6）、施設マスタと同じ門を使う。検査方式は施設ごとの
 * マスタ設定で、行を作るのも施設の作成時（`createProperty()`）である。
 * 結果として OWNER / ORG_ADMIN（組織全体）と PROPERTY_MANAGER（担当施設）が
 * 開き、それ以外は 404（`assertPermission()`）。
 *
 * ── P1 の真偽値を書き換えない ───────────────────────────
 * `property.inspectionRequired` は移行が終わるまで残っている列で、
 * **読む側は必ず「行があれば行を優先」する**（`resolveInspectionDecision()` /
 * `lib/inspection/stranded.ts`）。この画面は行だけを書く。二重管理その
 * ものは docs/OPEN_QUESTIONS.md #044 の担当で、ここでは解かない。
 *
 * ── API を作っていない ──────────────────────────────────
 * §9 の API 一覧に検査ポリシーの口は無い。**画面の action から
 * リポジトリを呼ぶ**（W-20 と同じ / docs/DECISIONS.md #099）。
 */

import {
  NotFoundError,
  findInspectionPolicy,
  findPropertyById,
  recordAudit,
  upsertInspectionPolicy,
  type InspectionMode,
  type InspectionPolicyInput,
} from "@pk/db";
import {
  Form,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { assertPermission, propertyTarget } from "../../lib/auth/permission.js";
import { t } from "../../lib/i18n.js";
import {
  MAX_MIN_DAILY_SAMPLE,
  parseInspectionPolicyForm,
  resolveEffectivePolicy,
} from "../../lib/inspection/policySettings.js";
import { listSelectableProperties, resolveSelectedScope } from "../../lib/property/selection.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

interface InspectionSettingsData {
  propertyId: string | null;
  propertyName: string | null;
  policy: InspectionPolicyInput | null;
  /** 施設に行があるか。無ければ「まだ保存していない」と画面に出す。 */
  configured: boolean;
}

/** 画面に並べる方式（§2.1 の宣言順）。 */
const MODES: readonly { value: InspectionMode; label: Parameters<typeof t>[0] }[] = [
  { value: "ALL", label: "insp.settings.mode.ALL" },
  { value: "SAMPLE", label: "insp.settings.mode.SAMPLE" },
  { value: "NONE", label: "insp.settings.mode.NONE" },
];

/**
 * 表示中の施設と、そこで効いている検査方式を読む。
 *
 * **行が無くても行を作らない。** P1 の真偽値から導いた値を出す
 * （`resolveEffectivePolicy()`）。
 */
async function loadPolicy(
  env: ReturnType<typeof getEnv>,
  request: Request,
  now: Date,
): Promise<{
  data: InspectionSettingsData;
  propertyId: string;
  current: InspectionPolicyInput;
  tenant: Awaited<ReturnType<typeof requireAppContext>>["tenant"];
  session: Awaited<ReturnType<typeof requireAppContext>>["session"];
} | null> {
  const { session, tenant } = await requireAppContext(env, request, now);

  const properties = await listSelectableProperties(env, tenant);
  const { property } = resolveSelectedScope(session.selectedPropertyId, tenant, properties);
  if (property === null) return null;

  assertPermission(tenant, "property.write", propertyTarget([property.id]));

  const [stored, row] = await Promise.all([
    findInspectionPolicy(env, tenant, property.id),
    findPropertyById(env, tenant, property.id),
  ]);
  const effective = resolveEffectivePolicy(stored, row?.inspectionRequired ?? false);

  return {
    data: {
      propertyId: property.id,
      propertyName: property.name,
      policy: effective.values,
      configured: effective.configured,
    },
    propertyId: property.id,
    current: effective.values,
    tenant,
    session,
  };
}

export async function loader({
  request,
  context,
}: LoaderFunctionArgs): Promise<InspectionSettingsData> {
  const loaded = await loadPolicy(getEnv(context), request, new Date());
  if (loaded === null) {
    return { propertyId: null, propertyName: null, policy: null, configured: false };
  }
  return loaded.data;
}

interface InspectionSettingsResult {
  saved?: boolean;
}

export async function action({
  request,
  context,
}: ActionFunctionArgs): Promise<InspectionSettingsResult> {
  const env = getEnv(context);
  const now = new Date();

  const form = await request.formData();
  const loaded = await loadPolicy(env, request, now);
  if (loaded === null) throw new NotFoundError();

  const next = parseInspectionPolicyForm(form, loaded.current);
  await upsertInspectionPolicy(env, loaded.tenant, loaded.propertyId, next);

  // security.md §6「施設マスタの更新」。`AUDIT_ACTIONS` は閉じたレジストリで、
  // 検査ポリシー専用の行は根拠が無いため施設の更新として残す（W-20 と同じ扱い）。
  await recordAudit(env, loaded.tenant, {
    actorId: loaded.session.membershipId,
    action: "property.updated",
    targetType: "inspectionPolicy",
    targetId: loaded.propertyId,
    propertyId: loaded.propertyId,
    before: loaded.current,
    after: next,
  });

  return { saved: true };
}

export default function InspectionSettings() {
  const data = useLoaderData<InspectionSettingsData>();
  const result = useActionData<InspectionSettingsResult>();

  if (data.propertyId === null || data.policy === null) {
    return (
      <section className="pk-page">
        <div className="pk-pagehead">
          <h1 className="pk-pagehead__title">{t("insp.settings.title")}</h1>
        </div>
        <p className="pk-notice">{t("insp.settings.noProperty")}</p>
      </section>
    );
  }

  const policy = data.policy;

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <div>
          <h1 className="pk-pagehead__title">{t("insp.settings.title")}</h1>
          <p className="pk-pagehead__sub">{data.propertyName}</p>
        </div>
      </div>

      {result?.saved === true ? <p className="pk-notice">{t("insp.settings.saved")}</p> : null}

      {/* 行が無い施設では「いまの動き」を出していることを明示する。 */}
      {data.configured ? null : <p className="pk-notice">{t("insp.settings.unconfigured")}</p>}

      <Form method="post">
        <fieldset className="pk-fieldset">
          <legend>{t("insp.settings.mode")}</legend>
          {/* §2.3。`NONE` を選ぶと検査待ちに載らないことを、選ぶ前に出す。 */}
          <p className="pk-muted">{t("insp.settings.modeHint")}</p>
          {MODES.map((mode) => (
            <label key={mode.value} className="pk-check">
              <input
                type="radio"
                name="mode"
                value={mode.value}
                defaultChecked={policy.mode === mode.value}
              />
              {t(mode.label)}
            </label>
          ))}
        </fieldset>

        <fieldset className="pk-fieldset">
          <legend>{t("insp.settings.sampleSection")}</legend>
          <p className="pk-muted">{t("insp.settings.sampleHint")}</p>

          <label htmlFor="sampleRate">{t("insp.settings.sampleRate")}</label>
          <input
            id="sampleRate"
            name="sampleRate"
            inputMode="numeric"
            min={0}
            max={100}
            defaultValue={String(policy.sampleRate)}
          />

          <label htmlFor="minDailySample">{t("insp.settings.minDailySample")}</label>
          <input
            id="minDailySample"
            name="minDailySample"
            inputMode="numeric"
            min={0}
            max={MAX_MIN_DAILY_SAMPLE}
            defaultValue={String(policy.minDailySample)}
          />
          <p className="pk-muted">{t("insp.settings.minDailySampleHint")}</p>
        </fieldset>

        {/* 検査担当が居ないと、対象になったタスクが受け取られないまま残る。 */}
        <p className="pk-muted">{t("insp.settings.staffHint")}</p>

        <button className="pk-button pk-button--primary" type="submit">
          {t("insp.settings.save")}
        </button>
      </Form>
    </section>
  );
}
