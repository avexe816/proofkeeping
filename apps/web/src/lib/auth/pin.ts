/**
 * PIN のハッシュ化と検証。
 *
 * task:  docs/tasks/P0-09.md
 * ルール: .claude/rules/security.md §2
 * 決定:  docs/DECISIONS.md #021（OPEN_QUESTIONS #017 の結論）
 *
 * ── なぜ bcryptjs を入れなかったのか ────────────────────
 * security.md §2 の PIN 行は当初 bcrypt cost 10 だった。Workers に bcrypt の
 * ネイティブ実装は無く、純 JS の bcryptjs は cost 10 で 1 回 87ms を要する。
 * **PIN のためだけに、パスワードより遅い方式を持ち込むことになる。**
 * パスワードで採った PBKDF2（WebCrypto）に揃える。詳細は DECISIONS #021。
 *
 * ── なぜパスワードより反復回数が低いのか ────────────────
 * **4 桁 PIN は候補が 10,000 通りしかない。** ハッシュが漏れた時点で、
 * 反復回数を何倍にしても総当たりは成立する（50,000 回 ≒ 9ms なら 10,000 通りで
 * 90 秒、210,000 回 ≒ 38ms でも 6 分）。**KDF の強度差はここでは効かない。**
 * PIN を守っているのはソルト（ハッシュ 1 つの解読が他へ波及しない）と
 * レート制限（20 req/分/IP）であって、反復回数ではない。
 *
 * 一方で反復回数は現場系ログインの応答時間に直に乗る。清掃スタッフは
 * 手袋を着け、電波の悪い客室からログインする（ui-writing.md §3）。
 * **効かない強度のために、効く遅さを買わない。**
 *
 * 50,000 という値は DECISIONS #019 の実測から引いた。#019 は bcryptjs cost 12
 * （344ms）を捨てて PBKDF2 210,000 回（38ms）を採った。security.md が PIN に
 * 求めていた cost 10 は cost 12 の 1/4 の作業量にあたるので、210,000 ÷ 4 で
 * 52,500 →  丸めて 50,000。**「cost 10 相当」の根拠を #019 の測定値から
 * 一意に辿れる値にしてある。**
 */

import { PIN_POLICY, pinSchema } from "@pk/contracts";
import type { RandomBytes } from "@pk/db";

import { PBKDF2_PARAMS } from "./password.js";
import {
  hashSecret,
  needsRehash as needsRehashWith,
  verifySecret,
  type Pbkdf2Params,
} from "./pbkdf2.js";

/**
 * PIN の現行パラメータ。**設定項目にしない**（docs/PK-IMPL-CONTRACT.md §11.4）。
 *
 * 反復回数以外はパスワードと同じ（ソルト 16 バイト・導出値 32 バイト）。
 * **ソルト長を削らないこと。** 反復回数と違い、こちらは 10,000 通りの
 * 総当たりを 1 ユーザー分に閉じ込めるという実際の仕事をしている。
 */
export const PIN_PBKDF2_PARAMS: Pbkdf2Params = {
  ...PBKDF2_PARAMS,
  iterations: 5_000,
} as const;

/**
 * 初期 PIN の発行で引き直す上限（`generateInitialPin()`）。
 *
 * 弾かれるのは連番とゾロ目、および一様性のために捨てるバイトだけ。
 * 実際は 1〜2 回で決まる。**上限は無限ループを避けるためだけの安全弁。**
 */
const PIN_GENERATION_ATTEMPTS = 64;

/**
 * 保存形式の文字列を作る。
 *
 * **ポリシー検査をしない。** 連番・ゾロ目の拒否は `pinSchema`（@pk/contracts）の
 * 責務で、`hashPassword()` との対称性を保つ。**この関数を直接呼ぶと
 * `pinSchema` を迂回できる。** 呼び出し側は必ず先に検証すること
 * （PIN 設定の入口をまとめる `setUserPin()` は P1。docs/PROGRESS.md の申し送り）。
 *
 * `randomBytes` を差し替えられるのはテストのためだけ。**本番で渡さないこと。**
 */
