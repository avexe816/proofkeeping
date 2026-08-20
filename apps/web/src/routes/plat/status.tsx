import { useLoaderData, type LoaderFunctionArgs } from "react-router";

import { t } from "../../lib/i18n.js";
import { requirePlatformOperator } from "../../lib/platform/requireOperator.js";
import { getEnv } from "../../lib/ui/cloudflare.js";

/**
 * サービス稼働（PF-01 では入口だけ / 中身は PF-03）。
 *
 *   /plat/status
 *
 * task: docs/tasks/PF-01.md
 *
 * **数字を捏造しない。** 稼働率・p95 の実測を集める仕組みが無いうちは
 * 「準備中」と言う（PF-03 の「出す元のある指標だけを並べる」の先取り）。
 * ここに仮の数字を置くと、PF-03 で「実測に見えていたもの」を剥がす作業になる。
 */

interface StatusData {
  displayName: string;
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<StatusData> {
  const env = getEnv(context);
  const operator = await requirePlatformOperator(env, request, new Date());
  return { displayName: operator.displayName };
}

export default function PlatStatus() {
  const data = useLoaderData<StatusData>();

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("plat.status.title")}</h1>
      </div>
      <p className="pk-page__lede">{`${t("plat.status.welcome")}${data.displayName}`}</p>
      <p className="pk-muted">{t("plat.status.placeholder")}</p>
    </section>
  );
}
