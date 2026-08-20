/**
 * 稼働記録 CSV 取込の検査（PK-SPEC-P4 §8.1）。
 *
 * task: docs/tasks/P4-02.md
 *
 * **`is_occupied` を既定値に倒さないこと**が中心。ここが崩れると
 * R001 が根拠のない差異を出す（DECISIONS #107）。
 */

import { describe, expect, it } from "vitest";

import { parseOccupancyCsv } from "./csv.js";

const DATE = "2026-09-09";

const HEADER =
  "room_number,business_date,is_occupied,guest_count,reservation_ref," +
  "check_in_at,check_out_at,is_stayover,night_index,nights_total,is_house_use";

function parse(...dataLines: string[]) {
  return parseOccupancyCsv([HEADER, ...dataLines].join("\n"), DATE);
}

describe("parseOccupancyCsv — 読める行", () => {
  it("仕様 §8.1 の例をそのまま読む", () => {
    const parsed = parse(
      `302,${DATE},false,0,,,,false,,,false`,
      `303,${DATE},true,2,RSV-8891,2026-09-09T15:20:00+09:00,,false,1,3,false`,
    );

    expect(parsed.skippedLines).toEqual([]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toEqual({
      roomNumber: "302",
      businessDate: DATE,
      isOccupied: false,
      guestCount: 0,
      reservationRef: null,
      checkInAt: null,
      checkOutAt: null,
      isStayover: false,
      nightIndex: null,
      nightsTotal: null,
      isHouseUse: false,
    });
    expect(parsed.rows[1]).toMatchObject({
      roomNumber: "303",
      isOccupied: true,
      guestCount: 2,
      reservationRef: "RSV-8891",
      checkInAt: Date.parse("2026-09-09T15:20:00+09:00"),
      nightIndex: 1,
      nightsTotal: 3,
    });
  });

  it("業務日の列が空なら取込先の業務日とみなす", () => {
    const parsed = parse(`302,,true,1,,,,false,,,false`);
    expect(parsed.rows[0]?.businessDate).toBe(DATE);
    expect(parsed.skippedLines).toEqual([]);
  });

  it("BOM 付きのヘッダを読む", () => {
    const csv = ["﻿" + HEADER, `302,${DATE},true,1,,,,false,,,false`].join("\n");
    expect(parseOccupancyCsv(csv, DATE).rows).toHaveLength(1);
  });

  it("列の順番が違っても列名で読む", () => {
    const csv = ["is_occupied,room_number,guest_count", `true,302,3`].join("\n");
    expect(parseOccupancyCsv(csv, DATE).rows[0]).toMatchObject({
      roomNumber: "302",
      isOccupied: true,
      guestCount: 3,
    });
  });

  it("未知の列を無視する（宿泊者名の列があっても読まない）", () => {
    const csv = [
      "room_number,is_occupied,guest_name,guest_phone,passport_no",
      "302,true,山田太郎,090-0000-0000,TR1234567",
    ].join("\n");
    const parsed = parseOccupancyCsv(csv, DATE);

    expect(parsed.rows).toHaveLength(1);
    // **読んだ値のどこにも氏名・連絡先が入っていない**（§2.1 MUST）。
    expect(JSON.stringify(parsed.rows[0])).not.toContain("山田");
    expect(JSON.stringify(parsed.rows[0])).not.toContain("090-");
    expect(JSON.stringify(parsed.rows[0])).not.toContain("TR1234567");
  });

  it("引用符でくくったカンマ入りの値で列がずれない", () => {
    const csv = ["room_number,is_occupied,reservation_ref", '302,true,"RSV,8891"'].join("\n");
    expect(parseOccupancyCsv(csv, DATE).rows[0]).toMatchObject({
      roomNumber: "302",
      isOccupied: true,
      reservationRef: "RSV,8891",
    });
  });

  it("CRLF 改行と空行を読み飛ばす", () => {
    const csv = [HEADER, `302,${DATE},true,1,,,,false,,,false`, "", ""].join("\r\n");
    const parsed = parseOccupancyCsv(csv, DATE);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.skippedLines).toEqual([]);
  });
});

describe("parseOccupancyCsv — 取り込まない行", () => {
  it("`is_occupied` が空欄の行を取り込まない", () => {
    // **既定値に倒すと「空室」という主張になる**（DECISIONS #107）。
    const parsed = parse(`302,${DATE},,0,,,,false,,,false`);
    expect(parsed.rows).toEqual([]);
    expect(parsed.skippedLines).toEqual([2]);
  });

  it("`is_occupied` が未知の表記の行を取り込まない", () => {
    const parsed = parse(`302,${DATE},maybe,0,,,,false,,,false`);
    expect(parsed.rows).toEqual([]);
    expect(parsed.skippedLines).toEqual([2]);
  });

  it("部屋番号が空の行を取り込まない", () => {
    const parsed = parse(`,${DATE},true,1,,,,false,,,false`);
    expect(parsed.rows).toEqual([]);
    expect(parsed.skippedLines).toEqual([2]);
  });

  it("業務日が取込先と違う行を取り込まない", () => {
    const parsed = parse(`302,2026-09-10,true,1,,,,false,,,false`);
    expect(parsed.rows).toEqual([]);
    expect(parsed.skippedLines).toEqual([2]);
  });

  it("業務日の書式が壊れた行を取り込まない", () => {
    const parsed = parse(`302,2026/09/09,true,1,,,,false,,,false`);
    expect(parsed.rows).toEqual([]);
    expect(parsed.skippedLines).toEqual([2]);
  });

  it("ヘッダが無ければ 0 行", () => {
    const parsed = parseOccupancyCsv(`302,${DATE},true`, DATE);
    expect(parsed.rows).toEqual([]);
    expect(parsed.skippedLines).toEqual([]);
  });

  it("空文字を渡しても落ちない", () => {
    expect(parseOccupancyCsv("", DATE)).toEqual({ rows: [], skippedLines: [] });
  });

  it("同じ部屋が 2 行あれば後の行を採り、先の行番号を返す", () => {
    const parsed = parse(
      `302,${DATE},true,1,,,,false,,,false`,
      `302,${DATE},false,0,,,,false,,,false`,
    );
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({ roomNumber: "302", isOccupied: false });
    expect(parsed.skippedLines).toEqual([2]);
  });

  it("読めない行があっても読める行は取り込む", () => {
    const parsed = parse(
      `302,${DATE},true,1,,,,false,,,false`,
      `303,${DATE},,0,,,,false,,,false`,
      `304,${DATE},false,0,,,,false,,,false`,
    );
    expect(parsed.rows.map((row) => row.roomNumber)).toEqual(["302", "304"]);
    expect(parsed.skippedLines).toEqual([3]);
  });
});

