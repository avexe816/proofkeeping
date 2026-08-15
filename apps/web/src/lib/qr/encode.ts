/**
 * QR コードの符号化（バイトモード・誤り訂正 M・版 1〜10）。
 *
 * task:  docs/tasks/P7-02.md
 * 仕様:  docs/PK-SPEC-P7.md §2.4 v1.1
 * 決定:  docs/DECISIONS.md #184
 *
 * ── 何を載せるか ────────────────────────────────────────
 * 載せるのは**ログイン URL 1 本だけ。** PIN も組織 ID も QR に入れない
 * （§2.4 の掲示物は QR の下に文字で印字する形）。したがって
 * 数字モード・漢字モードは要らず、バイトモード（UTF-8）1 つで足りる。
 *
 * ── なぜ版 1〜10 に限るのか ──────────────────────────────
 * 版 10-M のバイトモード容量は 213 バイト。`https://…/m/login?org=……` は
 * どう伸びても 100 バイトに届かない。**版 11 以降を実装しても使われず、
 * 検証されないコードが残るだけ。** 足りなくなったら `VERSIONS` に行を
 * 足す（併せて版情報の BCH と整列パターンの中心を確かめること）。
 *
 * ── 誤り訂正レベルを M に固定する理由 ────────────────────
 * 現場に貼る紙は汚れる・折れる・斜めから読まれる。L（7%）は復元の余地が
 * 小さい。Q / H は同じ内容でも版が上がり、**同じ紙面でセルが細かくなって
 * 却って読めなくなる。** M（15%）は QR の既定でもある。
 *
 * ── 検証 ────────────────────────────────────────────────
 * `encode.spec.ts` が符号語列と行列の両方を押さえている。とくに
 * **spec 側に独立した読み取り器を置き、符号化した行列から元の文字列を
 * 復元できることを確かめている。** 配置・マスク・ブロック分割の
 * どれを間違えても復元に失敗する。
 */

import { reedSolomonEncode } from "./gf.js";

/** 誤り訂正レベル M のビット表現（ISO/IEC 18004 表 12）。 */
const EC_LEVEL_M_BITS = 0b00;

/** バイトモードのモード指示子。 */
const MODE_BYTE = 0b0100;

/** 埋め草。**この 2 バイトを交互に置く**（ISO/IEC 18004 8.4.9）。 */
const PAD_BYTES = [0xec, 0x11] as const;

/**
 * 版ごとの構成（誤り訂正レベル M）。
 *
 * `totalCodewords` は版が持つ符号語の総数、`ecPerBlock` は 1 ブロックあたりの
 * 誤り訂正符号語数。ブロックは 2 群に分かれることがあり、第 2 群は
 * 第 1 群より**データ符号語が 1 つ多い**（QR の規定）。
 *
 * **表の写し間違いは spec が 2 方向から落とす。**
 *   - データ符号語 + 誤り訂正符号語 = `totalCodewords`（表の内部整合）
 *   - `totalCodewords` = 行列の空きモジュール数から求めた値（幾何との照合）
 * 片方だけでは通ってしまう誤りがあるため、両方を持っている。
 */
interface VersionSpec {
  readonly version: number;
  readonly totalCodewords: number;
  readonly ecPerBlock: number;
  readonly group1Blocks: number;
  readonly group1Data: number;
  readonly group2Blocks: number;
  readonly group2Data: number;
}

