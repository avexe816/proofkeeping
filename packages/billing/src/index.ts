// 料金計算の純粋関数。金額はすべて整数（円）。料金の解決と税額計算は P5-04 以降。

// 書類番号の書式と会計年度の判定（P0-17）。採番そのものは
// DocumentSequencer（Durable Object）が行う。
export {
  DOCUMENT_NUMBER_DIGITS,
  DOCUMENT_NUMBER_PREFIXES,
  DOCUMENT_TYPES,
  documentSequencerName,
  fiscalYearOf,
  formatDocumentNumber,
  type DocumentType,
} from "./documentNumber.js";
