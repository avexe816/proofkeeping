/**
 * 在留資格の書き込み（P8-02 / PK-SPEC-P8 §1.4）。
 *
 * task: docs/tasks/P8-02.md
 * ルール: .claude/rules/security.md §1（権限）・§6（監査ログ）
 *
 * ── なぜ画面から切り出してあるのか ──────────────────────
 * `routes/app/staff.tsx` は**初期 PIN を `action` の戻り値として運ぶ**
 * （DECISIONS #177 / #184）。`tests/security/initialPin.spec.ts` は
 * PIN を持つファイルから Queue・ログ・R2・**監査ログ**への口が
 * 生えていないことを見ている。同居させると、取り違えたときに
 * PIN が監査ログへ入りうる。**口を別のファイルへ寄せる。**
 */

import { residencyUpsertRequestSchema } from "@pk/contracts";
import { recordAudit, upsertResidencyRecord, type Env, type TenantContext } from "@pk/db";

import { ORGANIZATION_TARGET, assertPermission } from "../auth/permission.js";

/** 保存の結果。**PIN と違い、再表示できる情報しか含まない。** */
export type ResidencySaveResult =
  | { residencySaved: true }
  /** `reason` は Zod の `message`（画面が文言のキーへ写す）。 */
  | { residencyInvalid: string };

/** 空欄を `null` にする。**空文字を日付として通さない。** */
function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** フォームの値を文字列で取り出す。 */
function fieldOf(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * 在留資格を記録する（P8-02 / PK-SPEC-P8 §1.4）。
 *
 * ── 門をここでもう一度通す ──────────────────────────────
 * loader の `can()` は**表示の出し分け**で、権限制御ではない
 * （security.md §1）。書き込みは `assertPermission()` で必ず落とす。
 *
 * ── 監査ログに載せるのは期限と種別だけ ──────────────────
 * `note` には手続きの経緯が書かれうる。**`after` へ写さない**
 * （監査ログに個人の事情を残さない / security.md §6）。
 */
export async function saveResidency(
  env: Env,
  tenant: TenantContext,
  actorId: string,
  form: FormData,
): Promise<ResidencySaveResult> {
  assertPermission(tenant, "residency.write", ORGANIZATION_TARGET);

  const weeklyHourLimit = fieldOf(form, "weeklyHourLimit").trim();
  const parsed = residencyUpsertRequestSchema.safeParse({
    staffProfileId: fieldOf(form, "staffProfileId"),
    statusType: fieldOf(form, "statusType"),
    statusLabel: emptyToNull(fieldOf(form, "statusLabel")),
    expiresOn: emptyToNull(fieldOf(form, "expiresOn")),
    renewalAppliedOn: emptyToNull(fieldOf(form, "renewalAppliedOn")),
    workPermitRequired: form.get("workPermitRequired") !== null,
    weeklyHourLimit: weeklyHourLimit === "" ? null : Number(weeklyHourLimit),
    note: emptyToNull(fieldOf(form, "note")),
  });
  if (!parsed.success) {
    return { residencyInvalid: parsed.error.issues[0]?.message ?? "INVALID" };
  }

  // `nullish()` は `undefined` も許すので、表の `null` へ寄せてから渡す。
  // **`??` で埋めるのは列の既定値ではなく「未入力」の意味。**
  await upsertResidencyRecord(env, tenant, {
    staffProfileId: parsed.data.staffProfileId,
    statusType: parsed.data.statusType,
    statusLabel: parsed.data.statusLabel ?? null,
    expiresOn: parsed.data.expiresOn ?? null,
    renewalAppliedOn: parsed.data.renewalAppliedOn ?? null,
    workPermitRequired: parsed.data.workPermitRequired,
    weeklyHourLimit: parsed.data.weeklyHourLimit ?? null,
    note: parsed.data.note ?? null,
    updatedById: actorId,
  });

  await recordAudit(env, tenant, {
    actorId,
    action: "residency.updated",
    targetType: "residency_record",
    targetId: parsed.data.staffProfileId,
    // **期限と種別だけ。** ノートも週上限も載せない。
    after: { statusType: parsed.data.statusType, expiresOn: parsed.data.expiresOn ?? null },
  });

  return { residencySaved: true };
}
