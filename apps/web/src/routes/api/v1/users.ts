/**
 * 現場スタッフの登録（PK-SPEC-P7 §2.3 Step 5）。
 *
 * ```
 * POST /api/v1/users
 * ```
 *
 * task:  docs/tasks/P7-01.md
 * ルール: .claude/rules/security.md §1 / §2 / §5 / §6
 * 決定:  docs/DECISIONS.md #177
 *
 * ── 受けるのは現場スタッフだけ ──────────────────────────
 * §2.3 Step 5 の「管理者はメールアドレスで招待」は実装していない。
 * 招待リンクの発行・有効期限・受諾の記録という状態が要るが、その定義が
 * 仕様に無い（表も、期限も、再送の規則も）。**推測で作らない。**
 * OPEN_QUESTIONS #101。
 *
 * ── PIN はここでしか返らない ────────────────────────────
 * 保存するのはハッシュだけで、後から引き出す経路が無い（API キーと同じ
 * 扱い / security.md §7）。**再表示できる実装にしないこと。**
 * 控え損ねたら PIN リセット（管理者のみ・監査ログ）でやり直す。
 *
 * ── 一覧・更新の口を置いていない ────────────────────────
 * P7-01 が要るのは登録だけ。ロール変更・無効化・PIN リセットは
 * security.md §6 が監査対象として挙げているが、**担当する task がまだ無い。**
 * `AUDIT_ACTIONS` に行だけが先に在る状態で、経路を作るのは別の task。
 *
 * ── Idempotency-Key ─────────────────────────────────────
 * ヘッダは受けるが、**鍵の記録という別の状態を作らない。**
 * `uq_user_org_staff_number` により 2 回目は `created: false` になり、
 * 409 を返す。**ただし 2 回目に PIN は返らない**（1 回目の PIN は
 * 再現できない）。採番も課金も伴わないので `roomTypes.ts` と同じ判断。
 */

import { fieldStaffCreateSchema, type FieldStaffCreateResponse } from "@pk/contracts";
import { createFieldStaff, recordAudit } from "@pk/db";
import { Hono } from "hono";

import { assertPermission, propertyTarget } from "../../../lib/auth/permission.js";
import { generateInitialPin, hashPin } from "../../../lib/auth/pin.js";
import { getSession, getTenant, type AppEnv } from "../../../middleware/index.js";

const users = new Hono<AppEnv>();

function invalidRequest() {
  return { error: "INVALID_REQUEST" as const };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * 現場スタッフを 1 名登録し、**初期 PIN を 1 回だけ返す。**
 *
 * ── 権限は担当施設で見る ────────────────────────────────
 * `user.write` は `PROPERTY_MANAGER` が `ASSIGNED`。
 * **登録しようとしている施設**を対象に判定するので、担当外の施設へ
 * スタッフを差し込めない。`propertyIds` はリクエストの値だが、
 * `assertPermission()` と第 2 層（`assertIdBelongsToTenant()`）の
 * 両方を通る（`createFieldStaff()` が全件を照合する）。
 */
users.post("/", async (c) => {
  const parsed = fieldStaffCreateSchema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return c.json(invalidRequest(), 400);

  const ctx = getTenant(c);
  const input = parsed.data;
  assertPermission(ctx, "user.write", propertyTarget(input.propertyIds));

  const pin = generateInitialPin();
  const result = await createFieldStaff(c.env, ctx, {
    displayName: input.displayName,
    staffNumber: input.staffNumber,
    role: input.role,
    email: input.email ?? null,
    pinHash: await hashPin(pin),
    locale: input.locale,
    propertyIds: input.propertyIds,
    invitedBy: getSession(c).membershipId,
  });

  // **スタッフ番号の重複は 409。** 黙って既存の行を返すと、
  // 別人に他人の PIN を配ることになる。
  if (!result.created) return c.json({ error: "DUPLICATE_STAFF_NUMBER" as const }, 409);

  await recordAudit(c.env, ctx, {
    actorId: getSession(c).membershipId,
    action: "user.invited",
    targetType: "user",
    targetId: result.userId,
    // **`after` に PIN もハッシュも載せない**（security.md §6）。
    after: {
      staffNumber: input.staffNumber,
      displayName: input.displayName,
      role: input.role,
      propertyIds: input.propertyIds,
    },
  });

  const body: FieldStaffCreateResponse = {
    userId: result.userId,
    membershipId: result.membershipId,
    staffNumber: input.staffNumber,
    displayName: input.displayName,
    role: input.role,
    propertyIds: [...input.propertyIds],
    initialPin: pin,
  };
  return c.json(body, 201);
});

export default users;
