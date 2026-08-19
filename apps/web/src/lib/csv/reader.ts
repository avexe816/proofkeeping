/**
 * CSV の読み取り共通部分。**純粋関数。**
 *
 * task: docs/tasks/P4-02.md（`lib/plan/csv.ts` から切り出した）
 *
 * ── なぜ共通化したか ────────────────────────────────────
 * 取込の口が 2 つになった（当日の客室状況 / 稼働記録）。**行の割り方と
 * BOM の扱いを 2 か所に持つと、片方だけ直したときに「同じ CSV を
 * 別の口へ入れると結果が違う」という状態になる。** 列の意味づけは
 * それぞれの取込側が持ち、ここは字句の解釈だけを持つ。
 *
 * ── ここに列の知識を置かない ────────────────────────────
 * 「どの列を読むか」「どの行を飛ばすか」は取込ごとに違う。
 * ここへ寄せると、片方の都合でもう片方の挙動が変わる。
 */

/**
 * 区切り文字。カンマ（CSV）とタブ（TSV）の 2 つだけを認める。
 *
 * タブを足したのは、**Excel で開いた CSV をコピーするとクリップボードが
 * タブ区切りになる**ため。カンマしか読めないと、貼り付けた表全体が
 * 1 セルに潰れてヘッダが見つからず、黙って 0 行になる。
 * セミコロン等は要望が出るまで足さない（区切りの推測を広げるほど、
 * 値の中の記号を区切りと誤読する余地が増える）。
 */
export type CsvDelimiter = "," | "\t";

/**
 * 1 行を列へ割る。**引用符つきの値に対応する。**
 * 施設名や備考にカンマが入った CSV でも列がずれない。
 */
export function splitCsvLine(line: string, delimiter: CsvDelimiter = ","): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char ?? "";
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      cells.push(cell);
      cell = "";
      continue;
    }
    cell += char ?? "";
  }
  cells.push(cell);
  return cells;
}

/**
 * 先頭の BOM を落とす。
 *
 * Excel が「CSV UTF-8」で書き出すと先頭に U+FEFF が付く。落とさないと
 * 1 列目のヘッダ名が一致せず、**ファイル全体が「ヘッダ無し」として
 * 0 行になる。**
 */
export function stripBom(line: string): string {
  return line.startsWith("﻿") ? line.slice(1) : line;
}

/** 真とみなす表記。**表計算ソフトの出力の揺れを吸収する。** */
const TRUE_VALUES: ReadonlySet<string> = new Set(["true", "1", "yes", "y", "○"]);

/** 偽とみなす表記。**空欄はここに含めない**（`parseCsvBooleanStrict` の判断が変わる）。 */
const FALSE_VALUES: ReadonlySet<string> = new Set(["false", "0", "no", "n", "×"]);

/**
 * 真偽値。**認識できない値と空欄は `false`。**
 *
 * 「書いていなければ偽」でよい列に使う。書いてあるかどうかで意味が
 * 変わる列には `parseCsvBooleanStrict()` を使うこと。
 */
export function parseCsvBoolean(raw: string): boolean {
  return TRUE_VALUES.has(raw.trim().toLowerCase());
}

/**
 * 真偽値。**認識できない値と空欄は `null`。**
 *
 * 既定値に倒すと意味が変わってしまう列に使う。稼働記録の `is_occupied` が
 * これで、空欄を「空室」と読むと**使われていない部屋という主張**になり、
 * R001（稼働記録のない使用痕跡）が根拠のない差異を出す（DECISIONS #107）。
 */
export function parseCsvBooleanStrict(raw: string): boolean | null {
  const value = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  return null;
}

/** ヘッダ行の位置と、列名 → 位置の対応、そして区切り文字。 */
export interface CsvHeader {
  /** 0 始まり。見つからなければ -1。 */
  index: number;
  columns: ReadonlyMap<string, number>;
  /**
   * ヘッダ行から判定した区切り文字。**データ行も必ずこれで割ること**
   * （`splitCsvLine(line, header.delimiter)`）。行ごとに推測し直すと、
   * 値にカンマを含む TSV の行だけ列がずれる。
   */
  delimiter: CsvDelimiter;
}

/** 区切りの候補。**カンマを先に試す**（仕様の例が CSV のため）。 */
const DELIMITERS: readonly CsvDelimiter[] = [",", "\t"];

/**
 * ヘッダ行を探す。
 *
 * `requiredColumn` を含む最初の非空行をヘッダとみなす。**先頭の非空行に
 * 無ければ探索を打ち切る**（データ行の途中に同名の値があっても拾わない）。
 * 列名は小文字化して前後の空白を落とす。区切りはカンマ → タブの順に試し、
 * `requiredColumn` が現れた方を採る。
 */
export function findCsvHeader(lines: readonly string[], requiredColumn: string): CsvHeader {
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    for (const delimiter of DELIMITERS) {
      const cells = splitCsvLine(stripBom(line), delimiter).map((cell) =>
        cell.trim().toLowerCase(),
      );
      if (!cells.includes(requiredColumn)) continue;
      return {
        index,
        columns: new Map(cells.map((cell, position) => [cell, position])),
        delimiter,
      };
    }
    break;
  }
  return { index: -1, columns: new Map(), delimiter: "," };
}

/** 業務日の形（architecture.md §7）。 */
export const BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
