/**
 * ZIP の書き出し（PK-SPEC-P2 §6.5 の証跡バンドル）。**無圧縮（STORE）のみ。**
 *
 * task:  docs/tasks/P2-10.md
 * ルール: .claude/rules/architecture.md §5（重い処理は Queue で）
 *
 * ── なぜ自前なのか ──────────────────────────────────────
 * Workers に ZIP を作る API は無い。`CompressionStream("deflate-raw")` は
 * あるが、**ZIP の容器（ローカルヘッダ・セントラルディレクトリ）は
 * どのみち自前で組む**必要がある。容器を組んだ上で圧縮まで足すと、
 * CRC-32 と圧縮後サイズを 2 パスで扱うことになり、コンシューマの
 * メモリと CPU が読みにくくなる。**中身はほぼ JPEG（既に圧縮済み）**で、
 * deflate を掛けても縮まない。だから STORE に倒した。
 *
 * ── 依存を足していない ──────────────────────────────────
 * fflate 等を入れれば数行で済むが、Workers の実行環境で動くことを
 * 別途確かめる必要があり、証跡の生成物という**長期に読み返す成果物**の
 * 形式を外部の版に委ねることになる。ZIP の STORE は 3 つの構造体で
 * 足りるので、ここに固定して仕様（APPNOTE 6.3.x）へ直接対応させる。
 *
 * ── ZIP64 を実装していない ──────────────────────────────
 * 4GB / 65535 件を超える書庫は作れない。**1 タスク分の証跡**（JSON 数件と
 * 写真 20 枚まで / `MAX_PHOTOS_PER_TASK`）はこの上限から遠い。
 * 超える入力は `ZipTooLargeError` で**落とす。** 黙って壊れた書庫を
 * 吐くと、`verify.txt` は通るのに展開できないものが残る。
 */

/** ZIP へ入れる 1 ファイル。 */
export interface ZipEntry {
  /** 書庫内のパス。`photos/cleaning-001.jpg` のようにスラッシュ区切り。 */
  path: string;
  bytes: Uint8Array;
  /**
   * 更新日時。**UTC のまま MS-DOS 形式へ落とす。**
   *
   * ZIP のタイムスタンプにタイムゾーンの欄が無い。ローカル時刻で
   * 書くと、読む場所によって表示が変わる。**証跡の時刻は
   * `manifest.json` が ISO 8601 UTC で持つ**ので、こちらは
   * 書庫の体裁として置くだけ。
   */
  at: Date;
}

/** 上限を超えた入力。**黙って壊れた書庫を作らない。** */
export class ZipTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipTooLargeError";
  }
}

/** ZIP64 なしで表せる上限（APPNOTE 4.4）。 */
const MAX_UINT32 = 0xffff_ffff;
const MAX_ENTRIES = 0xffff;

const LOCAL_FILE_HEADER_SIGNATURE = 0x0403_4b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x0201_4b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x0605_4b50;

/** 無圧縮。 */
const METHOD_STORE = 0;
/** 展開に要する最低版（2.0 = STORE + ディレクトリ）。 */
const VERSION_NEEDED = 20;
/** 汎用フラグ bit 11。**ファイル名が UTF-8 であることを示す。** */
const FLAG_UTF8 = 0x0800;

const encoder = new TextEncoder();

/** CRC-32 の表。**初回の呼び出しで 1 度だけ作る。** */
let crcTable: Uint32Array | undefined;

function getCrcTable(): Uint32Array {
  if (crcTable !== undefined) return crcTable;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb8_8320 : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  crcTable = table;
  return table;
}

/**
 * CRC-32（IEEE 802.3）。**ZIP が要求するのはこの多項式。**
 *
 * SHA-256（`verify.txt`）とは役割が違う。CRC は展開ソフトが
 * 転送の壊れを見るためのもので、**改ざんの検出には使えない。**
 */
export function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ (table[(crc ^ byte) & 0xff] ?? 0);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

