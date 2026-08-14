/**
 * ルール設定の API（PK-SPEC-P4 §2.7・§8 / W-25）。
 *
 * ```
 * GET   /api/v1/rule-configs?propertyId=
 * PATCH /api/v1/rule-configs/:ruleCode
 * ```
 *
 * task:  docs/tasks/P4-13.md
 * ルール: .claude/rules/security.md §1・§6
 *
 * ── `OWNER` / `ORG_ADMIN` だけ ──────────────────────────
 * §6.4 の表。**施設責任者にも開かない**（閾値は判定の内側の値で、
 * `baseline.read` と同じ扱い）。`AUDITOR` は読み取りのみ。
 *
 * ── engine を変えずに調整できる（P4-13 の完了条件）──────
 * 送れるのは有効・無効／重要度の上書き／閾値の 3 つ。
 * **ルールの条件式を送る口を作らない**（§13 の未決事項）。
 *
 * ── 消す口が無い ────────────────────────────────────────
 * 既定へ戻すのは既定値を書くこと。行を消すと「既定に戻した」と
 * 「一度も触っていない」が `rulesetHash`（§2.4）から区別できなくなる。
 */

import {
  RULE_CODES,
  ruleConfigUpdateRequestSchema,
  type RuleCodeValue,
  type RuleConfigError,
  type RuleConfigListResponse,
  type RuleConfigUpdateResponse,
} from "@pk/contracts";
import { findPropertyById, listRuleConfigs, recordAudit, upsertRuleConfig } from "@pk/db";
import { Hono } from "hono";

import { assertPermission, propertyTarget } from "../../../lib/auth/permission.js";
import { collectRuleConfigs, toSummary } from "../../../lib/reconciliation/ruleConfig.js";
import { getSession, getTenant, type AppEnv } from "../../../middleware/index.js";

const ruleConfigs = new Hono<AppEnv>();

/** 語彙にあるルールコードか。**型述語**（以降のキャストを不要にする）。 */
function isRuleCode(value: string): value is RuleCodeValue {
  return (RULE_CODES as readonly string[]).includes(value);
}

/** 400。**文言を載せない。** 画面が i18n キーへ写す。 */
function invalidRequest(): RuleConfigError {
  return { error: "INVALID_REQUEST" };
}

/** 一覧（§2.7）。**14 個すべてを返す**（設定の無いものも既定として並べる）。 */
ruleConfigs.get("/", async (c) => {
  const ctx = getTenant(c);
  const propertyId = c.req.query("propertyId");
  if (propertyId === undefined) return c.json(invalidRequest(), 400);

  assertPermission(ctx, "ruleConfig.read", propertyTarget([propertyId]));

  const property = await findPropertyById(c.env, ctx, propertyId);
  if (property === undefined) return c.notFound();

  const body: RuleConfigListResponse = {
    propertyId: property.id,
    data: await collectRuleConfigs(c.env, ctx, property.id),
  };
  return c.json(body);
});

/**
 * 1 ルールの設定（§2.7）。
 *
 * **経路が §8 と違う**（`:id` ではなく `:ruleCode`）。まだ触っていない
 * ルールには行が無く `id` を持てないため（DECISIONS #118）。
 */
ruleConfigs.patch("/:ruleCode", async (c) => {
  const ctx = getTenant(c);
  const ruleCode = c.req.param("ruleCode");
  // **語彙で絞ってから使う。** `includes()` の型述語で `RuleCodeValue` に
  // 狭まるので、以降のキャストは要らない。
  if (!isRuleCode(ruleCode)) return c.json(invalidRequest(), 400);

  const parsed = ruleConfigUpdateRequestSchema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return c.json(invalidRequest(), 400);

  // 施設の設定なら施設で、組織の既定なら組織全体で判定する。
  // **`ruleConfig.write` は `OWNER` / `ORG_ADMIN` だけ**なので、
  // どちらの対象でも通るのは同じ 2 ロール。
  const { propertyId } = parsed.data;
  assertPermission(
    ctx,
    "ruleConfig.write",
    propertyTarget(propertyId === null ? [] : [propertyId]),
  );

  // 組織の既定（`propertyId = null`）は施設で絞れない。**上の判定は
  // `ORG` スコープのロールしか通らない**ので、ここで施設の実在だけを見る。
  if (propertyId !== null) {
    const property = await findPropertyById(c.env, ctx, propertyId);
    if (property === undefined) return c.notFound();
  }

  // **変更前を読んでおく**（監査ログの `before`）。`propertyId` が `null` なら
  // 組織の既定だけが返る（`listRuleConfigs()` の注記）。
  const beforeRows = await listRuleConfigs(c.env, ctx, propertyId);
  const beforeSummary = toSummary(ruleCode, beforeRows, propertyId ?? "");

  await upsertRuleConfig(c.env, ctx, {
    propertyId,
    ruleCode,
    isEnabled: parsed.data.isEnabled,
    severityOverride: parsed.data.severityOverride,
    thresholds: parsed.data.thresholds,
  });

  // security.md §6「組織設定の変更」。**判定の設定を変える操作は残す。**
  await recordAudit(c.env, ctx, {
    actorId: getSession(c).membershipId,
    action: "organization.updated",
    targetType: "ruleConfig",
    targetId: ruleCode,
    ...(propertyId === null ? {} : { propertyId }),
    before: {
      isEnabled: beforeSummary.isEnabled,
      severityOverride: beforeSummary.severityOverride,
      thresholds: beforeSummary.thresholds,
    },
    after: {
      isEnabled: parsed.data.isEnabled,
      severityOverride: parsed.data.severityOverride,
      thresholds: parsed.data.thresholds,
    },
  });

  const afterRows = await listRuleConfigs(c.env, ctx, propertyId);
  const body: RuleConfigUpdateResponse = {
    data: toSummary(ruleCode, afterRows, propertyId ?? ""),
  };
  return c.json(body);
});

/** JSON を読む。**壊れていたら `null`。** 例外を 500 にしない。 */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export default ruleConfigs;
