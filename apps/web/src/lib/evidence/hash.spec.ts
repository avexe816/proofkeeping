/**
 * SHA-256 と、正規化 JSON → ハッシュ連鎖の通し（PK-SPEC-P2 §6.2 / §6.3）。
 *
 * task:  docs/tasks/P2-08.md
 * ルール: .claude/rules/testing.md
 *
 * ── 既知の値で固定する ──────────────────────────────────
 * 実装の出力どうしを比べるだけだと、両方が同じ間違いをしていても通る。
 * **公開されている SHA-256 のテストベクタ**を期待値に置く。
 * ここが変わると、保存済みの `payloadSha256` が全件再現しなくなる。
 */

import { canonicalJson, chainHashInput, GENESIS_HASH } from "@pk/engine";
import { describe, expect, it } from "vitest";

import { sha256Hex, sha256HexOfText } from "./hash.js";

/** NIST の SHA-256 テストベクタ。 */
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("sha256Hex", () => {
  it("空のバイト列", async () => {
    await expect(sha256Hex(new Uint8Array(0))).resolves.toBe(EMPTY_SHA256);
  });

  it('"abc"', async () => {
    await expect(sha256Hex(new TextEncoder().encode("abc"))).resolves.toBe(ABC_SHA256);
  });

  it("64 桁の小文字 16 進", async () => {
    const value = await sha256Hex(new Uint8Array([1, 2, 3]));
    expect(value).toMatch(/^[0-9a-f]{64}$/);
  });

  it("部分ビューでも範囲外を読まない", async () => {
    // `Uint8Array#buffer` を直に渡すと 8 バイト全部を読んでしまう。
    const full = new Uint8Array([9, 9, 97, 98, 99, 9, 9, 9]);
    const view = full.subarray(2, 5);
    await expect(sha256Hex(view)).resolves.toBe(ABC_SHA256);
  });
});

describe("sha256HexOfText", () => {
  it("UTF-8 でエンコードしてからハッシュする", async () => {
    await expect(sha256HexOfText("abc")).resolves.toBe(ABC_SHA256);
  });

  it("空文字", async () => {
    await expect(sha256HexOfText("")).resolves.toBe(EMPTY_SHA256);
  });

  it("非 ASCII でも決定的", async () => {
    const first = await sha256HexOfText("302号室");
    const second = await sha256HexOfText("302号室");
    expect(first).toBe(second);
  });
});

describe("正規化 JSON → payloadSha256（§6.2）", () => {
  it("キーの挿入順が違っても同じハッシュ（同入力→同ハッシュ）", async () => {
    const a = await sha256HexOfText(canonicalJson({ taskId: "t", round: 1 }));
    const b = await sha256HexOfText(canonicalJson({ round: 1, taskId: "t" }));
    expect(a).toBe(b);
  });

  it("値が 1 文字違えばハッシュが変わる", async () => {
    const a = await sha256HexOfText(canonicalJson({ note: "水滴跡" }));
    const b = await sha256HexOfText(canonicalJson({ note: "水滴痕" }));
    expect(a).not.toBe(b);
  });

  it("配列の順序が違えばハッシュが変わる（順序が記録）", async () => {
    const a = await sha256HexOfText(canonicalJson({ ids: ["a", "b"] }));
    const b = await sha256HexOfText(canonicalJson({ ids: ["b", "a"] }));
    expect(a).not.toBe(b);
  });
});

describe("chainHash（§6.2）", () => {
  it("先頭は GENESIS + payloadSha256 のハッシュ", async () => {
    const payloadSha256 = ABC_SHA256;
    const expected = await sha256HexOfText(`${GENESIS_HASH}${payloadSha256}`);
    await expect(sha256HexOfText(chainHashInput(null, payloadSha256))).resolves.toBe(expected);
  });

  it("同じ payload でも前の連鎖が違えば chainHash が変わる", async () => {
    const first = await sha256HexOfText(chainHashInput("aaa", ABC_SHA256));
    const second = await sha256HexOfText(chainHashInput("bbb", ABC_SHA256));
    expect(first).not.toBe(second);
  });

  it("連鎖を 3 件つないでも各段が決定的", async () => {
    const build = async (previous: string | null, payload: string): Promise<string> =>
      sha256HexOfText(chainHashInput(previous, await sha256HexOfText(payload)));

    const chain: string[] = [];
    let previous: string | null = null;
    for (const payload of ['{"n":1}', '{"n":2}', '{"n":3}']) {
      previous = await build(previous, payload);
      chain.push(previous);
    }

    const again: string[] = [];
    previous = null;
    for (const payload of ['{"n":1}', '{"n":2}', '{"n":3}']) {
      previous = await build(previous, payload);
      again.push(previous);
    }

    expect(chain).toEqual(again);
    expect(new Set(chain).size).toBe(3);
  });
});
