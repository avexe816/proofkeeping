/**
 * 現場画面（`/m/*`）の外枠。
 *
 * task:  docs/tasks/P1-08.md 〜 P1-13
 * ルール: .claude/rules/ui-writing.md §3, §5
 *
 * ```
 * ┌────────────────────────────┐
 * │ ⚠ オフライン ・ 送信待ち 3件 │ ← 該当時のみ（§9.2 / §8）
 * ├────────────────────────────┤
 * │ ホーム画面に追加すると…      │ ← iOS Safari のタブのみ（§8.5）
 * ├────────────────────────────┤
 * │ 各画面（M-02 / M-03 / M-04）│
 * └────────────────────────────┘
 * ```
 *
 * ── サイドバーもタブバーも置いていない ──────────────────
 * プロトタイプ（pk-02）は下部に 4 つのタブ（タスク・検査・実績・設定）を
 * 描くが、**その 3 画面はまだ無い**（検査は P2、実績は P1-17、設定は
 * P1-18）。押しても何も起きないタブを置かない。**画面が揃った task が
 * ここへタブバーを足すこと。**
 *
 * ── 送信キューはここで 1 つだけ動かす ───────────────────
 * `useOfflineQueue()` は購読と 30 秒ポーリングを始める。**画面ごとに
 * 呼ばない。** 2 つ動くと flush が二重に走り、写真を 2 回送る。
 */

import { Outlet, useLoaderData, type LinksFunction, type LoaderFunctionArgs } from "react-router";

import { createTranslator, type Locale } from "../../lib/i18n.js";
import { requireMobileContext } from "../../lib/mobile/session.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { InstallBanner } from "../../ui/mobile/InstallBanner.js";
import { OfflineBar } from "../../ui/mobile/OfflineBar.js";
import { useOfflineQueue } from "../../ui/mobile/useOfflineQueue.js";
import mobileStylesHref from "../../styles/mobile.css?url";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: mobileStylesHref }];

export interface MobileShellData {
  locale: Locale;
  displayName: string;
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<MobileShellData> {
  const { locale, displayName } = await requireMobileContext(getEnv(context), request, new Date());
  return { locale, displayName };
}

export default function MobileShell(): React.ReactElement {
  const data = useLoaderData<MobileShellData>();
  const t = createTranslator(data.locale);
  const queue = useOfflineQueue();

  return (
    <div className="pk-m">
      <OfflineBar t={t} state={queue.state} offline={queue.offline} onSend={queue.sendNow} />
      <InstallBanner t={t} />
      <Outlet />
    </div>
  );
}