describe("parseOccupancyCsv — 値の正規化", () => {
  it("真偽値の表記の揺れを吸収する", () => {
    for (const raw of ["true", "TRUE", "1", "yes", "y", "○"]) {
      expect(parse(`302,${DATE},${raw},1,,,,false,,,false`).rows[0]?.isOccupied).toBe(true);
    }
    for (const raw of ["false", "FALSE", "0", "no", "n", "×"]) {
      expect(parse(`302,${DATE},${raw},0,,,,false,,,false`).rows[0]?.isOccupied).toBe(false);
    }
  });

  it("空室の行は人数を 0 にする（書いてあっても採らない）", () => {
    // 「空室に 2 名」は矛盾。そのまま入れると照合の根拠が食い違う。
    const parsed = parse(`302,${DATE},false,2,,,,false,,,false`);
    expect(parsed.rows[0]?.guestCount).toBe(0);
  });

  it("人数の非数・負値を 0 にし、上限で頭打ちにする", () => {
    expect(parse(`302,${DATE},true,abc,,,,false,,,false`).rows[0]?.guestCount).toBe(0);
    expect(parse(`302,${DATE},true,-3,,,,false,,,false`).rows[0]?.guestCount).toBe(0);
    expect(parse(`302,${DATE},true,1000,,,,false,,,false`).rows[0]?.guestCount).toBe(99);
  });

  it("オフセットの無い時刻を採らない（施設の時間帯を推測しない）", () => {
    const parsed = parse(`302,${DATE},true,1,,2026-09-09T15:20:00,,false,,,false`);
    expect(parsed.rows[0]?.checkInAt).toBeNull();
    // 時刻が読めなくても行そのものは取り込む。
    expect(parsed.rows).toHaveLength(1);
  });

  it("Z 表記の時刻を読む", () => {
    const parsed = parse(`302,${DATE},true,1,,2026-09-09T06:20:00Z,,false,,,false`);
    expect(parsed.rows[0]?.checkInAt).toBe(Date.parse("2026-09-09T06:20:00Z"));
  });

  it("壊れた時刻を null にする", () => {
    const parsed = parse(`302,${DATE},true,1,,not-a-date+09:00,,false,,,false`);
    expect(parsed.rows[0]?.checkInAt).toBeNull();
  });

  it("泊数は 1 以上の整数だけを採る", () => {
    expect(parse(`302,${DATE},true,1,,,,false,0,0,false`).rows[0]?.nightIndex).toBeNull();
    expect(parse(`302,${DATE},true,1,,,,false,-1,,false`).rows[0]?.nightIndex).toBeNull();
    expect(parse(`302,${DATE},true,1,,,,false,,999999,false`).rows[0]?.nightsTotal).toBeNull();
    expect(parse(`302,${DATE},true,1,,,,false,2,5,false`).rows[0]).toMatchObject({
      nightIndex: 2,
      nightsTotal: 5,
    });
  });

  it("長すぎる予約参照番号を採らない（列ずれの疑い）", () => {
    const long = "R".repeat(65);
    expect(parse(`302,${DATE},true,1,${long},,,false,,,false`).rows[0]?.reservationRef).toBeNull();
  });

  it("前後の空白を落とす", () => {
    const parsed = parse(`  302 ,${DATE}, true , 2 , RSV-1 ,,, false ,,, false `);
    expect(parsed.rows[0]).toMatchObject({
      roomNumber: "302",
      isOccupied: true,
      guestCount: 2,
      reservationRef: "RSV-1",
    });
  });

  it("同じ入力から同じ結果になる（決定性 / §10.1）", () => {
    const csv = [
      HEADER,
      `302,${DATE},true,2,RSV-1,2026-09-09T15:20:00+09:00,,false,1,3,false`,
      `303,${DATE},false,0,,,,false,,,true`,
    ].join("\n");
    expect(parseOccupancyCsv(csv, DATE)).toEqual(parseOccupancyCsv(csv, DATE));
  });
});

describe("parseOccupancyCsv — タブ区切り（DECISIONS #211）", () => {
  it("カンマ区切りと同じ結果になる", () => {
    const csvLines = [HEADER, `303,${DATE},true,2,RSV-8891,,,false,1,3,false`].join("\n");
    const tsvLines = csvLines.replace(/,/g, "\t");

    expect(parseOccupancyCsv(tsvLines, DATE)).toEqual(parseOccupancyCsv(csvLines, DATE));
  });
});