export const VERSIONS: readonly VersionSpec[] = [
  { version: 1, totalCodewords: 26, ecPerBlock: 10, group1Blocks: 1, group1Data: 16, group2Blocks: 0, group2Data: 0 },
  { version: 2, totalCodewords: 44, ecPerBlock: 16, group1Blocks: 1, group1Data: 28, group2Blocks: 0, group2Data: 0 },
  { version: 3, totalCodewords: 70, ecPerBlock: 26, group1Blocks: 1, group1Data: 44, group2Blocks: 0, group2Data: 0 },
  { version: 4, totalCodewords: 100, ecPerBlock: 18, group1Blocks: 2, group1Data: 32, group2Blocks: 0, group2Data: 0 },
  { version: 5, totalCodewords: 134, ecPerBlock: 24, group1Blocks: 2, group1Data: 43, group2Blocks: 0, group2Data: 0 },
  { version: 6, totalCodewords: 172, ecPerBlock: 16, group1Blocks: 4, group1Data: 27, group2Blocks: 0, group2Data: 0 },
  { version: 7, totalCodewords: 196, ecPerBlock: 18, group1Blocks: 4, group1Data: 31, group2Blocks: 0, group2Data: 0 },
  { version: 8, totalCodewords: 242, ecPerBlock: 22, group1Blocks: 2, group1Data: 38, group2Blocks: 2, group2Data: 39 },
  { version: 9, totalCodewords: 292, ecPerBlock: 22, group1Blocks: 3, group1Data: 36, group2Blocks: 2, group2Data: 37 },
  { version: 10, totalCodewords: 346, ecPerBlock: 26, group1Blocks: 4, group1Data: 43, group2Blocks: 1, group2Data: 44 },
] as const;

/**
 * 整列パターンの中心座標（版 2〜10）。版 1 は持たない。
 *
 * 中心の総当たりのうち、**位置検出パターンと重なる 3 隅は置かない。**
 */
const ALIGNMENT_CENTERS: readonly (readonly number[])[] = [
  [], // 版 1
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
] as const;

/**
 * 残余ビット。符号語に入りきらず、**0 で埋めるだけ**のモジュール数。
 *
 * 版 1 は 0、版 2〜6 は 7、版 7〜13 は 0（ISO/IEC 18004 表 1）。
 */
function remainderBits(version: number): number {
  return version >= 2 && version <= 6 ? 7 : 0;
}

/** 版から一辺のモジュール数を求める。 */
export function moduleCount(version: number): number {
  return version * 4 + 17;
}

function specOf(version: number): VersionSpec {
  const found = VERSIONS.find((candidate) => candidate.version === version);
  if (found === undefined) throw new Error(`QR_VERSION_UNSUPPORTED:${String(version)}`);
  return found;
}

/** 版が持つデータ符号語の総数。 */
export function dataCodewordCount(version: number): number {
  const spec = specOf(version);
  return spec.group1Blocks * spec.group1Data + spec.group2Blocks * spec.group2Data;
}

/**
 * 文字数指示子のビット幅（バイトモード）。
 *
 * 版 1〜9 は 8 ビット、版 10 以降は 16 ビット。**版 10 で幅が変わる。**
 * ここを 8 のままにすると版 10 だけが静かに壊れる。
 */
function characterCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

/**
 * 収まる最小の版を選ぶ。
 *
 * @throws `QR_PAYLOAD_TOO_LONG` 版 10 でも収まらない場合。
 */
export function chooseVersion(byteLength: number): number {
  for (const spec of VERSIONS) {
    const capacity =
      dataCodewordCount(spec.version) - 1 - Math.ceil(characterCountBits(spec.version) / 8);
    if (byteLength <= capacity) return spec.version;
  }
  throw new Error("QR_PAYLOAD_TOO_LONG");
}

/** ビットを 1 つずつ積む器。**符号語の境界を意識せずに書ける。** */
class BitBuffer {
  private readonly bits: number[] = [];

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }

  get length(): number {
    return this.bits.length;
  }

  /** 8 ビット単位の符号語列にする。**端数は 0 で埋める。** */
  toCodewords(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | (this.bits[i + j] ?? 0);
      out.push(byte);
    }
    return out;
  }
}

/**
 * データ符号語列を組み立てる（モード指示子・文字数・本体・終端・埋め草）。
 */
