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
 *
 * ── セクション（見出し）と親（束）で既定が逆 ────────────
 * 2 段になったナビ（人間の指示 2026-08-20）では、**セクションは開いた形が
 * 既定・親は閉じた形が既定。** そこで残すものも逆にする。
 *
 * | 対象 | 既定 | 保存するもの | キー |
 * |---|---|---|---|
 * | セクション見出し | 開く | **閉じた**もの | `pk.sidebar.closedSections` |
 * | 親（束） | 閉じる | **開いた**もの | `pk.sidebar.openGroups` |
 *
 * どちらも「既定から外れたものだけ」を残す形なので、項目が増減しても
 * 保存値が古びない（読むときに現在の一覧で漉す）。
 */

/** 閉じているセクションを残す `localStorage` のキー。 */
export const CLOSED_SECTIONS_STORAGE_KEY = "pk.sidebar.closedSections";

/** 開いている親（束）を残す `localStorage` のキー。 */
export const OPEN_GROUPS_STORAGE_KEY = "pk.sidebar.openGroups";

/**
 * 名前の一覧を読む。**辞書に無い値は捨てる**（古い保存値・手で
 * 書き換えられた値を後段へ持ち越さない）。読めなければ空。
 */
function readNames(
  storage: Pick<Storage, "getItem"> | null,
  storageKey: string,
  valid: readonly string[],
): readonly string[] {
  if (storage === null) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(storageKey);
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
  const known = new Set(valid);
  return value.filter((entry): entry is string => typeof entry === "string" && known.has(entry));
}

/** 名前の一覧を書く。書けない環境では何もしない。 */
function writeNames(
  storage: Pick<Storage, "setItem"> | null,
  storageKey: string,
  names: readonly string[],
): void {
  if (storage === null) return;
  try {
    storage.setItem(storageKey, JSON.stringify(names));
  } catch {
    // プライベートブラウズ等。開閉が保存されないだけで、操作は成立する。
  }
}

/**
 * 閉じているセクションの一覧を読む。
 *
 * @param validSections 現在描画しているセクション。
 */
export function readClosedSections(
  storage: Pick<Storage, "getItem"> | null,
  validSections: readonly string[],
): readonly string[] {
  return readNames(storage, CLOSED_SECTIONS_STORAGE_KEY, validSections);
}

/** 閉じているセクションの一覧を書く。書けない環境では何もしない。 */
export function writeClosedSections(
  storage: Pick<Storage, "setItem"> | null,
  sections: readonly string[],
): void {
  writeNames(storage, CLOSED_SECTIONS_STORAGE_KEY, sections);
}

/**
 * 開いている親（束）の一覧を読む。**既定は閉じている**ので、
 * 保存が無い環境では空（＝全部閉じる）に倒れる。
 *
 * @param validGroups 現在描画している親。
 */
export function readOpenGroups(
  storage: Pick<Storage, "getItem"> | null,
  validGroups: readonly string[],
): readonly string[] {
  return readNames(storage, OPEN_GROUPS_STORAGE_KEY, validGroups);
}

/** 開いている親（束）の一覧を書く。書けない環境では何もしない。 */
export function writeOpenGroups(
  storage: Pick<Storage, "setItem"> | null,
  groups: readonly string[],
): void {
  writeNames(storage, OPEN_GROUPS_STORAGE_KEY, groups);
}

/**
 * 一覧の中身を反転する。**セクション（閉じたもの）と親（開いたもの）の
 * どちらにも使う。** 入っていれば外し、無ければ足すだけ。
 */
export function toggleSection(names: readonly string[], name: string): readonly string[] {
  return names.includes(name) ? names.filter((entry) => entry !== name) : [...names, name];
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
