/**
 * M-04 チェックリスト（PK-SPEC-P1 §9.4 / §6.3）。
 *
 * task:  docs/tasks/P1-10.md
 * ルール: .claude/rules/ui-writing.md §3
 * 参照:  ui-prototypes/mobile/pk-08-checklist.html
 *
 * ── 守っているもの ──────────────────────────────────────
 *   **「すべてチェック」ボタンを置かない**（§6.3 / ui-writing.md §3）
 *   3 値で記録する（INV-22）。2 値にしない
 *   チェック時刻は**項目ごと**に記録される（送信は 1 項目 1 リクエスト）
 *   完了したセクションは**自動で折りたたむ**（§9.4）
 *   写真が要る項目はタスク詳細のカメラへ誘導する
 *
 * ── 一括更新の口が無いことに意味がある ──────────────────
 * 画面からボタンを消しても、まとめて送れる API があれば同じことができる。
 * `POST /tasks/{id}/checklist` は 1 項目ずつしか受けない（P1-06）。
 * **ここでループして全項目を送る実装を書かないこと。**
 *
 * ── オフラインでも押せる ────────────────────────────────
 * 記録は手元に即反映し、送信はキューが持つ（§9.4「チェックはローカルに
 * 即反映し、送信は非同期」）。16 項目を機内モードで記録できること。
 */

import type { ChecklistValue } from "@pk/db";
import {
  countPhotosByChecklistItem,
  findRoomById,
  findTaskById,
  listChecklistResults,
  listTemplateItems,
} from "@pk/db";
import { CHECKLIST_VALUES } from "@pk/contracts";
import { useEffect, useState } from "react";
import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";

import { assertPermission, propertyTarget } from "../../lib/auth/permission.js";
import { createTranslator, type Locale, type MessageKey } from "../../lib/i18n.js";
import { requireMobileContext } from "../../lib/mobile/session.js";
import { resolveObservationConfig } from "../../lib/observation/config.js";
import { enqueueJson, flushQueue } from "../../lib/offline/queue.js";
import { getEnv } from "../../lib/ui/cloudflare.js";

export interface ChecklistItemView {
  itemId: string;
  section: string;
  /** 表示言語の文言。**未翻訳なら日本語**（§12.2）。 */
  label: string;
  /**
   * 表示言語の訳が無く日本語を出しているか（§12.2 の「日本語のみ」）。
   *
   * **空欄にしない。** 訳が無いことを黙って隠すと、現場は「この項目は
   * 自分の言語に訳されている」と受け取る。項目名の横に小さく示す。
   */
  isJapaneseOnly: boolean;
  isRequired: boolean;
  photoRequired: boolean;
  value: ChecklistValue | null;
  photoCount: number;
  sortOrder: number;
}

export interface ChecklistData {
  locale: Locale;
  taskId: string;
  roomNumber: string;
  items: ChecklistItemView[];
  /**
   * 退室前のリネン記録を出す施設か（PK-SPEC-P3 §4.3 / P3-06）。
   *
   * **チェックリストを終えてから出す。** M-06 は「退室前」の記録で、
   * 清掃の途中に出すと数える対象がまだ部屋にある。
   */
  requireLinen: boolean;
}

export async function loader({
  request,
  params,
  context,
}: LoaderFunctionArgs): Promise<ChecklistData> {
  const env = getEnv(context);
  const now = new Date();
  const { tenant, locale } = await requireMobileContext(env, request, now);

  const taskId = params.taskId ?? "";
  const task = await findTaskById(env, tenant, taskId);
  if (task === undefined) throw new Response(null, { status: 404 });
  assertPermission(tenant, "task.read", propertyTarget([task.propertyId]));

  const [results, photoCounts, room, observationConfig] = await Promise.all([
    listChecklistResults(env, tenant, taskId),
    countPhotosByChecklistItem(env, tenant, taskId),
    findRoomById(env, tenant, task.roomId),
    resolveObservationConfig(env, tenant, task.propertyId),
  ]);
  const items = await listTemplateItems(env, tenant, [
    ...new Set(results.map((row) => row.itemId)),
  ]);
  const itemById = new Map(items.map((item) => [item.id, item]));

  // 客室番号だけを見出しに出す。**担当者名は出さない**（INV-06）。
  return {
    locale,
    taskId,
    roomNumber: room?.roomNumber ?? "",
    requireLinen: observationConfig.requireLinen,
    items: results
      .map((row) => {
        const item = itemById.get(row.itemId);
        return {
          itemId: row.itemId,
          section: item?.section ?? "",
          label: item?.labels[locale] ?? item?.labels.ja ?? "",
          isJapaneseOnly: locale !== "ja" && (item?.labels[locale] ?? "") === "",
          isRequired: row.isRequired,
          photoRequired: row.photoRequired,
          value: row.value,
          photoCount: photoCounts.get(row.itemId) ?? 0,
          sortOrder: row.sortOrder,
        };
      })
      .sort((a, b) => a.sortOrder - b.sortOrder),
  };
}