export function buildDataCodewords(bytes: Uint8Array, version: number): number[] {
  const capacity = dataCodewordCount(version);
  const buffer = new BitBuffer();

  buffer.push(MODE_BYTE, 4);
  buffer.push(bytes.length, characterCountBits(version));
  for (const byte of bytes) buffer.push(byte, 8);

  // 終端子は 4 ビット。**残りが 4 ビット未満なら詰められるだけ。**
  const capacityBits = capacity * 8;
  buffer.push(0, Math.min(4, capacityBits - buffer.length));

  const codewords = buffer.toCodewords();
  // 埋め草は 0xEC / 0x11 の交互。**0 で埋めない**（規格が定める値）。
  for (let i = 0; codewords.length < capacity; i++) {
    codewords.push(PAD_BYTES[i % 2] ?? 0);
  }
  return codewords;
}

/**
 * ブロックへ分け、誤り訂正符号語を作り、**交互に並べ替える。**
 *
 * 並べ替え（インターリーブ）は QR の要。汚れが 1 か所に集中しても、
 * 各ブロックへ均等に散るので誤り訂正の範囲に収まる。
 * **ここを飛ばすと、読み取り器によっては通ってしまうことがある**
 * （1 ブロックしか無い版 1〜3 では並べ替えが恒等写像になるため）。
 * spec は版 8〜10（2 群構成）でも復元できることを確かめている。
 */
export function interleave(dataCodewords: readonly number[], version: number): number[] {
  const spec = specOf(version);

  const blocks: number[][] = [];
  let offset = 0;
  for (let i = 0; i < spec.group1Blocks; i++) {
    blocks.push(dataCodewords.slice(offset, offset + spec.group1Data));
    offset += spec.group1Data;
  }
  for (let i = 0; i < spec.group2Blocks; i++) {
    blocks.push(dataCodewords.slice(offset, offset + spec.group2Data));
    offset += spec.group2Data;
  }

  const ecBlocks = blocks.map((block) => reedSolomonEncode(block, spec.ecPerBlock));

  const out: number[] = [];
  const maxData = Math.max(...blocks.map((block) => block.length));
  for (let i = 0; i < maxData; i++) {
    for (const block of blocks) {
      const value = block[i];
      if (value !== undefined) out.push(value);
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const block of ecBlocks) out.push(block[i] ?? 0);
  }
  return out;
}

/**
 * 行列。`modules` は暗（true）／明（false）、`reserved` は機能パターンの印。
 *
 * **flat な配列で持つ。** `noUncheckedIndexedAccess` の下で 2 次元配列を
 * 引き回すと `?? 0` が読みづらいほど増える。
 */
interface Grid {
  readonly size: number;
  readonly modules: Uint8Array;
  readonly reserved: Uint8Array;
}

function createGrid(size: number): Grid {
  return { size, modules: new Uint8Array(size * size), reserved: new Uint8Array(size * size) };
}

function setModule(grid: Grid, row: number, col: number, dark: boolean, reserve: boolean): void {
  const index = row * grid.size + col;
  grid.modules[index] = dark ? 1 : 0;
  if (reserve) grid.reserved[index] = 1;
}

function isReserved(grid: Grid, row: number, col: number): boolean {
  return grid.reserved[row * grid.size + col] === 1;
}

function isDark(grid: Grid, row: number, col: number): boolean {
  return grid.modules[row * grid.size + col] === 1;
}

/** 位置検出パターン（7×7）と分離パターン（周囲 1 モジュール）。 */
function placeFinder(grid: Grid, top: number, left: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const row = top + r;
      const col = left + c;
      if (row < 0 || row >= grid.size || col < 0 || col >= grid.size) continue;
      const onBorder = r === 0 || r === 6 || c === 0 || c === 6;
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      setModule(grid, row, col, inside && (onBorder || inCore), true);
    }
  }
}

/** 整列パターン（5×5）。位置検出パターンと重なる中心は置かない。 */
function placeAlignment(grid: Grid, version: number): void {
  const centers = ALIGNMENT_CENTERS[version - 1] ?? [];
  const last = grid.size - 8;
  for (const centerRow of centers) {
    for (const centerCol of centers) {
      const nearFinder =
        (centerRow === 6 && centerCol === 6) ||
        (centerRow === 6 && centerCol >= last) ||
        (centerRow >= last && centerCol === 6);
      if (nearFinder) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const ring = Math.max(Math.abs(r), Math.abs(c));
          setModule(grid, centerRow + r, centerCol + c, ring !== 1, true);
        }
      }
    }
  }
}

