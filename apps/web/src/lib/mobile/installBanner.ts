/**
 * ホーム画面追加の案内（PK-SPEC-P1 §8.5）。**純粋関数。**
 *
 * task:  docs/tasks/P1-13.md
 * ルール: .claude/rules/ui-writing.md §5
 *
 * ── なぜ勧めるのか ──────────────────────────────────────
 * iOS Safari のタブは、7 日間操作が無いと IndexedDB を落とす（§8.1）。
 * ホーム画面に追加した PWA はこの eviction の対象外になる。
 * **勧めはするが必須にしない。** 追加していない端末でも、その日のうちに
 * 送信されれば業務は成立する（§8.1）。
 *
 * ── 出す条件を 1 か所に閉じる ───────────────────────────
 * 「iOS の Safari で」「タブとして開いていて」「30 日以内に閉じていない」
 * の 3 つが揃ったときだけ。画面側で `navigator.userAgent` を読み始めると
 * 条件が散らばる。ここが唯一の判定点。
 */

/** 一度閉じたら再表示しない期間（§8.5 MUST）。 */
export const DISMISS_DAYS = 30;

export const DISMISS_PERIOD_MS = DISMISS_DAYS * 24 * 60 * 60 * 1000;

/** 閉じた時刻を残す `localStorage` のキー。 */
export const DISMISS_STORAGE_KEY = "pk.installBanner.dismissedAt";

/** 判定に使う端末の状態。**画面から集めてここへ渡す。** */
export interface InstallBannerInput {
  userAgent: string;
  /** ホーム画面から起動しているか（`display-mode: standalone`）。 */
  isStandalone: boolean;
  /** 前回閉じた時刻（epoch ミリ秒）。閉じていなければ `null`。 */
  dismissedAt: number | null;
  now: number;
}

/**
 * iOS の Safari か。
 *
 * iPadOS は既定でデスクトップ表示になり `Macintosh` を名乗る。**タッチ点を
 * 見るのが唯一の見分けだが、UA 文字列だけで判定できる範囲に留める。**
 * 誤って出しても案内が 1 つ増えるだけで、業務は壊れない。
 *
 * Chrome / Firefox / Edge の iOS 版（`CriOS` / `FxiOS` / `EdgiOS`）は
 * **除く。** iOS ではホーム画面への追加が Safari の共有メニューにしか無く、
 * 他のブラウザで「共有ボタン → ホーム画面に追加」と案内すると迷わせる。
 */
export function isIosSafari(userAgent: string): boolean {
  const isIos = /iPhone|iPad|iPod/.test(userAgent);
  if (!isIos) return false;
  if (/CriOS|FxiOS|EdgiOS|OPiOS/.test(userAgent)) return false;
  return /Safari/.test(userAgent);
}

/** 案内を出すか（§8.5）。 */
export function shouldShowInstallBanner(input: InstallBannerInput): boolean {
  if (!isIosSafari(input.userAgent)) return false;
  // 既に追加済み。案内する相手ではない。
  if (input.isStandalone) return false;
  if (input.dismissedAt === null) return true;
  return input.now - input.dismissedAt >= DISMISS_PERIOD_MS;
}

/**
 * `localStorage` に残した閉じた時刻を読む。
 *
 * 壊れた値・読めない環境は「閉じていない」として扱う。**例外を投げない。**
 * プライベートブラウズでは `localStorage` へのアクセス自体が例外になりうる。
 */
export function readDismissedAt(storage: Pick<Storage, "getItem"> | null): number | null {
  if (storage === null) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(DISMISS_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** 閉じた時刻を残す。書けなくても黙って諦める（次回また出るだけ）。 */
export function writeDismissedAt(storage: Pick<Storage, "setItem"> | null, now: number): void {
  if (storage === null) return;
  try {
    storage.setItem(DISMISS_STORAGE_KEY, String(now));
  } catch {
    // 容量不足・プライベートブラウズ。案内が再び出るだけで害は無い。
  }
}
