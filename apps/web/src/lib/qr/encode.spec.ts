/**
 * QR 符号化の検証。
 *
 * task: docs/tasks/P7-02.md
 *
 * ── ここに独立した「読み取り器」を置いている ────────────
 * **誤った QR は「読めない」より悪い**（DECISIONS #184）。読めなければ
 * 利用者は下に印字された URL を手で開くが、符号語を間違えた QR は
 * 誤り訂正が効いて**別の文字列として読めてしまう**ことがある。
 *
 * そこで spec 側に、符号化器の内部を使わない読み取り器を書いてある。
 * 行列だけを受け取り、形式情報からマスクを読み、マスクを外し、
 * ジグザグに走査してビットを拾い、ブロックを解いて文字列へ戻す。
 * **配置・マスク・ブロックの並べ替えのどれを間違えても復元に失敗する。**
 *
 * 加えて、読み取り器と符号化器が同じ誤りを共有しても落ちる検査を置く。
 *   - 空きモジュール数 = 符号語 × 8 + 残余ビット（`VERSIONS` を幾何で検算）
 *   - 各ブロックのシンドロームが 0（RS の定義。並べ替えの誤りも落ちる）
 *   - 形式情報・版情報が規格の既知値と一致する
 *   - 位置検出・タイミング・常時暗モジュールが規定の位置にある
 */

import { describe, expect, it } from "vitest";

import { polyEval } from "./gf.js";
import {
  MASK_FUNCTIONS,
  VERSIONS,
  buildDataCodewords,
  buildFunctionGrid,
  chooseVersion,
  dataCodewordCount,
  encodeQr,
  expectedFreeModules,
  formatInfoBits,
  freeModuleCount,
  internals,
  moduleCount,
  qrPath,
  versionInfoBits,
  type QrCode,
} from "./encode.js";

/** 版から構成を引く（読み取り器が使う）。 */
function specOf(version: number) {
  const found = VERSIONS.find((candidate) => candidate.version === version);
  if (found === undefined) throw new Error(`no spec for version ${String(version)}`);
  return found;
}

/**
 * 形式情報を読んでマスク番号を返す。
 *
 * **左上まわりの写しだけを読む。** 2 つ目の写しは別の検査で突き合わせる。
 */
function readMask(code: QrCode): number {
  let value = 0;
  for (let i = 0; i < 15; i++) {
    let row: number;
    let col: number;
    if (i < 6) {
      row = 8;
      col = i;
    } else if (i === 6) {
      row = 8;
      col = 7;
    } else if (i === 7) {
      row = 8;
      col = 8;
    } else if (i === 8) {
      row = 7;
      col = 8;
    } else {
      row = 14 - i;
      col = 8;
    }
    if (code.modules[row]?.[col] === true) value |= 1 << i;
  }
  const data = (value ^ 0x5412) >>> 10;
  // 誤り訂正レベルは M（0b00）で固定している。
  expect(data >>> 3).toBe(0b00);
  return data & 0b111;
}

/** 行列をジグザグに走査して符号語列へ戻す。 */
function readCodewords(code: QrCode, mask: number): number[] {
  const maskFn = MASK_FUNCTIONS[mask];
  if (maskFn === undefined) throw new Error("bad mask");
  const grid = buildFunctionGrid(code.version);

  const bits: number[] = [];
  let upward = true;
  for (let right = code.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < code.size; vertical++) {
      const row = upward ? code.size - 1 - vertical : vertical;
      for (let offset = 0; offset < 2; offset++) {
        const col = right - offset;
        if (internals.isReserved(grid, row, col)) continue;
        const dark = code.modules[row]?.[col] === true;
        bits.push(dark !== maskFn(row, col) ? 1 : 0);
      }
    }
    upward = !upward;
  }

  const total = specOf(code.version).totalCodewords;
  const out: number[] = [];
  for (let i = 0; i < total; i++) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i * 8 + j] ?? 0);
    out.push(byte);
  }
  return out;
}

/** 並べ替えを解いて、ブロックごとの [データ, 誤り訂正] へ戻す。 */
function deinterleave(codewords: readonly number[], version: number) {
  const spec = specOf(version);
  const sizes: number[] = [];
  for (let i = 0; i < spec.group1Blocks; i++) sizes.push(spec.group1Data);
  for (let i = 0; i < spec.group2Blocks; i++) sizes.push(spec.group2Data);

  const data: number[][] = sizes.map(() => []);
  const maxData = Math.max(...sizes);
  let cursor = 0;
  for (let i = 0; i < maxData; i++) {
    for (let b = 0; b < sizes.length; b++) {
      if (i >= (sizes[b] ?? 0)) continue;
      data[b]?.push(codewords[cursor] ?? 0);
      cursor++;
    }
  }

  const ec: number[][] = sizes.map(() => []);
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (let b = 0; b < sizes.length; b++) {
      ec[b]?.push(codewords[cursor] ?? 0);
      cursor++;
    }
  }

  return sizes.map((_, b) => ({ data: data[b] ?? [], ec: ec[b] ?? [] }));
}