/** タイミングパターン（6 行目・6 列目）。 */
function placeTiming(grid: Grid): void {
  for (let i = 8; i < grid.size - 8; i++) {
    const dark = i % 2 === 0;
    setModule(grid, 6, i, dark, true);
    setModule(grid, i, 6, dark, true);
  }
}

/**
 * 形式情報が入る領域を予約する。値は後で入れる（マスクが決まらないと
 * 定まらないため）。**併せて常時暗のモジュールを置く。**
 */
function reserveFormatAreas(grid: Grid): void {
  for (let i = 0; i < 9; i++) {
    if (!isReserved(grid, 8, i)) setModule(grid, 8, i, false, true);
    if (!isReserved(grid, i, 8)) setModule(grid, i, 8, false, true);
  }
  for (let i = 0; i < 8; i++) {
    setModule(grid, 8, grid.size - 1 - i, false, true);
    setModule(grid, grid.size - 1 - i, 8, false, true);
  }
  // 常時暗のモジュール（ISO/IEC 18004 8.9）。位置は (4v+9, 8)。
  setModule(grid, grid.size - 8, 8, true, true);
}

/** 版情報が入る領域（版 7 以降）。 */
function placeVersionInfo(grid: Grid, version: number): void {
  if (version < 7) return;
  const bits = versionInfoBits(version);
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    const a = Math.floor(i / 3);
    const b = (i % 3) + grid.size - 11;
    setModule(grid, b, a, dark, true);
    setModule(grid, a, b, dark, true);
  }
}

/**
 * 版情報の 18 ビット（6 ビットの版番号 + BCH(18,6) の 12 ビット）。
 *
 * 生成多項式は 0x1F25。**既知の値（版 7 = 0x07C94 ほか）と
 * `encode.spec.ts` が突き合わせている。**
 */
export function versionInfoBits(version: number): number {
  let remainder = version;
  for (let i = 0; i < 12; i++) {
    remainder <<= 1;
    if ((remainder >>> 12) !== 0) remainder ^= 0x1f25;
  }
  return (version << 12) | remainder;
}

/**
 * 形式情報の 15 ビット（誤り訂正レベル 2 ビット + マスク 3 ビット +
 * BCH(15,5) の 10 ビット、最後に 0x5412 で XOR）。
 *
 * XOR は「全部 0 の形式情報」が生じないようにするためのもの。
 * **これを忘れると、レベル M・マスク 0 のときだけ全 0 になって、
 * 読み取り器が形式情報を見つけられなくなる。**
 */
export function formatInfoBits(mask: number): number {
  const data = (EC_LEVEL_M_BITS << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i++) {
    remainder <<= 1;
    if ((remainder >>> 10) !== 0) remainder ^= 0x537;
  }
  return ((data << 10) | remainder) ^ 0x5412;
}

function placeFormatInfo(grid: Grid, mask: number): void {
  const bits = formatInfoBits(mask);
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    // 左上まわり。6 行目・6 列目のタイミングパターンを跨ぐので添字が飛ぶ。
    if (i < 6) setModule(grid, 8, i, dark, true);
    else if (i === 6) setModule(grid, 8, 7, dark, true);
    else if (i === 7) setModule(grid, 8, 8, dark, true);
    else if (i === 8) setModule(grid, 7, 8, dark, true);
    else setModule(grid, 14 - i, 8, dark, true);

    // 2 つ目の写し。**右上と左下に分かれる。**
    if (i < 7) setModule(grid, grid.size - 1 - i, 8, dark, true);
    else setModule(grid, 8, grid.size - 15 + i, dark, true);
  }
}

