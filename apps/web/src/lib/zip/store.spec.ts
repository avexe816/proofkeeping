/**
 * `buildZip()` のテスト（PK-SPEC-P2 §6.5）。
 *
 * task: docs/tasks/P2-10.md
 *
 * ── 構造そのものを読み直して確かめる ────────────────────
 * ここで期待値をバイト列のダンプで固定すると、**間違った実装を
 * 間違ったダンプで固定する**ことになる。書き出した書庫を
 * 最小の読み取り器（`readZip()`）で読み直し、
 * 「入れたものが同じ名前・同じ中身で出る」を見る。
 * CRC-32 だけは既知の値（APPNOTE の慣用例）で外部から固定する。
 */

import { describe, expect, it } from "vitest";

import { buildZip, crc32, toDosDateTime, ZipTooLargeError } from "./store.js";

const AT = new Date("2026-09-10T04:25:31.000Z");

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 読み取り器。**セントラルディレクトリから辿る**（展開ソフトと同じ順序）。 */
function readZip(zip: Uint8Array): { path: string; text: string }[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // EOCD は末尾。書庫コメントを書いていないので固定で 22 バイト。
  const eocd = zip.length - 22;
  expect(view.getUint32(eocd, true)).toBe(0x0605_4b50);
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  const decoder = new TextDecoder();
  const out: { path: string; text: string }[] = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(offset, true)).toBe(0x0201_4b50);
    const size = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const localOffset = view.getUint32(offset + 42, true);
    const path = decoder.decode(zip.subarray(offset + 46, offset + 46 + nameLength));

    // ローカルヘッダから中身を取り出す。
    expect(view.getUint32(localOffset, true)).toBe(0x0403_4b50);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const extraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + extraLength;
    out.push({ path, text: decoder.decode(zip.subarray(dataStart, dataStart + size)) });

    offset += 46 + nameLength;
  }
  return out;
}

describe("buildZip: 書き出せるもの", () => {
  it("入れたファイルが同じ名前・同じ中身で読み出せる", () => {
    const zip = buildZip([
      { path: "manifest.json", bytes: bytesOf('{"a":1}'), at: AT },
      { path: "photos/cleaning-001.jpg", bytes: bytesOf("binary-ish"), at: AT },
      { path: "verify.txt", bytes: bytesOf("abc  manifest.json\n"), at: AT },
    ]);

    expect(readZip(zip)).toEqual([
      { path: "manifest.json", text: '{"a":1}' },
      { path: "photos/cleaning-001.jpg", text: "binary-ish" },
      { path: "verify.txt", text: "abc  manifest.json\n" },
    ]);
  });

  it("ファイルが 1 件でも書庫になる", () => {
    const zip = buildZip([{ path: "only.json", bytes: bytesOf("{}"), at: AT }]);
    expect(readZip(zip)).toEqual([{ path: "only.json", text: "{}" }]);
  });

  it("空の書庫（EOCD だけ）を作れる", () => {
    const zip = buildZip([]);
    expect(zip.length).toBe(22);
    expect(readZip(zip)).toEqual([]);
  });

  it("空のファイルを入れられる", () => {
    const zip = buildZip([{ path: "empty.txt", bytes: new Uint8Array(0), at: AT }]);
    expect(readZip(zip)).toEqual([{ path: "empty.txt", text: "" }]);
  });

  it("非 ASCII のパスが UTF-8 で往復する", () => {
    const zip = buildZip([{ path: "写真/客室.json", bytes: bytesOf("{}"), at: AT }]);
    expect(readZip(zip)[0]?.path).toBe("写真/客室.json");
  });

  it("UTF-8 フラグ（bit 11）を立てている", () => {
    const zip = buildZip([{ path: "日本語.txt", bytes: bytesOf("x"), at: AT }]);
    const view = new DataView(zip.buffer);
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800);
  });

  it("STORE（無圧縮）で書く", () => {
    const zip = buildZip([{ path: "a.txt", bytes: bytesOf("x"), at: AT }]);
    expect(new DataView(zip.buffer).getUint16(8, true)).toBe(0);
  });

  it("同じ入力から同じバイト列が出る", () => {
    const entries = [{ path: "a.json", bytes: bytesOf("{}"), at: AT }];
    expect(buildZip(entries)).toEqual(buildZip(entries));
  });
});

describe("buildZip: 落とすもの", () => {
  it("同名のパスが 2 つあると落とす", () => {
    expect(() =>
      buildZip([
        { path: "a.json", bytes: bytesOf("1"), at: AT },
        { path: "a.json", bytes: bytesOf("2"), at: AT },
      ]),
    ).toThrow(ZipTooLargeError);
  });

  it("件数の上限を超えると落とす", () => {
    const many = Array.from({ length: 0x10000 }, (_, i) => ({
      path: `f${String(i)}.txt`,
      bytes: new Uint8Array(0),
      at: AT,
    }));
    expect(() => buildZip(many)).toThrow(/ZIP_TOO_MANY_ENTRIES/);
  });
});

describe("crc32", () => {
  it('"123456789" の CRC-32 は 0xCBF43926', () => {
    expect(crc32(bytesOf("123456789"))).toBe(0xcbf4_3926);
  });

  it("空の入力は 0", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('"a" は 0xE8B7BE43', () => {
    expect(crc32(bytesOf("a"))).toBe(0xe8b7_be43);
  });

  it("1 バイト違えば値が変わる", () => {
    expect(crc32(bytesOf("abc"))).not.toBe(crc32(bytesOf("abd")));
  });

  it("符号なし 32 ビットの範囲に収まる", () => {
    expect(crc32(bytesOf("ÿÿÿ"))).toBeGreaterThanOrEqual(0);
    expect(crc32(bytesOf("ÿÿÿ"))).toBeLessThanOrEqual(0xffff_ffff);
  });
});

describe("toDosDateTime", () => {
  it("2026-09-10 04:25:31 UTC を MS-DOS 形式へ落とす", () => {
    // 年 = 2026-1980 = 46、月 = 9、日 = 10 → (46<<9)|(9<<5)|10
    expect(toDosDateTime(AT)).toEqual({
      date: (46 << 9) | (9 << 5) | 10,
      time: (4 << 11) | (25 << 5) | 15,
    });
  });

  it("秒は 2 秒刻みへ切り捨てる", () => {
    expect(toDosDateTime(new Date("2026-01-01T00:00:03.000Z")).time).toBe(1);
  });

  it("1980 年より前は 1980-01-01 へ丸める", () => {
    expect(toDosDateTime(new Date("1970-01-01T00:00:00.000Z"))).toEqual({
      date: (1 << 5) | 1,
      time: 0,
    });
  });
});