/** データ符号語列から本文を取り出す（バイトモードのみ）。 */
function readPayload(dataCodewords: readonly number[], version: number): string {
  const bits: number[] = [];
  for (const byte of dataCodewords) {
    for (let i = 7; i >= 0; i--) bits.push((byte >>> i) & 1);
  }
  let cursor = 0;
  const take = (length: number): number => {
    let value = 0;
    for (let i = 0; i < length; i++) value = (value << 1) | (bits[cursor + i] ?? 0);
    cursor += length;
    return value;
  };

  expect(take(4)).toBe(0b0100); // バイトモード
  const length = take(version <= 9 ? 8 : 16);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = take(8);
  return new TextDecoder().decode(bytes);
}

/** 行列だけから元の文字列を復元する。**符号化器の途中結果を使わない。** */
function decode(code: QrCode): string {
  const mask = readMask(code);
  const blocks = deinterleave(readCodewords(code, mask), code.version);
  const spec = specOf(code.version);

  // **各ブロックのシンドロームが 0。** 並べ替えを解き違えるとここで落ちる。
  for (const block of blocks) {
    const full = [...block.data, ...block.ec];
    for (let i = 0; i < spec.ecPerBlock; i++) expect(polyEval(full, i)).toBe(0);
  }

  return readPayload(blocks.flatMap((block) => block.data), code.version);
}

const ALL_VERSIONS = VERSIONS.map((spec) => spec.version);

describe("版の表", () => {
  it.each(ALL_VERSIONS)("版 %i でデータ + 誤り訂正 = 総符号語数", (version) => {
    const spec = specOf(version);
    const blocks = spec.group1Blocks + spec.group2Blocks;
    expect(dataCodewordCount(version) + blocks * spec.ecPerBlock).toBe(spec.totalCodewords);
  });

  /**
   * **幾何の側からの検算。** 機能パターンを置いたあとの空きモジュール数は
   * 符号語 × 8 + 残余ビットに一致しなければならない。表を写し間違えると、
   * 上の内部整合は通ってもここで落ちる。
   */
  it.each(ALL_VERSIONS)("版 %i で空きモジュール数が符号語数と一致する", (version) => {
    expect(freeModuleCount(version)).toBe(expectedFreeModules(version));
  });

  it.each(ALL_VERSIONS)("版 %i の一辺が 4v + 17", (version) => {
    expect(moduleCount(version)).toBe(version * 4 + 17);
  });
});

describe("形式情報", () => {
  // レベル M・マスク 0 はデータ 5 ビットが 0 なので BCH も 0 になり、
  // 値は XOR 定数そのもの。**規格の表の既知値。**
  it("レベル M・マスク 0 が 0x5412", () => {
    expect(formatInfoBits(0)).toBe(0x5412);
  });

  it("ISO/IEC 18004 表 C.1（レベル M）と一致する", () => {
    const expected = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0];
    expect(MASK_FUNCTIONS.map((_, mask) => formatInfoBits(mask))).toEqual(expected);
  });

  it("どの 2 つもハミング距離が 7 以上（1 ビット誤りで別のマスクに化けない）", () => {
    for (let a = 0; a < 8; a++) {
      for (let b = a + 1; b < 8; b++) {
        let distance = 0;
        const xor = formatInfoBits(a) ^ formatInfoBits(b);
        for (let i = 0; i < 15; i++) if (((xor >>> i) & 1) === 1) distance++;
        expect(distance).toBeGreaterThanOrEqual(7);
      }
    }
  });
});

describe("版情報", () => {
  it("ISO/IEC 18004 表 D.1 の既知値と一致する（版 7〜10）", () => {
    expect(versionInfoBits(7)).toBe(0x07c94);
    expect(versionInfoBits(8)).toBe(0x085bc);
    expect(versionInfoBits(9)).toBe(0x09a99);
    expect(versionInfoBits(10)).toBe(0x0a4d3);
  });
});

