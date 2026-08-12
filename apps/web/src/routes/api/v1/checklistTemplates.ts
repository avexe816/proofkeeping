/**
 * チェックリスト定義の API（W-16 / PK-SPEC-P1 §6）。
 *
 * ```
 * GET    /api/v1/checklist-templates
 * POST   /api/v1/checklist-templates
 * PUT    /api/v1/checklist-templates/:templateId
 * DELETE /api/v1/checklist-templates/:templateId   無効化（物理削除しない）
 * ```
 *
 * task: docs/tasks/P1-06.md
 *
 * ── 3 階層 ──────────────────────────────────────────────
 * `propertyId = null` が組織共通、施設のみ指定が施設別、
 * 施設 + 客室タイプが客室タイプ別（§6.1）。**解決は
 * `packages/engine` の `resolveTemplate()`** で、タスク生成時に 1 つ選ぶ。
 */

import {
  checklistTemplateUpsertRequestSchema,
  type ChecklistTemplate,
  type ChecklistTemplateListResponse,
  type TaskError,
} from "@pk/contracts";
import {
  createTemplate,
  deactivateTemplate,
  listTemplateItems,
  listTemplates,
  replaceTemplateItems,
} from "@pk/db";
import { Hono } from "hono";

import { assertPermission, ORGANIZATION_TARGET } from "../../../lib/auth/permission.js";
import { getTenant, type AppEnv } from "../../../middleware/index.js";

const checklistTemplates = new Hono<AppEnv>();

function invalidRequest(): TaskError {
  return { error: "INVALID_REQUEST" };
}

checklistTemplates.get("/", async (c) => {
  const ctx = getTenant(c);
  // テンプレートは組織共通の行を含むため、対象は組織（施設で絞れない）。
  assertPermission(ctx, "checklistTemplate.read", ORGANIZATION_TARGET);

  const templates = await listTemplates(c.env, ctx);
  const items = await listTemplateItems(
    c.env,
    ctx,
    templates.map((template) => template.id),
  );

  const body: ChecklistTemplateListResponse = {
    data: templates.map(
      (template): ChecklistTemplate => ({
        templateId: template.id,
        propertyId: template.propertyId,
        roomTypeId: template.roomTypeId,
        taskType: template.taskType,
        name: template.name,
        version: template.version,
        isActive: template.isActive,
        items: items
          .filter((item) => item.templateId === template.id)
          .map((item) => ({
            itemId: item.id,
            section: item.section,
            labels: item.labels,
            isRequired: item.isRequired,
            photoRequired: item.photoRequired,
            sortOrder: item.sortOrder,
          })),
      }),
    ),
  };
  return c.json(body);
});

checklistTemplates.post("/", async (c) => {
  const body = checklistTemplateUpsertRequestSchema.safeParse(await readJson(c.req.raw));
  if (!body.success) return c.json(invalidRequest(), 400);

  // 組織共通テンプレートに客室タイプは付かない（§6.1 の階層に無い形）。
  if (body.data.propertyId === null && body.data.roomTypeId !== null) {
    return c.json(invalidRequest(), 400);
  }

  const ctx = getTenant(c);
  assertPermission(ctx, "checklistTemplate.write", ORGANIZATION_TARGET);

  const templateId = await createTemplate(c.env, ctx, {
    propertyId: body.data.propertyId,
    roomTypeId: body.data.roomTypeId,
    taskType: body.data.taskType,
    name: body.data.name,
    items: body.data.items,
  });

  return c.json({ templateId }, 201);
});

/**
 * 項目の差し替え。**版が 1 上がる。**
 *
 * 実施済みの記録は `templateVersion` で当時の版に固定されているので、
 * 過去の意味は変わらない（§2.2）。
 */
checklistTemplates.put("/:templateId", async (c) => {
  const body = checklistTemplateUpsertRequestSchema.safeParse(await readJson(c.req.raw));
  if (!body.success) return c.json(invalidRequest(), 400);

  const ctx = getTenant(c);
  assertPermission(ctx, "checklistTemplate.write", ORGANIZATION_TARGET);

  await replaceTemplateItems(c.env, ctx, c.req.param("templateId"), {
    name: body.data.name,
    items: body.data.items,
  });

  return c.json({ templateId: c.req.param("templateId") });
});

/** 無効化。**物理削除の口を作らない。** */
checklistTemplates.delete("/:templateId", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "checklistTemplate.write", ORGANIZATION_TARGET);

  await deactivateTemplate(c.env, ctx, c.req.param("templateId"));
  return c.json({ templateId: c.req.param("templateId"), isActive: false });
});

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export default checklistTemplates;