/** マスク条件（ISO/IEC 18004 表 10）。true のモジュールを反転する。 */
export const MASK_FUNCTIONS: readonly ((row: number, col: number) => boolean)[] = [
  (row, col) => (row + col) % 2 === 0,
  (row) => row % 2 === 0,
  (_row, col) => col % 3 === 0,
  (row, col) => (row + col) % 3 === 0,
  (row, col) => (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0,
  (row, col) => ((row * col) % 2) + ((row * col) % 3) === 0,
  (row, col) => (((row * col) % 2) + ((row * col) % 3)) % 2 === 0,
  (row, col) => (((row + col) % 2) + ((row * col) % 3)) % 2 === 0,
] as const;

/**
 * 符号語列を行列へ流し込む。
 *
 * 右下から 2 列ずつ左へ進み、列の対の中で上下に折り返す。
 * **6 列目（タイミングパターン）は列の対から外す。**
 */
function placeData(grid: Grid, codewords: readonly number[], mask: number): void {
  const maskFn = MASK_FUNCTIONS[mask];
  if (maskFn === undefined) throw new Error(`QR_MASK_UNSUPPORTED:${String(mask)}`);

  let bitIndex = 0;
  let upward = true;

  for (let right = grid.size - 1; right >= 1; right -= 2) {
    // **6 列目（タイミングパターン）に当たったら列そのものをずらす。**
    // ここを一時変数で逃がすと、以降の列の対が 1 つずれる。実際に
    // 「5・4 の次が 4・3」となり、4 列目を 2 度書いて 0 列目を書かない
    // 状態になった。空きモジュールの総数は合ってしまい、
    // `freeModuleCount()` の検算では気づけない。**代入で進めること。**
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < grid.size; vertical++) {
      const row = upward ? grid.size - 1 - vertical : vertical;
      for (let offset = 0; offset < 2; offset++) {
        const col = right - offset;
        if (isReserved(grid, row, col)) continue;
        // 符号語を使い切ったあとは残余ビット（0）を置く。
        const byte = codewords[bitIndex >>> 3] ?? 0;
        const bit = ((byte >>> (7 - (bitIndex & 7))) & 1) === 1;
        setModule(grid, row, col, bit !== maskFn(row, col), false);
        bitIndex++;
      }
    }
    upward = !upward;
  }
}

/**
 * マスクの評価（ISO/IEC 18004 表 11 の 4 つの規則）。**値が小さいほど良い。**
 */
export function penaltyScore(grid: Grid): number {
  const { size } = grid;
  let score = 0;

  // 規則 1: 同じ色が 5 個以上連続。
  for (let i = 0; i < size; i++) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const current = horizontal ? isDark(grid, i, j) : isDark(grid, j, i);
        const previous = horizontal ? isDark(grid, i, j - 1) : isDark(grid, j - 1, i);
        if (current === previous) {
          run++;
          continue;
        }
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // 規則 2: 2×2 の同色。
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const first = isDark(grid, row, col);
      if (
        first === isDark(grid, row, col + 1) &&
        first === isDark(grid, row + 1, col) &&
        first === isDark(grid, row + 1, col + 1)
      ) {
        score += 3;
      }
    }
  }

  // 規則 3: 位置検出パターンに似た並び（1:1:3:1:1 + 空白 4）。
  const patternA = [true, false, true, true, true, false, true, false, false, false, false];
  const patternB = [false, false, false, false, true, false, true, true, true, false, true];
  for (let i = 0; i < size; i++) {
    for (let j = 0; j <= size - 11; j++) {
      for (const horizontal of [true, false]) {
        let matchA = true;
        let matchB = true;
        for (let k = 0; k < 11; k++) {
          const value = horizontal ? isDark(grid, i, j + k) : isDark(grid, j + k, i);
          if (value !== patternA[k]) matchA = false;
          if (value !== patternB[k]) matchB = false;
        }
        if (matchA) score += 40;
        if (matchB) score += 40;
      }
    }
  }

  // 規則 4: 暗モジュールの比率が 50% からどれだけ離れているか。
  let dark = 0;
  for (let i = 0; i < size * size; i++) if (grid.modules[i] === 1) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/** 符号化の結果。`modules[row][col]` が true なら暗。 */
