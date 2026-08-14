/**
 * 客室の自動マッピング（PK-SPEC-P6 §2.3 / §7.2）。**純粋関数。**
 *
 * task: docs/tasks/P6-05.md
 *
 * ```
 * 自動マッピング: 部屋番号が一致するものを自動対応  [ 実行 ]
 *
 * ProofKeeping        外部システム         状態
 * 302  ツイン    ←→  302                  ○
 * 303  シングル  ←→  303                  ○
 * 305  ダブル    ←→  0305                 ○（手動設定）
 * —                  9001                 ✕ 未マッピング
 * 601  ツイン    ←→  —                    ✕ 未マッピング
 * ```
 *
 * ── 一致の条件を広げない ────────────────────────────────
 * **`305` と `0305` を自動で結ばない。** §7.2 の表がまさにその組を
 * 「手動設定」として描いており、**仕様は前ゼロを一致とみなしていない。**
 * 広げれば当たる件数は増えるが、外れたときに起きるのは
 * **「別の客室の稼働記録を取り込む」**ことで、差異レポートが静かに
 * 嘘をつく。誤りの向きが悪すぎるので、確実なものだけを結ぶ
 * （§9 のリスク表「客室番号の表記ゆれ → 自動マッピング＋手動修正 UI」の
 * 後半が、この方針を前提にしている / docs/DECISIONS.md #142）。
 *
 * 正規化するのは**前後の空白と全角英数**まで。全角の `３０２` は
 * 日本語入力の副産物で、別の部屋を指す可能性が無い。
 *
 * ── 「未マッピングをエラーにしない」（§2.3 MUST）────────
 * 結べなかったものは例外ではなく**結果として返す。** 呼び出し側が
 * W-23 の右端（`✕ 未マッピング`）と W-13 の「未マッピング N 件」に出す。
 *
 * ── 既にある対応を上書きしない ──────────────────────────
 * 手で直した対応（`305 ←→ 0305`）を再実行が壊さないこと。
 * `alreadyMappedInternalIds` / `alreadyMappedExternalIds` に載っている
 * ものは候補から外す。**書き込み側（`upsertExternalMappings()`）でも
 * 同じことを見ている**が、こちらで外しておかないと W-23 の
 * 「今回 N 件を対応付けます」が実際より多い数を出す。
 */

/** 突き合わせる 1 件（内側・外側で同じ形）。 */
export interface AutoMapCandidate {
  /** ProofKeeping 側なら `room.id`、外部システム側なら外部 ID。 */
  id: string;
  /** 突き合わせに使う部屋番号。 */
  number: string;
  /** 画面に出す補助表示（客室タイプ名など）。 */
  label?: string | undefined;
}

/** `autoMapRooms()` の入力。 */
export interface AutoMapInput {
  /** ProofKeeping 側の客室。 */
  internal: readonly AutoMapCandidate[];
  /** 外部システム側の客室。アダプタの `listRooms()`、または利用者の入力。 */
  external: readonly AutoMapCandidate[];
  /** 既に対応が付いている `room.id`。**候補から外す。** */
  alreadyMappedInternalIds?: ReadonlySet<string> | undefined;
  /** 既に対応が付いている外部 ID。**候補から外す。** */
  alreadyMappedExternalIds?: ReadonlySet<string> | undefined;
}

/** 結べた 1 組。 */
export interface AutoMapPair {
  internalId: string;
  externalId: string;
  /** 外部システム側の表示名。`externalMapping.externalLabel` に入る。 */
  externalLabel: string | null;
  /** 突き合わせに使った正規化後の部屋番号。 */
  matchedOn: string;
}

/** `autoMapRooms()` の結果。 */
export interface AutoMapResult {
  /** 新しく結べた組。**並びは `internal` の入力順。** */
  pairs: AutoMapPair[];
  /** 相手が見つからなかった ProofKeeping 側の客室（W-23 の `601 ←→ —`）。 */
  unmatchedInternal: AutoMapCandidate[];
  /** 相手が見つからなかった外部システム側の客室（W-23 の `— ←→ 9001`）。 */
  unmatchedExternal: AutoMapCandidate[];
  /**
   * 同じ番号が片側に 2 つ以上あって結べなかった番号。
   *
   * **どちらを選ぶか決められないので、両方とも未マッピングにする。**
   * 片方を勝手に選ぶと、外れたときに気づけない（上の注記と同じ理由）。
   */
  ambiguous: string[];
}

/**
 * 突き合わせ用に部屋番号を揃える。
 *
 * **前ゼロを落とさない。** `305` と `0305` は別の鍵になる（上の注記）。
 * 行うのは前後の空白の除去と、全角英数字の半角化、英字の大文字化まで。
 */
export function normalizeRoomKey(value: string): string {
  return value
    .trim()
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (char) =>
      String.fromCharCode(char.charCodeAt(0) - 0xfee0),
    )
    .toUpperCase();
}

/** 番号 → 候補。同じ番号が 2 つ以上ある番号は `null` を立てる。 */
function indexByNumber(
  candidates: readonly AutoMapCandidate[],
): Map<string, AutoMapCandidate | null> {
  const index = new Map<string, AutoMapCandidate | null>();
  for (const candidate of candidates) {
    const key = normalizeRoomKey(candidate.number);
    if (key === "") continue; // 番号の無い客室は突き合わせられない
    index.set(key, index.has(key) ? null : candidate);
  }
  return index;
}

/**
 * 部屋番号が一致するものを結ぶ（§7.2 の「実行」）。
 *
 * **同じ入力から必ず同じ結果が出る。** 並びは入力順のまま。
 */
export function autoMapRooms(input: AutoMapInput): AutoMapResult {
  const takenInternal = input.alreadyMappedInternalIds ?? new Set<string>();
  const takenExternal = input.alreadyMappedExternalIds ?? new Set<string>();

  const internal = input.internal.filter((row) => !takenInternal.has(row.id));
  const external = input.external.filter((row) => !takenExternal.has(row.id));

  const externalByNumber = indexByNumber(external);
  const internalByNumber = indexByNumber(internal);

  const pairs: AutoMapPair[] = [];
  const ambiguous = new Set<string>();
  const matchedInternalIds = new Set<string>();
  const matchedExternalIds = new Set<string>();

  for (const room of internal) {
    const key = normalizeRoomKey(room.number);
    if (key === "") continue;

    // 内側で番号が重複していれば、外側が 1 つでも結べない。
    if (internalByNumber.get(key) === null) {
      ambiguous.add(key);
      continue;
    }

    const counterpart = externalByNumber.get(key);
    if (counterpart === undefined) continue;
    if (counterpart === null) {
      ambiguous.add(key);
      continue;
    }

    pairs.push({
      internalId: room.id,
      externalId: counterpart.id,
      externalLabel: counterpart.label ?? null,
      matchedOn: key,
    });
    matchedInternalIds.add(room.id);
    matchedExternalIds.add(counterpart.id);
  }

  return {
    pairs,
    unmatchedInternal: internal.filter((row) => !matchedInternalIds.has(row.id)),
    unmatchedExternal: external.filter((row) => !matchedExternalIds.has(row.id)),
    ambiguous: [...ambiguous].sort(),
  };
}
