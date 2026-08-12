import { SEAL_IMAGE, taxProfileUpdateSchema } from "@pk/contracts";
import { findTaxProfile, recordAudit, updateTaxProfile } from "@pk/db";
import {
  Form,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { ORGANIZATION_TARGET, assertPermission } from "../../lib/auth/permission.js";
import { t } from "../../lib/i18n.js";
import { sealImageKey, signObjectUrl } from "../../lib/storage/signedUrl.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

/**
 * W-11 事業者・税務設定（PK-SPEC-P0 §7.2 / billing.md §1）。
 *
 *   /app/settings/tax
 *
 * task: docs/tasks/P0-16.md
 *
 * ── 登録番号が無いと適格請求書を発行できない ────────────
 * billing.md §1。**未設定であること自体は誤りではない**（取得前の
 * 事業者がいる）。画面は事実として述べ、入力を強制しない。
 *
 * ── 角印は R2。DB には鍵だけ ────────────────────────────
 * 画像を DB に入れない。閲覧は 15 分の署名付き URL（security.md §4）。
 *
 * ── 変更は監査ログ ──────────────────────────────────────
 * security.md §6 の対象。**発行済み帳票は変わらない**（スナップショット /
 * billing.md §6）ので、before/after を残して追えるようにする。
 */

interface TaxProfileData {
  legalName: string;
  invoiceRegistrationNumber: string | null;
  defaultTaxRoundingMode: "FLOOR" | "CEIL" | "ROUND";
  postalCode: string | null;
  address: string | null;
  tel: string | null;
  fiscalYearStartMonth: number;
  /** 署名付き URL。角印が無ければ `null`。 */
  sealUrl: string | null;
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<TaxProfileData> {
  const env = getEnv(context);
  const now = new Date();
  const { tenant } = await requireAppContext(env, request, now);
  assertPermission(tenant, "taxProfile.read", ORGANIZATION_TARGET);

  const profile = await findTaxProfile(env, tenant);

  return {
    legalName: profile?.legalName ?? "",
    invoiceRegistrationNumber: profile?.invoiceRegistrationNumber ?? null,
    defaultTaxRoundingMode: profile?.defaultTaxRoundingMode ?? "ROUND",
    postalCode: profile?.postalCode ?? null,
    address: profile?.address ?? null,
    tel: profile?.tel ?? null,
    fiscalYearStartMonth: profile?.fiscalYearStartMonth ?? 4,
    sealUrl:
      profile?.sealImageKey === undefined || profile.sealImageKey === null
        ? null
        : await signObjectUrl(env.SESSION_SECRET, profile.sealImageKey, now),
  };
}

interface TaxProfileActionResult {
  saved?: boolean;
  invalidRegistrationNumber?: boolean;
  sealRejected?: boolean;
}

export async function action({
  request,
  context,
}: ActionFunctionArgs): Promise<TaxProfileActionResult> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);
  assertPermission(tenant, "taxProfile.write", ORGANIZATION_TARGET);

  const form = await request.formData();
  const parsed = taxProfileUpdateSchema.safeParse({
    legalName: form.get("legalName"),
    invoiceRegistrationNumber: form.get("invoiceRegistrationNumber") ?? "",
    defaultTaxRoundingMode: form.get("defaultTaxRoundingMode"),
    postalCode: form.get("postalCode") ?? undefined,
    address: form.get("address") ?? undefined,
    tel: form.get("tel") ?? undefined,
    fiscalYearStartMonth: form.get("fiscalYearStartMonth"),
  });
  if (!parsed.success) return { invalidRegistrationNumber: true };

  // 角印。差し替えないときは触らない（`sealImageKey` を渡さない）。
  const seal = form.get("seal");
  let storedKey: string | undefined;
  if (seal instanceof File && seal.size > 0) {
    const allowed: readonly string[] = SEAL_IMAGE.contentTypes;
    if (seal.size > SEAL_IMAGE.maxBytes || !allowed.includes(seal.type)) {
      return { sealRejected: true };
    }
    storedKey = sealImageKey(tenant.organizationId);
    await env.DOCUMENTS.put(storedKey, await seal.arrayBuffer(), {
      httpMetadata: { contentType: seal.type },
    });
  }

  const before = await findTaxProfile(env, tenant);
  await updateTaxProfile(env, tenant, {
    ...parsed.data,
    ...(storedKey === undefined ? {} : { sealImageKey: storedKey }),
  });

  await recordAudit(env, tenant, {
    actorId: session.membershipId,
    action: "taxProfile.updated",
    targetType: "organizationTaxProfile",
    before: before ?? null,
    after: parsed.data,
  });

  return { saved: true };
}

