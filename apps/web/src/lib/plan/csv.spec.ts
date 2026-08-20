/**
 * CSV 取込（PK-SPEC-P1 §3.4）。
 *
 * task: docs/tasks/P1-04.md
 */

import { describe, expect, it } from "vitest";

import { parsePlanCsv } from "./csv.js";

const HEADER =
  "room_number,business_date,has_checkout,has_checkin,is_stayover,guest_count,decline_clean";

describe("parsePlanCsv — 正例", () => {
  it("仕様の例をそのまま読める", () => {
    const csv = [HEADER, "302,2026-09-01,true,true,false,2,false", "305,2026-09-01,false,false,true,1,false"].join(
      "\n",
    );

    const { rows, skippedLines } = parsePlanCsv(csv, "2026-09-01");

    expect(skippedLines).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      roomNumber: "302",
      businessDate: "2026-09-01",
      hasCheckout: true,
      hasCheckin: true,
      isStayover: false,
      guestCount: 2,
      declineClean: false,
    });
    expect(rows[1]?.isStayover).toBe(true);
  });

  it("TRUE / 1 / ○ / yes をすべて真として読む（表計算ソフトの揺れ）", () => {
    const csv = [
      HEADER,
      "302,2026-09-01,TRUE,1,○,2,yes",
    ].join("\n");

    const row = parsePlanCsv(csv, "2026-09-01").rows[0];

    expect(row?.hasCheckout).toBe(true);
    expect(row?.hasCheckin).toBe(true);
    expect(row?.isStayover).toBe(true);
    expect(row?.declineClean).toBe(true);
  });

  it("空欄は偽として読む", () => {
    const row = parsePlanCsv([HEADER, "302,2026-09-01,,,,,"].join("\n"), "2026-09-01").rows[0];

    expect(row?.hasCheckout).toBe(false);
    expect(row?.guestCount).toBe(0);
  });

  it("列の並びが違っても、ヘッダ名で対応づける", () => {
    const csv = ["has_checkout,room_number", "true,302"].join("\n");

    expect(parsePlanCsv(csv, "2026-09-01").rows[0]).toMatchObject({
      roomNumber: "302",
      hasCheckout: true,
    });
  });

  it("未知の列は無視する（宿泊者名の列が混ざっても読まない）", () => {
    const csv = [`${HEADER},guest_name`, "302,2026-09-01,true,false,false,2,false,山田"].join("\n");

    const row = parsePlanCsv(csv, "2026-09-01").rows[0];

    expect(row).not.toHaveProperty("guest_name");
    expect(Object.values(row ?? {})).not.toContain("山田");
  });

  it("引用符つきの値でも列がずれない", () => {
    const csv = [HEADER, '"302","2026-09-01",true,false,false,"2",false'].join("\n");

    expect(parsePlanCsv(csv, "2026-09-01").rows[0]?.guestCount).toBe(2);
  });

  it("BOM つき・CRLF でも読める", () => {
    const csv = `\uFEFF${HEADER}\r\n302,2026-09-01,true,false,false,1,false\r\n`;

    expect(parsePlanCsv(csv, "2026-09-01").rows).toHaveLength(1);
  });

  it("business_date 列が無くても取込先の業務日を使う", () => {
    const csv = ["room_number,has_checkout", "302,true"].join("\n");

    expect(parsePlanCsv(csv, "2026-09-01").rows[0]?.businessDate).toBe("2026-09-01");
  });
});

describe("parsePlanCsv — 1 行の誤りで全体を落とさない", () => {
  it("客室番号が空の行だけを飛ばす", () => {
    const csv = [HEADER, ",2026-09-01,true,false,false,1,false", "305,2026-09-01,true,false,false,1,false"].join(
      "\n",
    );

    const { rows, skippedLines } = parsePlanCsv(csv, "2026-09-01");

    expect(rows).toHaveLength(1);
    expect(skippedLines).toEqual([2]);
  });

  it("別の業務日の行を飛ばす（翌日ぶんの上書きを防ぐ）", () => {
    const csv = [HEADER, "302,2026-09-02,true,false,false,1,false"].join("\n");

    const { rows, skippedLines } = parsePlanCsv(csv, "2026-09-01");

    expect(rows).toEqual([]);
    expect(skippedLines).toEqual([2]);
  });

  it("日付の形が違う行を飛ばす", () => {
    const csv = [HEADER, "302,2026/09/01,true,false,false,1,false"].join("\n");

    expect(parsePlanCsv(csv, "2026-09-01").skippedLines).toEqual([2]);
  });

  it("人数が負値・非数なら 0 にする（行は捨てない）", () => {
    const csv = [HEADER, "302,2026-09-01,true,false,false,-3,false", "305,2026-09-01,true,false,false,abc,false"].join(
      "\n",
    );

    const { rows, skippedLines } = parsePlanCsv(csv, "2026-09-01");

    expect(skippedLines).toEqual([]);
    expect(rows.map((row) => row.guestCount)).toEqual([0, 0]);
  });

  it("空行を飛ばしても行番号がずれない", () => {
    const csv = [HEADER, "", "302,2026-09-01,true,false,false,1,false", "", ",2026-09-01,,,,,"].join("\n");

    const { rows, skippedLines } = parsePlanCsv(csv, "2026-09-01");

    expect(rows).toHaveLength(1);
    expect(skippedLines).toEqual([5]);
  });

  it("ヘッダが無ければ 1 行も読まない", () => {
    expect(parsePlanCsv("302,2026-09-01,true", "2026-09-01").rows).toEqual([]);
  });

  it("空文字なら 1 行も読まない", () => {
    expect(parsePlanCsv("", "2026-09-01")).toEqual({ rows: [], skippedLines: [] });
  });

  it("同じ CSV を 3 回読んでも同じ結果（冪等な入力）", () => {
    const csv = [HEADER, "302,2026-09-01,true,false,false,2,false"].join("\n");
    const once = parsePlanCsv(csv, "2026-09-01");

    expect(parsePlanCsv(csv, "2026-09-01")).toEqual(once);
    expect(parsePlanCsv(csv, "2026-09-01")).toEqual(once);
  });
});

describe("parsePlanCsv — タブ区切り（Excel コピー / DECISIONS #211）", () => {
  it("タブ区切りでも同じ内容を読める", () => {
    const tsv = [
      "room_number\tbusiness_date\thas_checkout\thas_checkin\tis_stayover\tguest_count\tdecline_clean",
      "302\t2026-09-01\ttrue\ttrue\tfalse\t2\tfalse",
    ].join("\n");

    const { rows, skippedLines } = parsePlanCsv(tsv, "2026-09-01");

    expect(skippedLines).toEqual([]);
    expect(rows).toEqual([
      {
        roomNumber: "302",
        businessDate: "2026-09-01",
        hasCheckout: true,
        hasCheckin: true,
        isStayover: false,
        guestCount: 2,
        declineClean: false,
      },
    ]);
  });

  it("カンマ区切りと同じ結果になる（区切りの違いで意味が変わらない）", () => {
    const csv = [HEADER, "302,2026-09-01,true,false,true,1,false"].join("\n");
    const tsv = csv.replace(/,/g, "\t");

    expect(parsePlanCsv(tsv, "2026-09-01")).toEqual(parsePlanCsv(csv, "2026-09-01"));
  });
});
