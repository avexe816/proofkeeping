/**
 * 画像の検査とメタデータ除去（PK-SPEC-P1 §7.2 / security.md §4 / INV-11）。
 *
 * task: docs/tasks/P1-11.md
 *
 * ── ここが落ちたら位置情報が保存される ──────────────────
 * クライアントの canvas 再エンコードを通らない経路（API を直に叩く）で
 * EXIF を落とす最後の砦。**GPS を含む JPEG を通したら消えていること**を
 * バイト列で確かめる。
 */

import { describe, expect, it } from "vitest";

import {
  detectImageFormat,
  readJpegSize,
  readPngSize,
  sanitizeImage,
  stripJpegMetadata,
  stripPngMetadata,
} from "./image.js";

/** セグメントを組み立てる（`0xFF` + マーカー + 長さ + 本体）。 */
function segment(marker: number, payload: readonly number[]): number[] {
  const length = payload.length + 2;
  return [0xff, marker, (length >> 8) & 0xff, length & 0xff, ...payload];
}

/** `Exif\0\0` + 最小限の TIFF ヘッダ + GPS タグらしきバイト列。 */
const EXIF_WITH_GPS = [
  0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
  0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // TIFF ヘッダ（little endian）
  0x01, 0x00, // IFD エントリ 1 件
  0x25, 0x88, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x1a, 0x00, 0x00, 0x00, // GPS IFD ポインタ(0x8825)
  0x00, 0x00, 0x00, 0x00,
];

/** SOF0: 精度 8bit・高さ 1200・幅 1600・成分 1。 */
const SOF0_PAYLOAD = [0x08, 0x04, 0xb0, 0x06, 0x40, 0x01, 0x01, 0x11, 0x00];

/** 走査データつきの最小 JPEG。EXIF（GPS）とコメントを含む。 */
function jpegWithExif(): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, // SOI
    ...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00]), // APP0 (JFIF)
    ...segment(0xe1, EXIF_WITH_GPS), // APP1 (Exif)
    ...segment(0xfe, [0x68, 0x69]), // COM
    ...segment(0xc0, SOF0_PAYLOAD), // SOF0
    ...segment(0xda, [0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]), // SOS
    0x12, 0x34, 0x56, // 圧縮データ
    0xff, 0xd9, // EOI
  ]);
}

/** チャンクを組み立てる（長さ + 種別 + 本体 + CRC）。 */
function chunk(type: string, payload: readonly number[]): number[] {
  const length = payload.length;
  return [
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
    // チャンク種別は ASCII 4 文字。`charCodeAt` で 1 バイトずつ写す。
    ...Array.from({ length: type.length }, (_, index) => type.charCodeAt(index)),
    ...payload,
    0, 0, 0, 0, // CRC（検証しないので 0 で足りる）
  ];
}

function pngWithExif(): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    // IHDR: 幅 1600 / 高さ 1200
    ...chunk("IHDR", [0x00, 0x00, 0x06, 0x40, 0x00, 0x00, 0x04, 0xb0, 8, 2, 0, 0, 0]),
    ...chunk("eXIf", EXIF_WITH_GPS),
    ...chunk("tEXt", [0x61, 0x00, 0x62]),
    ...chunk("IDAT", [0x01, 0x02, 0x03]),
    ...chunk("IEND", []),
  ]);
}

/** バイト列に部分列が含まれるか。 */
function contains(haystack: Uint8Array, needle: readonly number[]): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

const EXIF_MAGIC = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];

describe("detectImageFormat", () => {
  it("中身から JPEG / PNG を見分ける", () => {
    expect(detectImageFormat(jpegWithExif())).toBe("image/jpeg");
    expect(detectImageFormat(pngWithExif())).toBe("image/png");
  });

  it("画像でないバイト列は null", () => {
    expect(detectImageFormat(new Uint8Array([0, 1, 2, 3]))).toBeNull();
    expect(detectImageFormat(new Uint8Array())).toBeNull();
  });

  it("HEIC（ftyp）は受け付けない", () => {
    const heic = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
    ]);
    expect(detectImageFormat(heic)).toBeNull();
  });
});

