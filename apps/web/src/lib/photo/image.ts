/**
 * 画像バイト列の検査とメタデータ除去（PK-SPEC-P1 §7.2 / security.md §4）。
 *
 * task:  docs/tasks/P1-11.md
 * ルール: .claude/rules/security.md §4（EXIF GPS を**両側で**除去する）
 *
 * ── なぜサーバー側でもやるのか ──────────────────────────
 * クライアントは canvas で再エンコードするので EXIF は落ちる（`resize.ts`）。
 * それでも API は誰でも叩ける。**画面を通らずに素の写真を POST できる**
 * 経路がある以上、位置情報を落とす責任をクライアントに預けられない。
 * INV-11 は「保存しない」を求めており、届いた時点で落とす。
 *
 * ── 再エンコードしない ──────────────────────────────────
 * Workers に画像デコーダは無い。**セグメント単位で捨てる**方式にする。
 * JPEG は APP1（EXIF / XMP）と COM を、PNG は eXIf / tEXt 系を落とす。
 * 画素は触らないので、写真そのものは変わらない。
 *
 * ── 依存を持たない純粋関数にしてある ────────────────────
 * `Uint8Array` を受けて `Uint8Array` を返すだけ。node のテストで
 * 「GPS を含む JPEG を通したら消えている」を直接押さえられる。
 */

/** 判別できた画像形式。 */
export type ImageFormat = "image/jpeg" | "image/png";

/** 画素の寸法。 */
export interface ImageSize {
  width: number;
  height: number;
}

const JPEG_SOI = [0xff, 0xd8];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((value, index) => bytes[index] === value);
}

/**
 * 中身から形式を見る。**`Content-Type` を信用しない。**
 *
 * 宣言と中身が食い違うファイルは、宣言に合わせた処理を素通りする。
 * HEIC を `image/jpeg` と名乗って送れば、JPEG のセグメント走査は
 * 何も見つけられず、EXIF を積んだまま R2 へ入る。
 */
export function detectImageFormat(bytes: Uint8Array): ImageFormat | null {
  if (startsWith(bytes, JPEG_SOI)) return "image/jpeg";
  if (startsWith(bytes, PNG_SIGNATURE)) return "image/png";
  return null;
}

/** 2 バイトを big endian で読む。 */
function readUint16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

/** 4 バイトを big endian で読む。 */
function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)
  ) >>> 0;
}

/** 長さを持たない（後続データの無い）マーカー。 */
function isStandaloneMarker(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9);
}

