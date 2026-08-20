/**
 * CSV ファイルのデコード（W-05 のファイル取込 / DECISIONS #211）。
 */

import { describe, expect, it } from "vitest";

import { decodeCsvBuffer } from "./decode.js";

function bufferOf(bytes: number[]): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

/** ASCII の並びをバイト列へ。UTF-8 では ASCII は 1 文字 1 バイト。 */
function asciiBytes(text: string): number[] {
  return [...new TextEncoder().encode(text)];
}

describe("decodeCsvBuffer", () => {
  it("UTF-8 をそのまま読む", () => {
    const text = "room_number,備考\n302,和室";
    expect(decodeCsvBuffer(new TextEncoder().encode(text).buffer)).toBe(text);
  });

  it("BOM 付き UTF-8 も読める（BOM は TextDecoder が既定で除去する）", () => {
    const body = new TextEncoder().encode("room_number\n302");
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...body]);
    expect(decodeCsvBuffer(withBom.buffer)).toBe("room_number\n302");
  });

  it("Shift_JIS の日本語を読める", () => {
    // 「和室」の Shift_JIS 表現: 0x98 0x61 0x8E 0xBA
    const bytes = bufferOf([...asciiBytes("room_number,note\n302,"), 0x98, 0x61, 0x8e, 0xba]);
    expect(decodeCsvBuffer(bytes)).toBe("room_number,note\n302,和室");
  });

  it("ASCII だけのファイルはどちらの文字コードでも同じに読める", () => {
    const text = "room_number,guest_count\n302,2";
    const ascii = bufferOf(asciiBytes(text));
    expect(decodeCsvBuffer(ascii)).toBe(text);
  });
});
