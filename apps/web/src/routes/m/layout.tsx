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
 * ── タブバーは最大 4 つ ─────────────────────────────────
 * プロトタイプ（pk-02）は下部に 4 つのタブ（タスク・検査・実績・設定）を
 * 描く。タスク・客室・実績が P1、**検査は P2-05 が足した。**
 * **押しても何も起きないタブを置かないこと。**
 * 設定は独立したタブにせず、実績の画面に言語切替を置いた（§12.3 が
 * 「M-11 の設定画面から変更できる」と定めるため）。
 *
 * ── 検査タブはロールで出し分ける ────────────────────────
 * `CLEANER` は `inspection.read` が DENY で、開いても 404 になる（P2-04）。
 * **404 になるタブを見せない。** ただしこれは UX 上の措置であって権限制御
 * ではない（security.md §1）。判定は画面側の `assertPermission()` が行う。
 *
 * ── 送信キューはここで 1 つだけ動かす ───────────────────
 * `useOfflineQueue()` は購読と 30 秒ポーリングを始める。**画面ごとに
 * 呼ばない。** 2 つ動くと flush が二重に走り、写真を 2 回送る。
 */

import {
  NavLink,
  Outlet,
  useLoaderData,
  type LinksFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { can, propertyTarget } from "../../lib/auth/permission.js";
import { createTranslator, type Locale, type MessageKey } from "../../lib/i18n.js";
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
  /** 検査タブを出すか（`inspection.read` を持つロールだけ）。 */
  canInspect: boolean;
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<MobileShellData> {
  const { locale, displayName, tenant } = await requireMobileContext(
    getEnv(context),
    request,
    new Date(),
  );
  return {
    locale,
    displayName,
    // `can()` は throw しない版。**これで分岐したからといって画面側の
    // `assertPermission()` を省かないこと**（security.md §1）。
    canInspect: can(tenant, "inspection.read", propertyTarget(tenant.allowedPropertyIds)),
  };
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

      {/* タップ領域 48px 以上（INV-25）。CSS は mobile.css の `.pk-m-tabs`。 */}
      <nav className="pk-m-tabs">
        {mobileTabs(data.canInspect).map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              isActive ? "pk-m-tabs__item pk-m-tabs__item--on" : "pk-m-tabs__item"
            }
          >
            {t(tab.key)}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

/**
 * 下部タブ（`ui-prototypes/mobile/pk-02-today-tasks.html`）。
 *
 * **到達先の無いタブを置かない。** 検査（M-08）は P2-05 が足した。
 * 並びはプロトタイプどおり「タスク → 検査 → …」。
 */
function mobileTabs(canInspect: boolean): readonly { to: string; key: MessageKey }[] {
  return [
    { to: "/m/today", key: "m.tab.tasks" },
    ...(canInspect ? [{ to: "/m/inspections", key: "m.tab.inspections" as MessageKey }] : []),
    { to: "/m/board", key: "m.tab.board" },
    { to: "/m/me", key: "m.tab.me" },
  ];
}