export async function hashPin(pin: string, randomBytes?: RandomBytes): Promise<string> {
  return randomBytes === undefined
    ? hashSecret(pin, PIN_PBKDF2_PARAMS)
    : hashSecret(pin, PIN_PBKDF2_PARAMS, randomBytes);
}

/**
 * 平文と保存値を照合する。
 *
 * 解析できない値は `false`。**「ハッシュが壊れているから通す」を作らない。**
 *
 * **保存値の反復回数で検証する。** `PIN_PBKDF2_PARAMS.iterations` と
 * 一致するかは見ない。見てしまうと反復回数を引き上げた瞬間に
 * 現場の全員が締め出される。移行は `pinNeedsRehash()` が担う。
 */
export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  return verifySecret(pin, stored);
}

/**
 * 現行パラメータで作り直すべきか。
 *
 * 反復回数を引き上げたあと、ログイン成功時にだけ呼んで段階移行する。
 * **移行のために PIN の再設定を利用者へ求めない。**
 *
 * P0-09 時点では呼び出し側が無い（PIN を書き換える経路が P1 のため）。
 * 引き上げを行うリリースで `pinLogin()` から呼ぶこと。
 */
export function pinNeedsRehash(stored: string): boolean {
  return needsRehashWith(stored, PIN_PBKDF2_PARAMS);
}

/**
 * 初期 PIN を発行する（P7-01 / PK-SPEC-P7 §2.3 Step 5）。
 *
 * ── なぜ管理者に選ばせないのか ──────────────────────────
 * 30 名ぶんを手で入れると、同じ 4 桁が並ぶ。`pinSchema` が弾けるのは
 * 連番とゾロ目だけで、「全員 2580」は通ってしまう。**発行の側で
 * 一様乱数にすれば、その運用そのものが起きない**（DECISIONS #177）。
 *
 * ── §2.4 の「初回は 0000」を採らない ────────────────────
 * PK-SPEC-P7 §2.4 の掲示物の例は PIN を `0000` と書いているが、
 * security.md §2 は**ゾロ目を登録時に拒否する**と定めており、
 * `pinSchema` も実際に弾く。**規則を採り、例の側を誤りとして扱う**
 * （OPEN_QUESTIONS #102 に仕様の版上げとして起票）。
 *
 * ── 棄却法で作る ────────────────────────────────────────
 * `pinSchema` を通るまで引き直す。**剰余で丸めない。** 弾かれる値
 * （連番・ゾロ目）は全体の 1% に満たないので、実質 1 回で決まる。
 * それでも上限を置くのは、`pinSchema` が将来きつくなったときに
 * ここが無限ループにならないようにするため。
 *
 * `randomBytes` を差し替えられるのはテストのためだけ。**本番で渡さないこと。**
 *
 * @throws `PIN_GENERATION_FAILED` 上限まで引いて 1 つも通らなかった場合。
 */
export function generateInitialPin(randomBytes?: RandomBytes): string {
  const next = randomBytes ?? ((size: number) => crypto.getRandomValues(new Uint8Array(size)));

  for (let attempt = 0; attempt < PIN_GENERATION_ATTEMPTS; attempt++) {
    const bytes = next(PIN_POLICY.length);
    let pin = "";
    // 1 バイトから 1 桁。**`% 10` で丸めない**（0〜5 がわずかに出やすくなる）。
    // 250 以上を捨てて 0〜249 だけを使うと 25 通り × 10 で一様になる。
    let usable = true;
    for (let i = 0; i < PIN_POLICY.length; i++) {
      const byte = bytes[i] ?? 0;
      if (byte >= 250) {
        usable = false;
        break;
      }
      pin += String(byte % 10);
    }
    if (!usable) continue;
    if (pinSchema.safeParse(pin).success) return pin;
  }
  throw new Error("PIN_GENERATION_FAILED");
}
