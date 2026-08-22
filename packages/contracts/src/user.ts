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

/**
 * 現場（`/m/*`）の表示言語（PK-IMPL-CONTRACT §7.1 の 7 言語）。
 *
 * ── なぜ 7 つあるのか ───────────────────────────────────
 * 以前ここは `["ja", "en"]` の 2 つだけで、**登録画面で日本語と英語しか
 * 選べなかった。** カタログ（`apps/web/src/locales`）には 7 言語ぶんの
 * 翻訳が揃っており（DECISIONS #128 の機械翻訳の承認）、モバイルは
 * 初回起動で自国語を選べる設計になっている。**選ばせる側だけが
 * 2 つのままだった**（人間の指摘 2026-08-22 / DECISIONS #267）。
 *
 * 並びは契約 §7.1 と `LOCALES`（`apps/web/src/locales/index.ts`）に揃える。
 * **2 か所に同じ一覧を置いている**ので、`i18n.spec.ts` が食い違いを見る。
 * 管理画面は日本語のみ（ui-writing.md §1）。ここは現場の話。
 */
export const STAFF_LOCALES = ["ja", "en", "zh-CN", "vi", "id", "my", "ne"] as const;

export const staffLocaleSchema = z.enum(STAFF_LOCALES);

export type StaffLocaleValue = (typeof STAFF_LOCALES)[number];

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
  /** モバイルの表示言語（7 言語 / `STAFF_LOCALES`）。管理画面は日本語のみ。 */
  locale: staffLocaleSchema.optional(),
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

/**
 * 現場スタッフの編集（W-07 のスタッフ詳細レイヤー / 人間の指示 2026-08-22）。
 *
 * ── スタッフ番号を編集項目に入れない ────────────────────
 * あれは**ログインの 3 フィールドのうちの 1 つ**（security.md §2）で、
 * 現場に配った案内カードにも印字されている。ここで書き換えられると、
 * 手元の紙でログインできない人が出る。番号を変えたい場合は
 * 新しい番号で登録し直す（ロールの族またぎと同じ扱い）。
 *
 * ── PIN もここでは触らない ──────────────────────────────
 * 再発行は W-12（権限と監査）の `reissueCredential()` が持つ。
 * **発行値を返す経路を 2 つにしない**（DECISIONS #177 / #181）。
 *
 * ── `email` は `null` を許す ────────────────────────────
 * 登録時は任意（`optional()`）だが、編集では**空欄にして消せる**必要が
 * ある。`optional()` のままだと「送らなかった」と「消したい」を
 * 区別できず、フォームからは常に前者になる。
 */
export const fieldStaffUpdateSchema = z.object({
  membershipId: z.string().min(1),
  displayName: z.string().trim().min(1).max(64),
  role: fieldStaffRoleSchema,
  /** 通知の送信先。**空欄で消せる**（上の注記）。 */
  email: z.union([z.email().trim().max(254), z.null()]),
  /** 担当施設。**登録と同じく 1 つ以上**（空にすると本人にタスクが出ない）。 */
  propertyIds: z.array(z.string().min(1)).min(1).max(50),
  locale: staffLocaleSchema,
});

export type FieldStaffUpdateRequest = z.infer<typeof fieldStaffUpdateSchema>;