describe("stripJpegMetadata", () => {
  it("EXIF（GPS を含む）が消える（INV-11）", () => {
    const original = jpegWithExif();
    expect(contains(original, EXIF_MAGIC)).toBe(true);

    const stripped = stripJpegMetadata(original);
    expect(stripped).not.toBeNull();
    expect(contains(stripped as Uint8Array, EXIF_MAGIC)).toBe(false);
  });

  it("コメント（COM）も消える", () => {
    const stripped = stripJpegMetadata(jpegWithExif()) as Uint8Array;
    // COM のマーカー 0xFFFE が残っていない。
    expect(contains(stripped, [0xff, 0xfe])).toBe(false);
  });

  it("画素（SOS 以降）と JFIF は残る", () => {
    const stripped = stripJpegMetadata(jpegWithExif()) as Uint8Array;
    expect(contains(stripped, [0x12, 0x34, 0x56])).toBe(true);
    expect(contains(stripped, [0x4a, 0x46, 0x49, 0x46])).toBe(true);
  });

  it("落とした後も寸法が読める", () => {
    const stripped = stripJpegMetadata(jpegWithExif()) as Uint8Array;
    expect(readJpegSize(stripped)).toEqual({ width: 1600, height: 1200 });
  });

  it("2 回通しても結果が変わらない（冪等）", () => {
    const once = stripJpegMetadata(jpegWithExif()) as Uint8Array;
    const twice = stripJpegMetadata(once) as Uint8Array;
    expect([...twice]).toEqual([...once]);
  });

  it("JPEG でなければ null", () => {
    expect(stripJpegMetadata(new Uint8Array([0, 1, 2]))).toBeNull();
  });

  it("途中で切れているセグメントは null（読めないものを通さない）", () => {
    const broken = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x40, 0x01]);
    expect(stripJpegMetadata(broken)).toBeNull();
  });
});

describe("stripPngMetadata", () => {
  it("eXIf と tEXt が消える", () => {
    const original = pngWithExif();
    expect(contains(original, EXIF_MAGIC)).toBe(true);

    const stripped = stripPngMetadata(original) as Uint8Array;
    expect(contains(stripped, EXIF_MAGIC)).toBe(false);
    expect(contains(stripped, [0x74, 0x45, 0x58, 0x74])).toBe(false); // "tEXt"
  });

  it("IHDR と IDAT は残り、寸法も読める", () => {
    const stripped = stripPngMetadata(pngWithExif()) as Uint8Array;
    expect(contains(stripped, [0x01, 0x02, 0x03])).toBe(true);
    expect(readPngSize(stripped)).toEqual({ width: 1600, height: 1200 });
  });

  it("PNG でなければ null", () => {
    expect(stripPngMetadata(jpegWithExif())).toBeNull();
  });
});

describe("sanitizeImage", () => {
  it("JPEG は形式・寸法つきで返る", () => {
    const result = sanitizeImage(jpegWithExif());
    expect(result?.format).toBe("image/jpeg");
    expect(result?.size).toEqual({ width: 1600, height: 1200 });
    expect(contains(result?.bytes ?? new Uint8Array(), EXIF_MAGIC)).toBe(false);
  });

  it("PNG も同様", () => {
    const result = sanitizeImage(pngWithExif());
    expect(result?.format).toBe("image/png");
    expect(result?.size).toEqual({ width: 1600, height: 1200 });
  });

  it("寸法が読めない JPEG（SOF が無い）は受け付けない", () => {
    const noFrame = new Uint8Array([
      0xff, 0xd8,
      ...segment(0xe1, EXIF_WITH_GPS),
      ...segment(0xda, [0x00]),
      0xff, 0xd9,
    ]);
    expect(sanitizeImage(noFrame)).toBeNull();
  });

  it("画像でないバイト列は受け付けない", () => {
    expect(sanitizeImage(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(sanitizeImage(new Uint8Array())).toBeNull();
  });
});