/** SOF（フレーム開始）。ここに寸法がある。`C4`/`C8`/`CC` は別物。 */
function isFrameMarker(marker: number): boolean {
  if (marker < 0xc0 || marker > 0xcf) return false;
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * 落とすセグメント。
 *
 * - `APP1`(E1) EXIF・XMP。**位置情報はここに入る。**
 * - `APP2`〜`APP15` ICC・Ducky・メーカー独自。撮影機材や設定が入りうる。
 * - `COM`(FE) コメント。
 *
 * `APP0`(E0 / JFIF) だけは残す。密度情報だけを持ち、これを落とすと
 * 一部の古いビューアが開けなくなる。
 */
function isDroppableMarker(marker: number): boolean {
  if (marker === 0xfe) return true;
  return marker >= 0xe1 && marker <= 0xef;
}

/**
 * JPEG から EXIF・XMP・コメントを落とす。
 *
 * @returns 落とした後のバイト列。JPEG として読めなければ `null`。
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array | null {
  if (!startsWith(bytes, JPEG_SOI)) return null;

  const chunks: Uint8Array[] = [bytes.subarray(0, 2)];
  let offset = 2;

  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) return null; // マーカーの位置がずれている。
    // 0xFF の詰め物は連続しうる。マーカー本体まで読み進める。
    let markerAt = offset + 1;
    while (markerAt < bytes.length && bytes[markerAt] === 0xff) markerAt += 1;
    const marker = bytes[markerAt];
    if (marker === undefined) return null;

    if (isStandaloneMarker(marker)) {
      chunks.push(bytes.subarray(offset, markerAt + 1));
      offset = markerAt + 1;
      continue;
    }

    const length = readUint16(bytes, markerAt + 1);
    if (length < 2) return null;
    const end = markerAt + 1 + length;
    if (end > bytes.length) return null;

    if (!isDroppableMarker(marker)) chunks.push(bytes.subarray(offset, end));

    // SOS（0xDA）の後ろは圧縮データ。**そのまま末尾まで写す。**
    if (marker === 0xda) {
      chunks.push(bytes.subarray(end));
      offset = bytes.length;
      break;
    }
    offset = end;
  }

  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

/** JPEG の寸法。SOF が見つからなければ `null`。 */
export function readJpegSize(bytes: Uint8Array): ImageSize | null {
  if (!startsWith(bytes, JPEG_SOI)) return null;
  let offset = 2;

  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    let markerAt = offset + 1;
    while (markerAt < bytes.length && bytes[markerAt] === 0xff) markerAt += 1;
    const marker = bytes[markerAt];
    if (marker === undefined) return null;

    if (isStandaloneMarker(marker)) {
      offset = markerAt + 1;
      continue;
    }
    const length = readUint16(bytes, markerAt + 1);
    if (length < 2) return null;
    if (isFrameMarker(marker)) {
      return {
        height: readUint16(bytes, markerAt + 4),
        width: readUint16(bytes, markerAt + 6),
      };
    }
    if (marker === 0xda) return null; // 圧縮データに入った。SOF は無かった。
    offset = markerAt + 1 + length;
  }
  return null;
}

/** PNG で落とすチャンク。テキストと EXIF。**画素に関わるものは残す。** */
const PNG_DROPPABLE = new Set(["eXIf", "tEXt", "zTXt", "iTXt"]);

/** PNG から EXIF・テキストチャンクを落とす。 */
export function stripPngMetadata(bytes: Uint8Array): Uint8Array | null {
  if (!startsWith(bytes, PNG_SIGNATURE)) return null;

  const chunks: Uint8Array[] = [bytes.subarray(0, 8)];
  let offset = 8;
  const decoder = new TextDecoder("latin1");

  while (offset + 8 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const type = decoder.decode(bytes.subarray(offset + 4, offset + 8));
    const end = offset + 12 + length;
    if (end > bytes.length) return null;

    if (!PNG_DROPPABLE.has(type)) chunks.push(bytes.subarray(offset, end));
    offset = end;
    if (type === "IEND") break;
  }

  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

/** PNG の寸法（IHDR）。 */
export function readPngSize(bytes: Uint8Array): ImageSize | null {
  if (!startsWith(bytes, PNG_SIGNATURE)) return null;
  if (bytes.length < 24) return null;
  return { width: readUint32(bytes, 16), height: readUint32(bytes, 20) };
}

/** 検査と除去の結果。 */
export interface SanitizedImage {
  format: ImageFormat;
  bytes: Uint8Array;
  size: ImageSize;
}

/**
 * 受け取った画像を検査し、メタデータを落として返す。
 *
 * **形式が読めない・寸法が取れない場合は `null`。** 「たぶん JPEG」を
 * そのまま保存しない。読めないバイト列は、EXIF を落とせたことも
 * 確かめられていない。
 */
export function sanitizeImage(bytes: Uint8Array): SanitizedImage | null {
  const format = detectImageFormat(bytes);
  if (format === null) return null;

  if (format === "image/jpeg") {
    const stripped = stripJpegMetadata(bytes);
    if (stripped === null) return null;
    const size = readJpegSize(stripped);
    if (size === null || size.width === 0 || size.height === 0) return null;
    return { format, bytes: stripped, size };
  }

  const stripped = stripPngMetadata(bytes);
  if (stripped === null) return null;
  const size = readPngSize(stripped);
  if (size === null || size.width === 0 || size.height === 0) return null;
  return { format, bytes: stripped, size };
}