/** MS-DOS 形式の日付・時刻（APPNOTE 4.4.6）。**2 秒刻み・1980 年起点。** */
export function toDosDateTime(at: Date): { date: number; time: number } {
  const year = at.getUTCFullYear();
  // 1980 年より前は表せない。**例外にせず 1980-01-01 へ丸める**
  // （書庫の体裁の欄で処理を止める理由が無い）。
  if (year < 1980) return { date: (1 << 5) | 1, time: 0 };
  const date = ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate();
  const time =
    (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2);
  return { date, time };
}

/**
 * ZIP（STORE）を組み立てる。
 *
 * **全体をメモリに載せる。** 1 タスク分（写真 20 枚 × 500KB 上限）で
 * 10MB 程度に収まる（security.md §4）。それを超える入力は上の
 * `ZipTooLargeError` が落とす。ストリームにしていないのは、
 * R2 へ `put()` するときにどのみち長さが要るため。
 *
 * @throws {ZipTooLargeError} 4GB 超・65535 件超・同名のパスが 2 つ。
 */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  if (entries.length > MAX_ENTRIES) {
    throw new ZipTooLargeError(`ZIP_TOO_MANY_ENTRIES:${String(entries.length)}`);
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.path)) throw new ZipTooLargeError(`ZIP_DUPLICATE_PATH:${entry.path}`);
    seen.add(entry.path);
  }

  const prepared = entries.map((entry) => {
    const nameBytes = encoder.encode(entry.path);
    return {
      nameBytes,
      bytes: entry.bytes,
      crc: crc32(entry.bytes),
      ...toDosDateTime(entry.at),
    };
  });

  const localSize = prepared.reduce(
    (sum, entry) => sum + 30 + entry.nameBytes.length + entry.bytes.length,
    0,
  );
  const centralSize = prepared.reduce((sum, entry) => sum + 46 + entry.nameBytes.length, 0);
  const total = localSize + centralSize + 22;
  if (total > MAX_UINT32) throw new ZipTooLargeError(`ZIP_TOO_LARGE:${String(total)}`);

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;

  /** リトルエンディアンで書く。**ZIP は全欄がリトルエンディアン。** */
  const u16 = (value: number): void => {
    view.setUint16(offset, value, true);
    offset += 2;
  };
  const u32 = (value: number): void => {
    view.setUint32(offset, value >>> 0, true);
    offset += 4;
  };
  const raw = (bytes: Uint8Array): void => {
    out.set(bytes, offset);
    offset += bytes.length;
  };

  const localOffsets: number[] = [];

  for (const entry of prepared) {
    localOffsets.push(offset);
    u32(LOCAL_FILE_HEADER_SIGNATURE);
    u16(VERSION_NEEDED);
    u16(FLAG_UTF8);
    u16(METHOD_STORE);
    u16(entry.time);
    u16(entry.date);
    u32(entry.crc);
    // STORE なので圧縮前後のサイズが等しい。
    u32(entry.bytes.length);
    u32(entry.bytes.length);
    u16(entry.nameBytes.length);
    u16(0); // extra field なし
    raw(entry.nameBytes);
    raw(entry.bytes);
  }

  const centralStart = offset;

  for (const [index, entry] of prepared.entries()) {
    u32(CENTRAL_DIRECTORY_SIGNATURE);
    u16(VERSION_NEEDED); // 作成した版
    u16(VERSION_NEEDED); // 展開に要する版
    u16(FLAG_UTF8);
    u16(METHOD_STORE);
    u16(entry.time);
    u16(entry.date);
    u32(entry.crc);
    u32(entry.bytes.length);
    u32(entry.bytes.length);
    u16(entry.nameBytes.length);
    u16(0); // extra field
    u16(0); // コメント
    u16(0); // 分割ディスク番号
    u16(0); // 内部属性
    u32(0); // 外部属性
    u32(localOffsets[index] ?? 0);
    raw(entry.nameBytes);
  }

  u32(END_OF_CENTRAL_DIRECTORY_SIGNATURE);
  u16(0); // このディスクの番号
  u16(0); // セントラルディレクトリの開始ディスク
  u16(prepared.length);
  u16(prepared.length);
  u32(offset - centralStart);
  u32(centralStart);
  u16(0); // 書庫コメントの長さ

  return out;
}