export default function TaxProfile() {
  const data = useLoaderData<TaxProfileData>();
  const result = useActionData<TaxProfileActionResult>();

  return (
    <section className="pk-page">
      <h1 className="pk-page__title">{t("tax.title")}</h1>

      {result?.saved === true ? <p className="pk-notice">{t("tax.saved")}</p> : null}
      {result?.invalidRegistrationNumber === true ? (
        <p className="pk-notice">{t("tax.invoiceRegistrationNumber.invalid")}</p>
      ) : null}
      {result?.sealRejected === true ? (
        <p className="pk-notice">{t("tax.seal.rejected")}</p>
      ) : null}

      {/* 未設定であることを事実として述べる。入力は強制しない。 */}
      {data.invoiceRegistrationNumber === null ? (
        <p className="pk-notice pk-notice--info">
          {t("tax.invoiceRegistrationNumber.absent")}
        </p>
      ) : null}

      <Form method="post" encType="multipart/form-data" className="pk-form">
        <label htmlFor="legalName">{t("tax.legalName")}</label>
        <input id="legalName" name="legalName" defaultValue={data.legalName} required />

        <label htmlFor="invoiceRegistrationNumber">{t("tax.invoiceRegistrationNumber")}</label>
        <input
          id="invoiceRegistrationNumber"
          name="invoiceRegistrationNumber"
          defaultValue={data.invoiceRegistrationNumber ?? ""}
          placeholder={t("tax.invoiceRegistrationNumber.hint")}
          pattern="T[0-9]{13}"
        />

        <label htmlFor="defaultTaxRoundingMode">{t("tax.roundingMode")}</label>
        <select
          id="defaultTaxRoundingMode"
          name="defaultTaxRoundingMode"
          defaultValue={data.defaultTaxRoundingMode}
        >
          <option value="FLOOR">{t("tax.roundingMode.FLOOR")}</option>
          <option value="CEIL">{t("tax.roundingMode.CEIL")}</option>
          <option value="ROUND">{t("tax.roundingMode.ROUND")}</option>
        </select>

        <label htmlFor="fiscalYearStartMonth">{t("tax.fiscalYearStartMonth")}</label>
        <input
          id="fiscalYearStartMonth"
          name="fiscalYearStartMonth"
          inputMode="numeric"
          defaultValue={String(data.fiscalYearStartMonth)}
        />

        <label htmlFor="postalCode">{t("tax.postalCode")}</label>
        <input id="postalCode" name="postalCode" defaultValue={data.postalCode ?? ""} />

        <label htmlFor="address">{t("tax.address")}</label>
        <input id="address" name="address" defaultValue={data.address ?? ""} />

        <label htmlFor="tel">{t("tax.tel")}</label>
        <input id="tel" name="tel" defaultValue={data.tel ?? ""} />

        <h2>{t("tax.seal")}</h2>
        {data.sealUrl === null ? (
          <p>{t("tax.seal.none")}</p>
        ) : (
          <img className="pk-seal" src={data.sealUrl} alt={t("tax.seal")} width={96} height={96} />
        )}
        <label htmlFor="seal">{t("tax.seal.upload")}</label>
        <input id="seal" name="seal" type="file" accept="image/png,image/jpeg" />
        <p className="pk-hint">{t("tax.seal.hint")}</p>

        <button className="pk-button" type="submit">
          {t("tax.save")}
        </button>
      </Form>
    </section>
  );
}