export default function ChecklistRoute(): React.ReactElement {
  const data = useLoaderData<ChecklistData>();
  const t = createTranslator(data.locale);

  /** 記録済みの手元の値（送信待ちを含む）。**押した瞬間に反映する。** */
  const [values, setValues] = useState<Record<string, ChecklistValue>>({});
  /** 手で開き直したセクション。自動の折りたたみより優先する。 */
  const [opened, setOpened] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setValues({});
  }, [data.items]);

  const valueOf = (item: ChecklistItemView): ChecklistValue | null =>
    values[item.itemId] ?? item.value;

  const record = (itemId: string, value: ChecklistValue): void => {
    setValues((current) => ({ ...current, [itemId]: value }));
    void (async () => {
      await enqueueJson({
        url: `/api/v1/tasks/${data.taskId}/checklist`,
        body: { itemId, value, clientTs: Date.now() },
      });
      await flushQueue();
    })();
  };

  const sections = groupBySection(data.items);
  const done = data.items.filter((item) => valueOf(item) === "DONE").length;
  const total = data.items.filter((item) => valueOf(item) !== "NOT_APPLICABLE").length;
  const requiredRemaining = data.items.filter(
    (item) => item.isRequired && valueOf(item) === null,
  ).length;

  return (
    <>
      <header className="pk-m-head">
        <div className="pk-m-head__row">
          <Link className="pk-m-head__back" to={`/m/task/${data.taskId}`} aria-label={t("m.checklist.back")}>
            ←
          </Link>
          <h1 className="pk-m-head__title">{t("m.checklist.title")}</h1>
        </div>
        <p className="pk-m-head__sub">
          {data.roomNumber} · {done}/{total} · {t("m.checklist.requiredRemaining")}{" "}
          {requiredRemaining}
        </p>
      </header>

      <main className="pk-m-body">
        {data.items.length === 0 ? (
          <p className="pk-m-empty">{t("m.checklist.empty")}</p>
        ) : (
          sections.map(([section, items]) => {
            // **完了したセクションは自動で折りたたむ**（§9.4）。
            const sectionDone = items.every((item) => valueOf(item) !== null);
            const isOpen = opened[section] ?? !sectionDone;
            const doneCount = items.filter((item) => valueOf(item) !== null).length;

            return (
              <section key={section} className="pk-m-check">
                <button
                  type="button"
                  className="pk-m-check__header"
                  aria-expanded={isOpen}
                  onClick={() => {
                    setOpened((current) => ({ ...current, [section]: !isOpen }));
                  }}
                >
                  <span>{section}</span>
                  <span className="pk-m-section__count">
                    {doneCount}/{items.length}
                  </span>
                  <span>{isOpen ? "▾" : "▸"}</span>
                </button>

                {!isOpen
                  ? null
                  : items.map((item) => (
                      <div key={item.itemId} className="pk-m-check__item">
                        <div className="pk-m-check__label">
                          {item.label}
                          {item.isRequired ? (
                            <span className="pk-m-check__badge">{t("m.checklist.required")}</span>
                          ) : null}
                          {/* §12.2。未翻訳は日本語を出し、そのことを小さく示す。 */}
                          {item.isJapaneseOnly ? (
                            <span className="pk-m-check__badge pk-m-check__badge--lang">
                              {t("m.checklist.japaneseOnly")}
                            </span>
                          ) : null}
                        </div>
                        {item.photoRequired && item.photoCount === 0 ? (
                          <p className="pk-m-note">{t("m.checklist.photoRequired")}</p>
                        ) : null}
                        {/* 3 値（INV-22）。**「すべてチェック」は無い。** */}
                        <div className="pk-m-check__values">
                          {CHECKLIST_VALUES.map((value) => (
                            <button
                              key={value}
                              type="button"
                              className="pk-m-check__value"
                              aria-pressed={valueOf(item) === value}
                              onClick={() => {
                                record(item.itemId, value);
                              }}
                            >
                              {t(`m.checklist.value.${value}` as MessageKey)}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
              </section>
            );
          })
        )}

        <p className="pk-m-note">{t("m.checklist.hint")}</p>

        {/* M-06（PK-SPEC-P3 §4.3）。**必須項目が片付いてから出す。**
            `requireLinen = false` の施設には出さない。 */}
        {data.requireLinen && requiredRemaining === 0 ? (
          <Link className="pk-m-button" to={`/m/task/${data.taskId}/linen`}>
            {t("m.linen.title")}
          </Link>
        ) : null}

        <Link className="pk-m-button pk-m-button--secondary" to={`/m/task/${data.taskId}`}>
          {t("m.checklist.back")}
        </Link>
      </main>
    </>
  );
}

/** セクションごとにまとめる。**並びは `sortOrder` のまま**（定義順）。 */
function groupBySection(items: readonly ChecklistItemView[]): [string, ChecklistItemView[]][] {
  const sections = new Map<string, ChecklistItemView[]>();
  for (const item of items) {
    const bucket = sections.get(item.section);
    if (bucket === undefined) sections.set(item.section, [item]);
    else bucket.push(item);
  }
  return [...sections.entries()];
}
