/**
 * 監査ログに載せる値のマスク。
 *
 * task:  docs/tasks/P0-11.md
 * ルール: .claude/rules/security.md §6（`before` / `after` にパスワードハッシュ・
 *        PIN ハッシュを含めない。マスクする）
 *
 * ── なぜ呼び出し側に任せないのか ────────────────────────
 * `recordAudit()` に渡る `before` / `after` は、多くの場合
 * **リポジトリが返した行をそのまま**流し込んだものになる。
 * `repositories/user.ts` の doc が繰り返し警告しているとおり、`user` の行には
 * `passwordHash` / `pinHash` が含まれる。「呼ぶ側が消す」規約にすると、
 * 消し忘れが**監査ログという最も長く残る場所**（保存 5 年 / INV-30 により
 * 削除もできない）に蓄積する。よってマスクは書き込み経路の内側に置き、
 * 迂回できない形にする。
 *
 * ── 過剰にマスクする方へ倒す ────────────────────────────
 * 鍵の名前で判定するため `spinner` や `pinCode` のような無関係な名前も
 * 巻き込む。**それでよい。** 監査ログは「何が起きたか」を残すためのもので、
 * 値そのものを 1 バイトも欠かさず持つ必要はない。逆向きの誤り
 * （ハッシュが 1 つ漏れる）は取り返しがつかない。
 */

/** マスク後に入る値。**元の長さを推測させないため固定文字列にする。** */
export const MASKED = "***";

/**
 * この語を含む鍵の値をマスクする。
 *
 * 語を減らすときは、それが本当に「監査ログへ平文で残してよい」ものかを
 * security.md §6 と §7（外部連携の資格情報）に照らして確かめること。
 */
const SENSITIVE_KEY =
  /password|passwd|\bpin\b|pin_?hash|secret|token|credential|api_?key|authorization|cookie|salt/i;

/**
 * 鍵の名前に関わらずマスクする値の形。
 *
 * `pbkdf2$sha256$210000$...` は自己記述文字列なので、鍵が
 * `value` や `after` のような一般名で運ばれても形から判別できる
 * （docs/DECISIONS.md #019 / #021）。鍵名の判定を補う二段目。
 */
const SENSITIVE_VALUE = /^pbkdf2\$/;

/**
 * 潜る深さの上限。これを超えた枝は丸ごと `MASKED` にする。
 *
 * 循環参照で無限に潜らないための保険を兼ねる。監査ログの `before` / `after` は
 * 1 テーブルの行を想定しており、6 段も入れ子になる値は元より想定外。
 */
const MAX_DEPTH = 6;

/**
 * 監査ログに載せる値からセンシティブな項目を落とす。
 *
 * 配列・入れ子のオブジェクトも辿る。`Date` は ISO 文字列にする
 * （`JSON.stringify` の既定と同じだが、ここで確定させておくと
 * 保存形式が実装依存にならない）。
 */
export function maskSensitive(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return MASKED;

  if (typeof value === "string") {
    return SENSITIVE_VALUE.test(value) ? MASKED : value;
  }
  if (value === null || typeof value !== "object") {
    // number / boolean / undefined / bigint / symbol。そのまま返す。
    // JSON 化できない型は `serializeAuditPayload()` が落とす。
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item) => maskSensitive(item, depth + 1));
  }

  const masked: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    masked[key] = SENSITIVE_KEY.test(key) ? MASKED : maskSensitive(item, depth + 1);
  }
  return masked;
}

/**
 * `auditLog.before` / `auditLog.after`（text 列）へ入れる文字列にする。
 *
 * `undefined` は「記録しない」を表し `null` になる。JSON 化できない値
 * （循環参照・BigInt）は**例外にせず** `null` にする。監査ログの書き込みが
 * 落ちると、本体の操作まで巻き添えで失敗する。証跡を 1 件失うより、
 * 操作そのものを止めるほうが害が大きい。
 */
export function serializeAuditPayload(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    // 宣言上の戻り値は `string` だが、`JSON.stringify` は関数・symbol に対して
    // 実際には `undefined` を返す。`unknown` で受けて実物を見る。
    const json: unknown = JSON.stringify(maskSensitive(value));
    return typeof json === "string" ? json : null;
  } catch {
    return null;
  }
}
