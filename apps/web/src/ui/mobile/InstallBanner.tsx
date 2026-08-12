/**
 * ホーム画面追加の案内（PK-SPEC-P1 §8.5）。
 *
 * task: docs/tasks/P1-13.md
 *
 * ── 判定は `lib/mobile/installBanner.ts` ────────────────
 * ここは端末の状態を集めて渡すだけ。**条件をこのファイルへ書かない。**
 *
 * ── SSR では出さない ────────────────────────────────────
 * `userAgent` と `localStorage` はブラウザにしか無い。サーバー描画では
 * 常に非表示にし、最初の `useEffect` で判定する。**先に出して消す
 * （ちらつく）より、後から出るほうが現場の邪魔にならない。**
 */

import { useEffect, useState } from "react";

import type { Translator } from "../../lib/i18n.js";
import {
  readDismissedAt,
  shouldShowInstallBanner,
  writeDismissedAt,
} from "../../lib/mobile/installBanner.js";

export interface InstallBannerProps {
  t: Translator;
}

/** ホーム画面から起動しているか。iOS は `navigator.standalone` を持つ。 */
function isStandaloneDisplay(): boolean {
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function InstallBanner({ t }: InstallBannerProps): React.ReactElement | null {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      // プライベートブラウズ。閉じた記録を持てないので、毎回出る。
    }
    setVisible(
      shouldShowInstallBanner({
        userAgent: navigator.userAgent,
        isStandalone: isStandaloneDisplay(),
        dismissedAt: readDismissedAt(storage),
        now: Date.now(),
      }),
    );
  }, []);

  if (!visible) return null;

  const dismiss = (): void => {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      storage = null;
    }
    writeDismissedAt(storage, Date.now());
    setVisible(false);
  };

  return (
    <aside className="pk-m-install">
      <div className="pk-m-install__body">
        <b>{t("m.install.title")}</b>
        <div>{t("m.install.steps")}</div>
        {/* **必須ではないことを明示する**（§8.5 MUST）。 */}
        <span className="pk-m-install__optional">{t("m.install.optional")}</span>
      </div>
      <button
        type="button"
        className="pk-m-install__close"
        onClick={dismiss}
        aria-label={t("m.install.dismiss")}
      >
        ×
      </button>
    </aside>
  );
}