export interface QrCode {
  readonly version: number;
  readonly size: number;
  readonly modules: readonly (readonly boolean[])[];
}

/**
 * 機能パターンだけを置いた行列を作る。**データを流す前の状態。**
 *
 * `encode.spec.ts` が「空きモジュール数 = 符号語 × 8 + 残余ビット」を
 * 確かめるために使う（`VERSIONS` の表を幾何の側から検算する）。
 */
export function buildFunctionGrid(version: number): Grid {
  const size = moduleCount(version);
  const grid = createGrid(size);
  placeFinder(grid, 0, 0);
  placeFinder(grid, 0, size - 7);
  placeFinder(grid, size - 7, 0);
  placeAlignment(grid, version);
  placeTiming(grid);
  reserveFormatAreas(grid);
  placeVersionInfo(grid, version);
  return grid;
}

/** 予約されていない（＝データが入る）モジュールの数。 */
export function freeModuleCount(version: number): number {
  const grid = buildFunctionGrid(version);
  let free = 0;
  for (let i = 0; i < grid.reserved.length; i++) if (grid.reserved[i] === 0) free++;
  return free;
}

/** 残余ビットを含めた、版が持つべき空きモジュール数。 */
export function expectedFreeModules(version: number): number {
  return specOf(version).totalCodewords * 8 + remainderBits(version);
}

/**
 * 文字列を QR コードへ符号化する。
 *
 * **純粋関数。** DOM も `fetch` も `Date.now()` も触らない。ブラウザでも
 * Workers でも同じ値を返す（`packages/engine` と同じ約束）。
 *
 * @throws `QR_PAYLOAD_TOO_LONG` 版 10-M に収まらない場合。
 */
export function encodeQr(text: string): QrCode {
  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length);
  const codewords = interleave(buildDataCodewords(bytes, version), version);

  let best: Grid | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  // **8 通りすべてを作って点数の低いものを採る**（ISO/IEC 18004 8.8.2）。
  // 総当たりで足りる（版 10 でも 8 × 57×57 モジュール）。
  for (let mask = 0; mask < MASK_FUNCTIONS.length; mask++) {
    const candidate = buildFunctionGrid(version);
    placeData(candidate, codewords, mask);
    placeFormatInfo(candidate, mask);
    const score = penaltyScore(candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  if (best === null) throw new Error("QR_MASK_SELECTION_FAILED");
  const chosen = best;

  const size = chosen.size;
  const modules: boolean[][] = [];
  for (let row = 0; row < size; row++) {
    const line: boolean[] = [];
    for (let col = 0; col < size; col++) line.push(isDark(chosen, row, col));
    modules.push(line);
  }

  return { version, size, modules };
}

/**
 * `<path d="…">` に入れる矩形の集まりを作る。
 *
 * **1 モジュール = 1 サブパス。** 画像を作らず、SVG のパス 1 本で描く。
 * 印刷時に解像度で潰れないことと、外部リソースを読まないことの両方が要る。
 */
export function qrPath(code: QrCode): string {
  const parts: string[] = [];
  for (let row = 0; row < code.size; row++) {
    const line = code.modules[row] ?? [];
    for (let col = 0; col < code.size; col++) {
      if (line[col] === true) parts.push(`M${String(col)} ${String(row)}h1v1h-1z`);
    }
  }
  return parts.join("");
}

/**
 * 検証（`encode.spec.ts`）から行列を読むための口。
 *
 * **spec 側は独立した読み取り器を持っている。** そのために機能パターンの
 * 位置（`isReserved`）とモジュールの明暗（`isDark`）だけを外へ出す。
 * **符号化の途中結果は出さない。** 出すと「符号化器が出した値を
 * 符号化器で確かめる」ことになり、検証にならない。
 */
export const internals = { isDark, isReserved } as const;
