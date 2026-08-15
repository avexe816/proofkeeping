/**
 * GF(256) の算術と Reed-Solomon 誤り訂正符号の生成。
 *
 * task:  docs/tasks/P7-02.md
 * 仕様:  docs/PK-SPEC-P7.md §2.4 v1.1
 * 決定:  docs/DECISIONS.md #184（QR はブラウザ側で生成する / 依存を足さない）
 *
 * ── なぜ自前で書いているのか ────────────────────────────
 * §2.4 v1.1 は現場掲示用の案内を**印刷用 HTML** で出す。QR の生成を
 * `packages/pdf` へ持ち込むと帳票の生成系に依存が増える（DECISIONS #184）。
 * 載せるのはログイン URL 1 本だけで、必要なのはバイトモード・誤り訂正 M・
 * 版 1〜10 に限った符号化に過ぎない。**汎用ライブラリを入れない。**
 *
 * ── 誤った QR は「読めない」より悪い ────────────────────
 * 読めなければ利用者は下に印字された URL を手で開く。だが**符号語を
 * 1 バイト間違えた QR は、誤り訂正が効いて「別の文字列として読める」
 * ことがある。** 現場の端末が知らない場所へ飛ぶ。
 * そのため `gf.spec.ts` は次の 3 つを機械的に押さえている。
 *
 *   1. 生成多項式の根が α^0 … α^(n-1) であること（定義そのもの）
 *   2. 符号語全体のシンドロームが 0 であること（RS の定義そのもの）
 *   3. ISO/IEC 18004 の例題（版 1-M）の誤り訂正符号語と一致すること
 *
 * 1 と 2 は実装の内部を見ずに成り立つ性質で、表を写し間違えても落ちる。
 *
 * ── この表現の約束 ──────────────────────────────────────
 * 多項式は**係数の配列**で持ち、添字 0 が最高次。QR の符号語列と
 * 同じ並びなので、途中で反転させる必要が無い。
 */

/** 原始多項式 x^8 + x^4 + x^3 + x^2 + 1。QR が定める値（ISO/IEC 18004）。 */
const PRIMITIVE = 0x11d;

/**
 * α^i の表。**255 で 1 周する**ので、掛け算で添字が 254 を超えても
 * 折り返さずに引けるよう 512 個持つ。
 */
const EXP = new Uint8Array(512);

/** log_α の表。`LOG[0]` は定義されない（使う前に 0 を弾く）。 */
const LOG = new Uint8Array(256);

function buildTables(): void {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if ((x & 0x100) !== 0) x ^= PRIMITIVE;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] ?? 0;
}

buildTables();

/** α^i。i は 0 以上 511 以下。 */
export function gfExp(i: number): number {
  return EXP[i] ?? 0;
}

/** log_α(x)。**x が 0 のとき呼ばないこと。** */
export function gfLog(x: number): number {
  return LOG[x] ?? 0;
}

/**
 * GF(256) の乗算。
 *
 * **0 を先に落とす。** `LOG[0]` は定義が無く、表の初期値（0）を使うと
 * α^0 = 1 と混ざって静かに誤る。
 */
export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[gfLog(a) + gfLog(b)] ?? 0;
}

/**
 * 多項式に定数 α^k を掛ける（係数ごとの乗算）。
 */
function scale(poly: readonly number[], k: number): number[] {
  return poly.map((c) => gfMul(c, k));
}

/**
 * 多項式の乗算。添字 0 が最高次。
 */
export function polyMul(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    if (ai === 0) continue;
    for (let j = 0; j < b.length; j++) {
      out[i + j] = (out[i + j] ?? 0) ^ gfMul(ai, b[j] ?? 0);
    }
  }
  return out;
}

/**
 * 多項式を x = α^k で評価する（ホーナー法）。
 *
 * シンドロームの計算に使う。**検証側が使う関数でもある。**
 */
export function polyEval(poly: readonly number[], k: number): number {
  let acc = 0;
  const at = gfExp(k);
  for (const coefficient of poly) acc = gfMul(acc, at) ^ coefficient;
  return acc;
}

/**
 * 次数 `degree` の生成多項式を作る。
 *
 * ```
 * g(x) = (x - α^0)(x - α^1) … (x - α^(degree-1))
 * ```
 *
 * GF(2^n) では減算と加算が同じ（XOR）なので符号は現れない。
 * 返る配列の長さは `degree + 1`。
 */
export function generatorPoly(degree: number): number[] {
  let g: number[] = [1];
  for (let i = 0; i < degree; i++) g = polyMul(g, [1, gfExp(i)]);
  return g;
}

/** 生成多項式は版と誤り訂正レベルで決まる。**毎回作り直さない。** */
const GENERATOR_CACHE = new Map<number, readonly number[]>();

function cachedGenerator(degree: number): readonly number[] {
  const hit = GENERATOR_CACHE.get(degree);
  if (hit !== undefined) return hit;
  const made = generatorPoly(degree);
  GENERATOR_CACHE.set(degree, made);
  return made;
}

/**
 * データ符号語列から誤り訂正符号語を作る。
 *
 * データ多項式を x^ecLength 倍して生成多項式で割り、**剰余**を返す。
 * 返る長さは必ず `ecLength`。
 *
 * 結果の性質: `[...data, ...ec]` を多項式と見たとき、
 * α^0 … α^(ecLength-1) のすべてで 0 になる（`gf.spec.ts` が確かめる）。
 */
export function reedSolomonEncode(data: readonly number[], ecLength: number): number[] {
  const generator = cachedGenerator(ecLength);
  // 剰余を溜める窓。長さは ecLength で固定する。
  const remainder = new Array<number>(ecLength).fill(0);

  for (const byte of data) {
    const factor = byte ^ (remainder[0] ?? 0);
    // 窓を 1 つ送る。**最後に 0 を足す**（x 倍にあたる）。
    remainder.shift();
    remainder.push(0);
    if (factor === 0) continue;
    const term = scale(generator.slice(1), factor);
    for (let i = 0; i < ecLength; i++) {
      remainder[i] = (remainder[i] ?? 0) ^ (term[i] ?? 0);
    }
  }

  return remainder;
}
