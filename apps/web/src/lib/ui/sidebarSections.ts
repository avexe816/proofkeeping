/**
 * サイドバーのセクション開閉（PK-SPEC-UI-A01 §4.4 / P7-21）。**純粋関数。**
 *
 * task: docs/tasks/P7-21.md
 *
 * ── 端末に持つ・サーバーに持たない ──────────────────────
 * 折りたたみ（レール）はセッションに持つが、セクションの開閉は端末の
 * `localStorage` に持つ。SSR は常に**全展開**で描画し、閉じた選択だけを
 * hydration 後に反映する（閉じる方向にだけ後から効くので、リンクが
 * 「消えてから現れる」ちらつきにならない — A01 §4.4）。
 *
 * ── 例外を投げない ──────────────────────────────────────
 * プライベートブラウズでは `localStorage` へのアクセス自体が例外になりうる。
 * 読めない・書けない環境では「全展開」に倒す（`installBanner.ts` と同じ流儀）。
 */

/** 閉じているセクションを残す `localStorage` のキー。 */
export const CLOSED_SECTIONS_STORAGE_KEY = "pk.sidebar.closedSections";

/**
 * 閉じているセクションの一覧を読む。
 *
 * @param validSections 現在描画しているセクション。**辞書に無い値は捨てる**
 *   （古い保存値・手で書き換えられた値を後段へ持ち越さない）。
 */
export function readClosedSections(
  storage: Pick<Storage, "getItem"> | null,
  validSections: readonly string[],
): readonly string[] {
  if (storage === null) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(CLOSED_SECTIONS_STORAGE_KEY);
  } catch {
    return [];
  }
  if (raw === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const valid = new Set(validSections);
  return value.filter((entry): entry is string => typeof entry === "string" && valid.has(entry));
}

/** 閉じているセクションの一覧を書く。書けない環境では何もしない。 */
export function writeClosedSections(
  storage: Pick<Storage, "setItem"> | null,
  sections: readonly string[],
): void {
  if (storage === null) return;
  try {
    storage.setItem(CLOSED_SECTIONS_STORAGE_KEY, JSON.stringify(sections));
  } catch {
    // プライベートブラウズ等。開閉が保存されないだけで、操作は成立する。
  }
}

/** セクションの開閉を反転した一覧を返す。 */
export function toggleSection(closed: readonly string[], section: string): readonly string[] {
  return closed.includes(section)
    ? closed.filter((entry) => entry !== section)
    : [...closed, section];
}

/** `window.localStorage` を例外を握って取る。SSR・拒否環境では `null`。 */
export function safeLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
