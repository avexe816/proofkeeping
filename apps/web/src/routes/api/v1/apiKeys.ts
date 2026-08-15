/**
 * API キーの管理（PK-SPEC-P6 §6.1 / P6-12）。
 *
 * ```
 * GET    /api/v1/api-keys
 * POST   /api/v1/api-keys              作成（**平文は 1 回だけ返る**）
 * DELETE /api/v1/api-keys/:apiKeyId    失効
 * ```
 *
 * task:  docs/tasks/P6-12.md
 * ルール: .claude/rules/security.md §6・§7
 *
 * ── 再表示できる口を作らない（§6.1 MUST）─────────────────
 * 平文のトークンを返すのは `POST` の応答**ただ 1 回。** `GET` は
 * `keyPrefix` までしか返さず、**再発行の口も無い**（無くしたら作り直す）。
 * この経路を足したくなったら §6.1 MUST を読み直すこと。
 *
 * ── セッション側の口 ────────────────────────────────────
 * ここは Cookie を持つ管理者の口。**公開 API（`/api/v1/public/*`）とは
 * 認証も middleware も別。** キーを作るのは人、使うのは機械。
 */

import { createApiKey, listApiKeys, recordAudit, revokeApiKey } from "@pk/db";
import { apiKeyCreateRequestSchema } from "@pk/contracts";
import { Hono } from "hono";

import { issueApiKey } from "../../../lib/auth/apiKey.js";
import { assertPermission, propertyTarget } from "../../../lib/auth/permission.js";
import { getSession, getTenant, type AppEnv } from "../../../middleware/index.js";

const apiKeys = new Hono<AppEnv>();

/** 400。**文言を載せない。** 画面が i18n キーへ写す。 */
function invalidRequest() {
  return { error: "INVALID_REQUEST" as const };
}

/** JSON を読む。**壊れていたら `null`。** */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** 一覧。**`keyHash` も平文も返さない。** */
apiKeys.get("/", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "apiKey.read", propertyTarget([]));

  const rows = await listApiKeys(c.env, ctx);
  return c.json({
    data: rows.map((row) => ({
      apiKeyId: row.id,
      name: row.name,
      keyPrefix: row.keyPrefix,
      scopes: row.scopes,
      propertyIds: row.propertyIds,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
  });
});

/**
 * 作成（§6.1）。**平文はこの応答にだけ載る。**
 *
 * `propertyIds` は `null`（組織全体）か配列。**`[]` は「1 件も見えない」**
 * で、`null` と取り違えないこと（DECISIONS #017）。
 */
apiKeys.post("/", async (c) => {
  const parsed = apiKeyCreateRequestSchema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return c.json(invalidRequest(), 400);

  const ctx = getTenant(c);
  assertPermission(ctx, "apiKey.write", propertyTarget([]));

  const issued = await issueApiKey(ctx.orgShortId);
  const row = await createApiKey(c.env, ctx, {
    name: parsed.data.name,
    keyPrefix: issued.keyPrefix,
    keyHash: issued.keyHash,
    scopes: parsed.data.scopes,
    propertyIds: parsed.data.propertyIds,
    expiresAt: parsed.data.expiresAt === null ? null : new Date(parsed.data.expiresAt),
    createdById: getSession(c).membershipId,
  });

  // security.md §6 は「エンタイトルメントの変更」までしか列挙していないが、
  // **公開 API の鍵を増やす操作**は CLAUDE.md §5 の「破壊的操作」に当たる。
  // `before` / `after` に**平文もハッシュも入れない**（同 §6）。
  await recordAudit(c.env, ctx, {
    actorId: getSession(c).membershipId,
    action: "apiKey.created",
    targetType: "apiKey",
    targetId: row.id,
    after: {
      name: row.name,
      keyPrefix: row.keyPrefix,
      scopes: row.scopes,
      propertyIds: row.propertyIds,
      expiresAt: row.expiresAt?.toISOString() ?? null,
    },
  });

  return c.json(
    {
      apiKeyId: row.id,
      name: row.name,
      keyPrefix: row.keyPrefix,
      scopes: row.scopes,
      propertyIds: row.propertyIds,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      /**
       * **この 1 回だけ。** 再取得の口は無い（§6.1 MUST）。
       * 画面はこの値を保存せず、その場で利用者に控えさせる。
       */
      token: issued.token,
    },
    201,
  );
});

/** 失効（§6.1）。**行は消さない。** */
apiKeys.delete("/:apiKeyId", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "apiKey.write", propertyTarget([]));

  const apiKeyId = c.req.param("apiKeyId");
  await revokeApiKey(c.env, ctx, apiKeyId);

  await recordAudit(c.env, ctx, {
    actorId: getSession(c).membershipId,
    action: "apiKey.revoked",
    targetType: "apiKey",
    targetId: apiKeyId,
  });

  return c.json({ revoked: true });
});

export default apiKeys;
