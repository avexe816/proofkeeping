import { NotFoundError, listEnabledModules } from "@pk/db";
import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";

import { t, type MessageKey } from "../../lib/i18n.js";
import { listSelectableProperties, resolveSelectedScope } from "../../lib/property/selection.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";
import { buildSettingsHub } from "../../ui/navigation.js";

/**
 * 設定ハブ（人間の指示 2026-08-20 / 案 2）。
 *
 *   /app/settings
 *
 * ── 何をする画面か ──────────────────────────────────────
 * **既存の設定画面への入口を 1 枚に集めるだけ。** 設定そのものは
 * 従来どおり各画面が持つ。URL も権限も業務のルールも変えていない。
 *
 * サイドバーの設定セクションは画面が増えるたびに伸びて 15 項目になった。
 * ここへ寄せて、サイドバーは「⚙ 設定」1 項目にする。
 *
 * ── 出す・出さないは 1 か所で決める ──────────────────────
 * カードの取捨は `buildSettingsHub()`（`ui/navigation.ts`）が行う。
 * **サイドバーと同じ判定**なので、入口とカードの見え方がずれない。
 *
 * | 状態 | 見え方 |
 * |---|---|
 * | 権限が無い | **カードごと消す**（404 の世界。存在を示唆しない） |
 * | 契約が無い | グレー＋案内（買えば使える。402） |
 *
 * **ここでの非表示は権限制御ではない**（security.md §1）。各設定画面は
 * 従来どおり `assertPermission()` を通る。この画面はその門を代行しない。
 *
 * ── 1 枚も無ければ 404 ──────────────────────────────────
 * 開ける設定が 1 つも無い相手にこの画面を見せない。**403 にしない**
 * （403 は資源の存在を示唆する — architecture.md §2 第 2 層と同じ理由）。
 */

interface SettingsCard {
  key: MessageKey;
  note: MessageKey | null;
  icon: string;
  href: string | null;
  locked: boolean;
}

interface SettingsCategoryView {
  key: string;
  label: MessageKey;
  icon: string;
  cards: readonly SettingsCard[];
}

export interface SettingsHubData {
  categories: readonly SettingsCategoryView[];
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<SettingsHubData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  // 施設スコープの設定（客室マスタなど）は表示中の施設で判定する。
  // 解決の仕方は `routes/app/layout.tsx` と同じ（セッション → 既定施設）。
  const properties = await listSelectableProperties(env, tenant);
  const { property } = resolveSelectedScope(session.selectedPropertyId, tenant, properties);
  const selectedPropertyId = property?.id ?? null;
  const enabledModules = await listEnabledModules(env, tenant, selectedPropertyId);

  const categories = buildSettingsHub(tenant, { selectedPropertyId, enabledModules }).map(
    (category) => ({
      key: category.key,
      label: category.label,
      icon: category.icon,
      cards: category.items.map((entry) => ({
        key: entry.item.key,
        note: entry.item.note ?? null,
        icon: entry.item.icon,
        href: entry.href,
        locked: entry.locked,
      })),
    }),
  );

  // 開ける設定が 1 つも無い（現場ロールなど）。**存在ごと隠す。**
  if (categories.length === 0) throw new NotFoundError("RESOURCE_NOT_FOUND");

  return { categories };
}

export default function SettingsHubScreen() {
  const data = useLoaderData<SettingsHubData>();

  return (
    <div className="pk-page">
      <div className="pk-pagehead">
        <div>
          <h1 className="pk-pagehead__title">{t("settings.hub.title")}</h1>
          <p className="pk-pagehead__sub">{t("settings.hub.lede")}</p>
        </div>
      </div>

      {data.categories.map((category) => (
        <section className="pk-panel" key={category.key}>
          <div className="pk-panel__head">
            <span aria-hidden="true" className="pk-panel__icon">
              {category.icon}
            </span>
            {t(category.label)}
            {/* 補間を持たない `t()` の作法（i18n.ts の注記）。
                数は要素として組み、単位だけを文言から引く。 */}
            <span className="pk-panel__note">
              {category.cards.length}
              {t("settings.hub.unit.count")}
            </span>
          </div>
          <div className="pk-panel__body">
            <div className="pk-tiles">
              {category.cards.map((card) => (
                <SettingsTile card={card} key={card.key} />
              ))}
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * カード 1 枚。**未契約はリンクにしない**（サイドバーの
 * `pk-nav--locked` と同じ扱い。押せる見た目にすると 402 へ誘導する）。
 */
function SettingsTile({ card }: { card: SettingsCard }) {
  const body = (
    <>
      <span aria-hidden="true" className="pk-tile__icon">
        {card.icon}
      </span>
      <span className="pk-tile__body">
        <span className="pk-tile__name">{t(card.key)}</span>
        {card.note === null ? null : <span className="pk-tile__note">{t(card.note)}</span>}
      </span>
    </>
  );

  if (card.locked || card.href === null) {
    return (
      <span className="pk-tile pk-tile--locked" title={t("nav.locked.notice")}>
        {body}
        <span className="pk-tile__badge">{t("nav.locked")}</span>
      </span>
    );
  }

  return (
    <Link className="pk-tile" to={card.href}>
      {body}
    </Link>
  );
}
