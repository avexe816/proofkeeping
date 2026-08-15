/**
 * GF(256) と Reed-Solomon の検証。
 *
 * task: docs/tasks/P7-02.md
 *
 * **誤った QR は「読めない」より悪い**（DECISIONS #184）。読めなければ
 * 利用者は下の URL を手で開くが、符号語を間違えた QR は誤り訂正が効いて
 * **別の文字列として読めてしまう**ことがある。
 *
 * ここは「表を写し間違えても落ちる」検査を優先している。
 *   - 生成多項式の根（定義そのもの。実装の内部を見ない）
 *   - 符号語全体のシンドローム（RS の定義そのもの）
 *   - ISO/IEC 18004 の例題との一致（外部の正解との突き合わせ）
 */

import { describe, expect, it } from "vitest";

import { generatorPoly, gfExp, gfLog, gfMul, polyEval, reedSolomonEncode } from "./gf.js";

describe("GF(256)", () => {
  it("指数と対数が往復する", () => {
    for (let i = 0; i < 255; i++) {
      expect(gfLog(gfExp(i))).toBe(i);
    }
  });

  it("α^255 が 1 に戻る（位数 255）", () => {
    expect(gfExp(255)).toBe(1);
    expect(gfExp(0)).toBe(1);
  });

  it("1 が乗法の単位元", () => {
    for (let a = 0; a < 256; a++) expect(gfMul(a, 1)).toBe(a);
  });

  it("0 を掛けると 0（LOG[0] の未定義値に落ちない）", () => {
    for (let a = 0; a < 256; a++) {
      expect(gfMul(a, 0)).toBe(0);
      expect(gfMul(0, a)).toBe(0);
    }
  });

  it("乗法が可換で、0 以外に逆元がある", () => {
    for (let a = 1; a < 256; a++) {
      const inverse = gfExp((255 - gfLog(a)) % 255);
      expect(gfMul(a, inverse)).toBe(1);
      expect(gfMul(a, 7)).toBe(gfMul(7, a));
    }
  });
});

describe("生成多項式", () => {
  // QR が実際に使う次数（誤り訂正レベル M・版 1〜10）。
  const DEGREES = [10, 16, 18, 22, 24, 26];

  it.each(DEGREES)("次数 %i の係数が degree + 1 個で、最高次が 1", (degree) => {
    const g = generatorPoly(degree);
    expect(g).toHaveLength(degree + 1);
    expect(g[0]).toBe(1);
  });

  // **これが定義そのもの。** 生成多項式は α^0 … α^(n-1) を根に持つ。
  // 表を写すのではなく計算しているので、ここが通れば係数は正しい。
  it.each(DEGREES)("次数 %i の根が α^0 … α^(n-1)", (degree) => {
    const g = generatorPoly(degree);
    for (let i = 0; i < degree; i++) {
      expect(polyEval(g, i)).toBe(0);
    }
  });

  it("根でない点では 0 にならない", () => {
    const g = generatorPoly(10);
    expect(polyEval(g, 10)).not.toBe(0);
  });
});

describe("Reed-Solomon", () => {
  it("誤り訂正符号語の個数が ecLength と一致する", () => {
    const data = Array.from({ length: 16 }, (_, i) => i);
    for (const ecLength of [10, 16, 18, 22, 24, 26]) {
      expect(reedSolomonEncode(data, ecLength)).toHaveLength(ecLength);
    }
  });

  /**
   * **RS 符号の定義そのもの。**
   * データと誤り訂正符号語をつないだ多項式は、生成多項式の根すべてで 0 になる。
   * 実装の内部（剰余の取り方・窓の送り方）を一切見ずに成り立つ性質。
   */
  it.each([10, 16, 18, 22, 24, 26])("ecLength %i でシンドロームが 0", (ecLength) => {
    const data = Array.from({ length: 30 }, (_, i) => (i * 37 + 11) % 256);
    const codeword = [...data, ...reedSolomonEncode(data, ecLength)];
    for (let i = 0; i < ecLength; i++) {
      expect(polyEval(codeword, i)).toBe(0);
    }
  });

  it("データを 1 バイト変えるとシンドロームが 0 でなくなる", () => {
    const data = Array.from({ length: 16 }, (_, i) => i);
    const codeword = [...data, ...reedSolomonEncode(data, 10)];
    const broken = [...codeword];
    broken[3] = (broken[3] ?? 0) ^ 0x5a;
    const syndromes = Array.from({ length: 10 }, (_, i) => polyEval(broken, i));
    expect(syndromes.some((value) => value !== 0)).toBe(true);
  });

  /**
   * ISO/IEC 18004 の例題（版 1・誤り訂正レベル M・数字モード "01234567"）。
   *
   * **外部の正解との突き合わせ。** 上の 2 件は自分の実装の内部だけで
   * 閉じているので、規格の側と一致することを別に確かめる。
   * 数字モードは実装していないが、**データ符号語を直に与えれば
   * 誤り訂正の段は同じものが通る。**
   */
  it("ISO/IEC 18004 の例題（版 1-M）と一致する", () => {
    const data = [
      0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec,
      0x11,
    ];
    expect(reedSolomonEncode(data, 10)).toEqual([
      0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55,
    ]);
  });
});
