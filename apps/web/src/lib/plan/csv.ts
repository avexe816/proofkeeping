/**
 * 当日の客室状況の CSV 取込（PK-SPEC-P1 §3.4）。**純粋関数。**
 *
 * task: docs/tasks/P1-04.md
 *
 * ```
 * room_number,business_date,has_checkout,has_checkin,is_stayover,guest_count,decline_clean
 * 302,2026-09-01,true,true,false,2,false
 * ```
 *
 * ── 1 行の誤りで全体を落とさない ────────────────────────
 * 前日の夜に PMS から出した CSV を取り込む運用（§3.4）。1 行の書式違いで
 * 100 行が取り込めないと、現場は入力そのものを諦める。**読めた行は取り込み、
 * 読めなかった行の番号を返す。** 画面が「N 行を取り込めませんでした」と
 * 事実として示す（PK-IMPL-CONTRACT §11.3）。
 *
 * ── 保存しない列 ────────────────────────────────────────
 * 宿泊者名・予約者名の列が CSV に混ざっていても**読まない。**
 * 未知の列は無視する（security.md §3）。
 */

import {
  BUSINESS_DATE_PATTERN,
  findCsvHeader,
  parseCsvBoolean,
  splitCsvLine,
} from "../csv/reader.js";

/** CSV の 1 行（客室番号は解決前）。 */
export interface ParsedPlanRow {
  roomNumber: string;
  businessDate: string;
  hasCheckout: boolean;
  hasCheckin: boolean;
  isStayover: boolean;
  guestCount: number;
  declineClean: boolean;
}

/** 取込結果。 */
export interface ParsedCsv {
  rows: ParsedPlanRow[];
  /** 読めなかった行の番号（1 始まり・ヘッダ行を含めて数える）。 */
  skippedLines: number[];
}

/** 読み取る列（§3.4 の 7 列）。**これ以外の列は無視する。** */
type Column =
  | "room_number"
  | "business_date"
  | "has_checkout"
  | "has_checkin"
  | "is_stayover"
  | "guest_count"
  | "decline_clean";

/** 人数。**負値と非数は 0 にする。** 取り込みを落とすほどの誤りではない。 */
function parseCount(raw: string): number {
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 99) : 0;
}

/**
 * CSV を読む。
 *
 * @param businessDate 取込先の業務日。**CSV 側の `business_date` がこれと
 *   違う行は読み飛ばす。** 別の日のデータを黙って今日へ入れると、
 *   翌日ぶんの計画を上書きしてしまう。
 */
export function parsePlanCsv(csv: string, businessDate: string): ParsedCsv {
  const lines = csv.split(/\r?\n/);
  const rows: ParsedPlanRow[] = [];
  const skippedLines: number[] = [];

  const header = findCsvHeader(lines, "room_number");
  if (header.index === -1) return { rows, skippedLines };

  const at = (cells: string[], column: Column): string => {
    const position = header.columns.get(column);
    return position === undefined ? "" : (cells[position] ?? "");
  };

  for (let index = header.index + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.trim() === "") continue;

    const cells = splitCsvLine(line, header.delimiter);
    const roomNumber = at(cells, "room_number").trim();
    if (roomNumber === "") {
      skippedLines.push(index + 1);
      continue;
    }

    const rowDate = at(cells, "business_date").trim();
    // 日付列が空なら取込先の業務日とみなす。書いてあって違う日なら飛ばす。
    if (rowDate !== "" && (!BUSINESS_DATE_PATTERN.test(rowDate) || rowDate !== businessDate)) {
      skippedLines.push(index + 1);
      continue;
    }

    rows.push({
      roomNumber,
      businessDate,
      hasCheckout: parseCsvBoolean(at(cells, "has_checkout")),
      hasCheckin: parseCsvBoolean(at(cells, "has_checkin")),
      isStayover: parseCsvBoolean(at(cells, "is_stayover")),
      guestCount: parseCount(at(cells, "guest_count")),
      declineClean: parseCsvBoolean(at(cells, "decline_clean")),
    });
  }

  return { rows, skippedLines };
}
