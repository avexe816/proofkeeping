/**
 * ホーム画面追加の案内（PK-SPEC-P1 §8.5）。
 *
 * task: docs/tasks/P1-13.md
 *
 * ── 見ているもの ────────────────────────────────────────
 *   iOS Safari のタブで開いた場合**のみ**出る
 *   1 回閉じたら 30 日出ない（§8.5 MUST）
 */

import { describe, expect, it } from "vitest";

import {
  DISMISS_PERIOD_MS,
  isIosSafari,
  readDismissedAt,
  shouldShowInstallBanner,
  writeDismissedAt,
} from "./installBanner.js";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/126.0 Mobile Safari/537.36";
const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Safari/605.1.15";

const NOW = 1_800_000_000_000;

describe("isIosSafari", () => {
  it("iPhone の Safari は true", () => {
    expect(isIosSafari(IPHONE_SAFARI)).toBe(true);
  });

  it("iOS の Chrome（CriOS）は false — 追加の導線が違う", () => {
    expect(isIosSafari(IPHONE_CHROME)).toBe(false);
  });

  it("Android は false", () => {
    expect(isIosSafari(ANDROID_CHROME)).toBe(false);
  });

  it("Mac の Safari は false", () => {
    expect(isIosSafari(MAC_SAFARI)).toBe(false);
  });
});

describe("shouldShowInstallBanner", () => {
  it("iOS Safari のタブで、閉じたことが無ければ出す", () => {
    expect(
      shouldShowInstallBanner({
        userAgent: IPHONE_SAFARI,
        isStandalone: false,
        dismissedAt: null,
        now: NOW,
      }),
    ).toBe(true);
  });

  it("すでにホーム画面から起動していれば出さない", () => {
    expect(
      shouldShowInstallBanner({
        userAgent: IPHONE_SAFARI,
        isStandalone: true,
        dismissedAt: null,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("閉じてから 30 日未満は出さない（§8.5 MUST）", () => {
    expect(
      shouldShowInstallBanner({
        userAgent: IPHONE_SAFARI,
        isStandalone: false,
        dismissedAt: NOW - DISMISS_PERIOD_MS + 1,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("30 日が過ぎたらまた出す", () => {
    expect(
      shouldShowInstallBanner({
        userAgent: IPHONE_SAFARI,
        isStandalone: false,
        dismissedAt: NOW - DISMISS_PERIOD_MS,
        now: NOW,
      }),
    ).toBe(true);
  });

  it("iOS Safari 以外では、閉じていなくても出さない", () => {
    for (const userAgent of [IPHONE_CHROME, ANDROID_CHROME, MAC_SAFARI]) {
      expect(
        shouldShowInstallBanner({ userAgent, isStandalone: false, dismissedAt: null, now: NOW }),
      ).toBe(false);
    }
  });
});

describe("readDismissedAt / writeDismissedAt", () => {
  /** `localStorage` の代役。**例外を投げる版も試す。** */
  function fakeStorage(initial?: string): Storage & { value: string | null } {
    const state: { value: string | null } = { value: initial ?? null };
    return {
      value: state.value,
      getItem: () => state.value,
      setItem: (_key: string, next: string) => {
        state.value = next;
      },
    } as unknown as Storage & { value: string | null };
  }

  it("保存した時刻を読み戻せる", () => {
    const storage = fakeStorage();
    writeDismissedAt(storage, NOW);
    expect(readDismissedAt(storage)).toBe(NOW);
  });

  it("storage が無い環境では閉じていない扱い", () => {
    expect(readDismissedAt(null)).toBeNull();
    expect(() => {
      writeDismissedAt(null, NOW);
    }).not.toThrow();
  });

  it("壊れた値は閉じていない扱い", () => {
    expect(readDismissedAt(fakeStorage("abc"))).toBeNull();
    expect(readDismissedAt(fakeStorage("-1"))).toBeNull();
  });

  it("読み書きが例外を投げても落ちない（プライベートブラウズ）", () => {
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    } as unknown as Storage;
    expect(readDismissedAt(throwing)).toBeNull();
    expect(() => {
      writeDismissedAt(throwing, NOW);
    }).not.toThrow();
  });
});
