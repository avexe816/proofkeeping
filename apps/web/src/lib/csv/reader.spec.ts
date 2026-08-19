/**
 * CSV 読み取りの共通部分（区切りの判定を含む）。
 *
 * task: docs/tasks/P4-02.md / DECISIONS #211（タブ区切り対応）
 */

import { describe, expect, it } from "vitest";

import { findCsvHeader, splitCsvLine } from "./reader.js";

describe("splitCsvLine", () => {
  it("カンマで割る（既定）", () => {
    expect(splitCsvLine("302,2026-09-01,true")).toEqual(["302", "2026-09-01", "true"]);
  });

  it("引用符の中のカンマは区切りにしない", () => {
    expect(splitCsvLine('302,"備考, カンマ入り",true')).toEqual([
      "302",
      "備考, カンマ入り",
      "true",
    ]);
  });

  it("タブで割る（Excel コピーの形）", () => {
    expect(splitCsvLine("302\t2026-09-01\ttrue", "\t")).toEqual(["302", "2026-09-01", "true"]);
  });

  it("タブ区切りのとき、値の中のカンマはそのまま残る", () => {
    expect(splitCsvLine("302\t備考, カンマ入り\ttrue", "\t")).toEqual([
      "302",
      "備考, カンマ入り",
      "true",
    ]);
  });
});

describe("findCsvHeader — 区切りの判定", () => {
  it("カンマ区切りのヘッダを見つけ、delimiter がカンマになる", () => {
    const header = findCsvHeader(["room_number,guest_count", "302,2"], "room_number");
    expect(header.index).toBe(0);
    expect(header.delimiter).toBe(",");
    expect(header.columns.get("guest_count")).toBe(1);
  });

  it("タブ区切りのヘッダを見つけ、delimiter がタブになる", () => {
    const header = findCsvHeader(["room_number\tguest_count", "302\t2"], "room_number");
    expect(header.index).toBe(0);
    expect(header.delimiter).toBe("\t");
    expect(header.columns.get("guest_count")).toBe(1);
  });

  it("BOM 付きのタブ区切りヘッダも見つかる", () => {
    const header = findCsvHeader(["﻿room_number\tguest_count"], "room_number");
    expect(header.index).toBe(0);
    expect(header.delimiter).toBe("\t");
  });

  it("必須列が無ければ見つからない（delimiter は既定のカンマ）", () => {
    const header = findCsvHeader(["name\ttel"], "room_number");
    expect(header.index).toBe(-1);
    expect(header.delimiter).toBe(",");
  });
});