describe("機能パターンの配置", () => {
  it.each(ALL_VERSIONS)("版 %i の 3 隅に位置検出パターンがある", (version) => {
    const code = encodeQr("https://pk.stek.ai/m/login");
    const grid = buildFunctionGrid(version);
    const size = moduleCount(version);
    for (const [top, left] of [
      [0, 0],
      [0, size - 7],
      [size - 7, 0],
    ] as const) {
      // 外周は暗、その内側の環は明、中心 3×3 は暗。
      expect(internals.isDark(grid, top, left)).toBe(true);
      expect(internals.isDark(grid, top + 1, left + 1)).toBe(false);
      expect(internals.isDark(grid, top + 3, left + 3)).toBe(true);
    }
    expect(code.size).toBeGreaterThan(0);
  });

  it.each(ALL_VERSIONS)("版 %i のタイミングパターンが交互になる", (version) => {
    const grid = buildFunctionGrid(version);
    const size = moduleCount(version);
    for (let i = 8; i < size - 8; i++) {
      expect(internals.isDark(grid, 6, i)).toBe(i % 2 === 0);
      expect(internals.isDark(grid, i, 6)).toBe(i % 2 === 0);
    }
  });

  it.each(ALL_VERSIONS)("版 %i の常時暗モジュールが (4v+9, 8) にある", (version) => {
    const grid = buildFunctionGrid(version);
    expect(internals.isDark(grid, version * 4 + 9, 8)).toBe(true);
  });

  /**
   * **ジグザグ走査が空きモジュールを 1 つずつちょうど 1 回ずつ通る。**
   *
   * 実際にここを踏み外した。6 列目を避けるとき列そのものをずらさずに
   * 一時変数で逃がすと、以降の列の対が 1 つずれて **4 列目を 2 回通り、
   * 0 列目を 1 回も通らない。** 訪問の総数は変わらないので
   * `freeModuleCount()` の検算では気づけない。
   */
  it.each(ALL_VERSIONS)("版 %i の走査が空きモジュールを漏れなく 1 度ずつ通る", (version) => {
    const grid = buildFunctionGrid(version);
    const size = moduleCount(version);
    const visits = new Map<string, number>();

    let upward = true;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < size; vertical++) {
        const row = upward ? size - 1 - vertical : vertical;
        for (let offset = 0; offset < 2; offset++) {
          const col = right - offset;
          if (internals.isReserved(grid, row, col)) continue;
          const key = `${String(row)},${String(col)}`;
          visits.set(key, (visits.get(key) ?? 0) + 1);
        }
      }
      upward = !upward;
    }

    expect(visits.size).toBe(freeModuleCount(version));
    expect([...visits.values()].every((count) => count === 1)).toBe(true);
  });
});

describe("符号語の組み立て", () => {
  it("モード指示子・文字数・終端・埋め草が規定どおり", () => {
    // "AB" → 0100 00000010 01000001 01000010 0000（終端）→ 埋め草
    // 4 + 8 + 16 + 4 = 32 ビット。**ちょうど 4 符号語で終端まで収まる。**
    const codewords = buildDataCodewords(new TextEncoder().encode("AB"), 1);
    expect(codewords.slice(0, 4)).toEqual([0x40, 0x24, 0x14, 0x20]);
    // 残りは 0xEC / 0x11 の交互。**0 で埋めない。**
    expect(codewords.slice(4)).toEqual([
      0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11,
    ]);
    expect(codewords).toHaveLength(dataCodewordCount(1));
  });

  it("版はデータが収まる最小のものが選ばれる", () => {
    expect(chooseVersion(1)).toBe(1);
    expect(chooseVersion(14)).toBe(1);
    expect(chooseVersion(15)).toBe(2);
    expect(chooseVersion(213)).toBe(10);
  });

  it("版 10 に収まらない長さは拒む", () => {
    expect(() => chooseVersion(214)).toThrow("QR_PAYLOAD_TOO_LONG");
    expect(() => encodeQr("x".repeat(300))).toThrow("QR_PAYLOAD_TOO_LONG");
  });
});

describe("復元（独立した読み取り器）", () => {
  const CASES = [
    "https://pk.stek.ai/m/login",
    "https://pk.stek.ai/m/login?org=o7k2m9",
    "https://proofkeeping.example.co.jp/m/login?org=abc123",
    "A",
    "0123456789",
    // UTF-8 の多バイト。**バイト数と文字数を取り違えていないか。**
    "日本語のログイン案内",
  ];

  it.each(CASES)("%s を復元できる", (text) => {
    expect(decode(encodeQr(text))).toBe(text);
  });

  /**
   * **すべての版を通す。** 版 8〜10 は 2 群構成（データ符号語数が異なる
   * ブロックが混ざる）で、並べ替えを取り違えやすい。
   */
  it.each(ALL_VERSIONS)("版 %i の満杯に近い入力を復元できる", (version) => {
    const capacity = dataCodewordCount(version) - 1 - (version <= 9 ? 1 : 2);
    const text = "u".repeat(capacity);
    const code = encodeQr(text);
    expect(code.version).toBe(version);
    expect(decode(code)).toBe(text);
  });
});

describe("SVG パス", () => {
  it("暗モジュールの数だけサブパスが出る", () => {
    const code = encodeQr("https://pk.stek.ai/m/login");
    const dark = code.modules.flat().filter((value) => value).length;
    expect(qrPath(code).match(/M/g) ?? []).toHaveLength(dark);
  });

  it("外部リソースを参照しない（数値と経路命令だけ）", () => {
    expect(qrPath(encodeQr("https://pk.stek.ai/m/login"))).toMatch(/^[Mhvz0-9 -]*$/);
  });
});
