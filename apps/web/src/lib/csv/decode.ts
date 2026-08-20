/**
 * CSV ファイルのバイト列 → 文字列（W-05 のファイル取込 / DECISIONS #211）。
 *
 * ── なぜデコードを自前で持つのか ────────────────────────
 * 貼り付け（クリップボード）は常に文字列だが、**ファイルで受けると
 * 文字コードが利用者の PMS 次第になる。** 国内 PMS の CSV 出力は
 * Shift_JIS が多く、UTF-8 前提で読むと日本語の列（施設名・備考）が
 * 化けたまま取り込まれる。
 *
 * ── 判定は「UTF-8 として妥当か」だけ ────────────────────
 * 1. UTF-8（fatal）で読めたらそれを採る。ASCII のみのファイルもここで決まる
 *    （ASCII は Shift_JIS でも同じ値なので、どちらに倒れても結果は変わらない）。
 * 2. 読めなければ Shift_JIS として読む。**言語ヒューリスティックを足さない。**
 *    UTF-8 として不正なバイト列を持つ日本語 CSV の実質的な候補は
 *    Shift_JIS（CP932）だけで、当てにいく推測は誤読の余地を増やすだけ。
 * 3. Shift_JIS デコーダが無い実行環境では、置換文字つきの UTF-8 に落とす。
 *    **黙って例外で全体を落とさない**（1 行の誤りで全体を落とさない、と同じ方針）。
 */

/** ファイル取込の上限。1 施設 1 日ぶんの客室 CSV は数十 KB で足りる。 */
export const MAX_CSV_FILE_BYTES = 1_048_576;

export function decodeCsvBuffer(buffer: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    // UTF-8 として不正 → Shift_JIS を試す。
  }
  try {
    return new TextDecoder("shift_jis").decode(buffer);
  } catch {
    // デコーダ非対応の環境。読める範囲だけでも返す（置換文字 U+FFFD 入り）。
    return new TextDecoder("utf-8").decode(buffer);
  }
}
