/**
 * 現場スタッフの登録 API の入出力（PK-SPEC-P7 §2.3 Step 5）。
 *
 * task:  docs/tasks/P7-01.md
 * ルール: .claude/rules/security.md §1 / §2 / §5
 * 決定:  docs/DECISIONS.md #177（PIN はサーバーが発行する）
 *
 * ── 現場スタッフだけを受ける ────────────────────────────
 * §2.3 Step 5 は 2 系統を挙げる。
 *
 *   管理者      メールアドレスで招待
 *   清掃スタッフ 名前とスタッフ番号を登録 → PIN を発行
 *
 * **ここが受けるのは後者だけ。** 前者は招待リンクの発行・有効期限・
 * 受諾の記録という状態が要るが、その定義が仕様のどこにも無い
 * （表も、期限も、再送の規則も）。**推測で作らない**（CLAUDE.md §1 の 4）。
 * 未実装であることは OPEN_QUESTIONS #101 に起票してある。
 *
 * ── PIN を入力として受け取らない ────────────────────────
 * `pin` フィールドを置いていない。**サーバーが発行して 1 回だけ返す。**
 * 管理者に選ばせると、30 名ぶんの登録で同じ 4 桁が並ぶ
 * （`pinSchema` は連番とゾロ目しか弾けない）。DECISIONS #177。
 */

import { z } from "zod";

import { staffNumberSchema } from "./auth.js";

/**
 * PIN でログインするロール（security.md §2 の「現場系」）。
 *
 * **`ROLES` の部分集合であることを `user.spec.ts` が確かめている。**
 * ここを広げるときは、そのロールがパスワードではなく PIN でよいか
 * （§2 の表）を先に確かめること。
 */
export const FIELD_STAFF_ROLES = ["CLEANER", "INSPECTOR"] as const;

export const fieldStaffRoleSchema = z.enum(FIELD_STAFF_ROLES);

export type FieldStaffRoleValue = (typeof FIELD_STAFF_ROLES)[number];

/**
 * 現場スタッフの登録。
 *
 * **`propertyIds` を必須にしてある。** 施設スコープのロールは割当が無いと
 * タスクが 1 件も表示されない。空で作れると「登録したのに何も出ない」に
 * なり、原因が現場からは読めない（`getting-started.md` §4 の注意書き）。
 */
export const fieldStaffCreateSchema = z.object({
  displayName: z.string().trim().min(1).max(64),
  staffNumber: staffNumberSchema,
  role: fieldStaffRoleSchema,
  /** 通知の送信先。**ログイン識別子ではない**（DECISIONS #018）。 */
  email: z.email().trim().max(254).optional(),
  /** 担当施設。**1 つ以上。** */
  propertyIds: z.array(z.string().min(1)).min(1).max(50),
  /** モバイルの表示言語。管理画面は日本語のみ（ui-writing.md §1）。 */
  locale: z.enum(["ja", "en"]).optional(),
});

export type FieldStaffCreateRequest = z.infer<typeof fieldStaffCreateSchema>;

/**
 * 登録の応答。
 *
 * **`initialPin` はここでしか返らない。** 保存しているのはハッシュだけで、
 * 後から引き出す経路が無い（API キーと同じ扱い / security.md §7）。
 * 控え損ねたら PIN リセット（管理者のみ・監査ログ）でやり直す。
 */
export interface FieldStaffCreateResponse {
  userId: string;
  membershipId: string;
  staffNumber: string;
  displayName: string;
  role: FieldStaffRoleValue;
  propertyIds: string[];
  /** **1 回だけ返る 4 桁。** 初回ログインで変更が強制される。 */
  initialPin: string;
}
