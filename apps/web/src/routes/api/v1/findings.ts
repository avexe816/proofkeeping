/**
 * 差異レポートの API（PK-SPEC-P4 §6.1〜§6.3）。
 *
 * ```
 * GET   /api/v1/findings?propertyId=&from=&to=&status=&severity=
 * GET   /api/v1/findings/:findingId
 * PATCH /api/v1/findings/:findingId/status
 * ```
 *
 * task:  docs/tasks/P4-06.md / docs/tasks/P4-07.md
 * ルール: .claude/rules/security.md §1 / .claude/rules/ui-writing.md §2
 *
 * ── `CLEANER` / `INSPECTOR` はこの口に到達できない ──────
 * §6.4 MUST / security.md §1。`assertPermission()` が `NotFoundError` を
 * 投げ、`resourceGuard` が **404** に写す（403 は存在を示唆する / INV-31）。
 * `PROPERTY_MANAGER` は読めるが閉じられない（`finding.write` は
 * `OWNER` / `ORG_ADMIN` だけ）。
 *
 * ── 差異を作る口・消す口が無い ──────────────────────────
 * 差異は照合の結果としてのみ生まれる（`POST /reconciliation/runs`）。
 * `POST /findings` も `DELETE /findings/:id` も置かない。人が触れるのは
 * **状態と理由だけ**（§6.3）。
 */

import {
  FINDING_LIST_MAX_LIMIT,
  findingStatusRequestSchema,
  type FindingDetailResponse,
  type FindingError,
  type FindingListResponse,
  type FindingStatusResponse,
} from "@pk/contracts";
import { FINDING_SEVERITIES, FINDING_STATUSES } from "@pk/db";
import { Hono } from "hono";

import { assertPermission, propertyTarget, ORGANIZATION_TARGET } from "../../../lib/auth/permission.js";
import {
  applyFindingStatus,
  collectFindingDetail,
  collectFindingList,
} from "../../../lib/reconciliation/findings.js";
import { getSession, getTenant, type AppEnv } from "../../../middleware/index.js";

const findings = new Hono<AppEnv>();

/** 400。**文言を載せない。** 画面が i18n キーへ写す。 */
function invalidRequest(): FindingError {
  return { error: "INVALID_REQUEST" };
}

/** `YYYY-MM-DD` か。**業務日は text なので辞書順の比較で日付順になる。** */
const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 一覧（§6.1）。
 *
 * **施設を必須にしない。** §6.1 のフィルタは「全施設」を含む。
 * 施設を絞らない場合の対象は `withTenantScope()` が決める
 * （施設スコープロールには担当施設ぶんだけが返る）。
 */
findings.get("/", async (c) => {
  const ctx = getTenant(c);
  const propertyId = c.req.query("propertyId");

  // **対象が「全施設」のときは組織全体の権限を要る。** 施設スコープロールは
  // ここで落ちず、`ORGANIZATION_TARGET` に対する `ASSIGNED` が
  // 拒否になる（`can()` の注記）。担当施設を明示すれば読める。
  assertPermission(
    ctx,
    "finding.read",
    propertyId === undefined ? ORGANIZATION_TARGET : propertyTarget([propertyId]),
  );

  const from = c.req.query("from");
  const to = c.req.query("to");
  if (
    (from !== undefined && !BUSINESS_DATE.test(from)) ||
    (to !== undefined && !BUSINESS_DATE.test(to))
  ) {
    return c.json(invalidRequest(), 400);
  }

  const status = parseEnum(c.req.query("status"), FINDING_STATUSES);
  const severity = parseEnum(c.req.query("severity"), FINDING_SEVERITIES);
  if (status === null || severity === null) return c.json(invalidRequest(), 400);

  const body: FindingListResponse = await collectFindingList(c.env, ctx, {
    ...(propertyId === undefined ? {} : { propertyId }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(status === undefined ? {} : { status }),
    ...(severity === undefined ? {} : { severity }),
    limit: FINDING_LIST_MAX_LIMIT,
  });
  return c.json(body);
});

/**
 * 詳細（§6.2）。**3 系統を必ず 3 つ返す**（欠けていれば `null`）。
 *
 * 施設の権限は**差異から解決した `propertyId`** で判定する（INV-32）。
 * 存在しない差異と、担当外施設の差異は**どちらも 404**。
 */
findings.get("/:findingId", async (c) => {
  const ctx = getTenant(c);
  const detail = await collectFindingDetail(c.env, ctx, c.req.param("findingId"));
  if (detail === null) return c.notFound();

  assertPermission(ctx, "finding.read", propertyTarget([detail.finding.propertyId]));

  const body: FindingDetailResponse = detail;
  return c.json(body);
});

/**
 * 状態の変更（§6.3）。
 *
 * **`SUPPRESSED` へは動かせない**（`findingAssignableStatusSchema`）。
 * 抑制は照合が §4.1 の条件で行うもので、手で伏せる操作ではない。
 */
findings.patch("/:findingId/status", async (c) => {
  const ctx = getTenant(c);

  // **権限判定より先に存在を確かめない。** 先に読むと、権限の無いロールが
  // 「404 が速いか遅いか」で存在を推し量れる形に近づく。施設は差異から
  // 解決する必要があるので、まず組織全体の書き込み権限で門を閉じる。
  assertPermission(ctx, "finding.write", ORGANIZATION_TARGET);

  const parsed = findingStatusRequestSchema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return c.json(invalidRequest(), 400);

  const updated = await applyFindingStatus(c.env, ctx, {
    findingId: c.req.param("findingId"),
    status: parsed.data.status,
    resolutionCode: parsed.data.resolutionCode,
    resolutionNote: parsed.data.resolutionNote,
    actorId: getSession(c).membershipId,
  });
  if (updated === null) return c.notFound();

  const body: FindingStatusResponse = { data: updated };
  return c.json(body);
});

/**
 * `a,b,c` を語彙で絞る。
 *
 * @returns 未指定なら `undefined`、語彙に無い値が混ざっていれば `null`（→ 400）。
 *   **知らない値を黙って捨てない。** 捨てると「絞ったつもりが全件」になる。
 */
function parseEnum<T extends string>(
  raw: string | undefined,
  vocabulary: readonly T[],
): readonly T[] | undefined | null {
  if (raw === undefined) return undefined;
  const values = raw.split(",").filter((value) => value !== "");
  if (values.length === 0) return null;
  const known: readonly string[] = vocabulary;
  if (!values.every((value) => known.includes(value))) return null;
  return values as T[];
}

/** JSON を読む。**壊れていたら `null`。** 例外を 500 にしない。 */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export default findings;
