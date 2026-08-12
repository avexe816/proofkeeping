/**
 * W-16 チェックリスト定義の画面ロジック。**純粋関数。**
 *
 * task: docs/tasks/P1-06.md
 * 仕様: docs/PK-SPEC-P1.md §6.1 / §6.2 / §6.3 / §12.2
 *
 * ── 「どれが効くのか」を画面が答える ────────────────────
 * §6.1 の 3 階層は、タスク生成時に**最も具体的な 1 つ**だけが選ばれる。
 * テンプレートを 3 つ並べただけの画面は「結局どれが現場に出るのか」に
 * 答えられない。`resolveTemplate()`（`@pk/engine`）を画面でも通し、
 * 効いているものに印を付ける。判定の実装を 2 つ持たないため、
 * **生成側と同じ関数を使う。**
 *
 * ── 項目はテキストで編集する ────────────────────────────
 * 17 項目 × 4 属性を個別の input で並べると 68 個の欄になる。1 行 1 項目の
 * テキストにして、行の追加・削除・並べ替えを編集操作そのものに寄せる。
 * 書式は `セクション / ラベル / 必須 / 写真`（区切りは `/`）。
 *
 * ── 「すべてチェック」に相当する操作を作らない ──────────
 * §6.3 / CLAUDE.md §4。これは**実施結果**の話であって定義の話ではないので
 * この画面には現れないが、項目を「まとめて必須にする」欄も置かない
 * （必須を一括で外す操作が、記録の質を落とす方向に効く）。
 */

import type { CreateChecklistItemInput } from "@pk/db";
import { resolveTemplate, type TemplateCandidate } from "@pk/engine";

/** 階層（§6.1）。数字が大きいほど具体的。 */
export const TEMPLATE_TIERS = ["ORGANIZATION", "PROPERTY", "ROOM_TYPE"] as const;

export type TemplateTier = (typeof TEMPLATE_TIERS)[number];

/** 行の書式の区切り。ラベルに `/` を使いたい場合は `//` で書く。 */
const FIELD_SEPARATOR = "/";

/** 必須・写真を表す語。**入力の揺れを吸収する。** */
const TRUTHY = new Set(["必須", "写真", "required", "photo", "true", "1", "yes", "y", "○"]);

/** 画面に出す 1 テンプレート。 */
export interface TemplateView {
  id: string;
  name: string;
  taskType: string;
  version: number;
  tier: TemplateTier;
  propertyId: string | null;
  roomTypeId: string | null;
  /** 客室タイプ別のときの表示名。解決できなければ `null`。 */
  roomTypeName: string | null;
  isActive: boolean;
  itemCount: number;
  /** 未翻訳（`labels.en` が無い）項目の件数。§12.2 の「日本語のみ」。 */
  untranslatedCount: number;
  /** 1 行 1 項目のテキスト（編集欄の初期値）。 */
  itemsText: string;
}

/** テンプレートの階層を決める。 */
export function tierOf(template: { propertyId: string | null; roomTypeId: string | null }): TemplateTier {
  if (template.propertyId === null) return "ORGANIZATION";
  return template.roomTypeId === null ? "PROPERTY" : "ROOM_TYPE";
}

/** `buildTemplateViews()` の入力。 */
export interface TemplateViewInput {
  templates: readonly {
    id: string;
    name: string;
    taskType: string;
    version: number;
    propertyId: string | null;
    roomTypeId: string | null;
    isActive: boolean;
  }[];
  items: readonly {
    templateId: string;
    section: string;
    labels: Record<string, string>;
    isRequired: boolean;
    photoRequired: boolean;
    sortOrder: number;
  }[];
  roomTypes: readonly { id: string; name: string }[];
}

/**
 * テンプレートを画面の形へ写す。
 *
 * 並びは階層の浅い順 → 清掃種別 → 名前。**無効化済みも返す**
 * （消えたのではなく無効になったことが画面で読めるように）。
 */
export function buildTemplateViews(input: TemplateViewInput): readonly TemplateView[] {
  const typeName = new Map(input.roomTypes.map((type) => [type.id, type.name]));
  const itemsByTemplate = new Map<string, TemplateViewInput["items"][number][]>();
  for (const item of input.items) {
    const list = itemsByTemplate.get(item.templateId) ?? [];
    list.push(item);
    itemsByTemplate.set(item.templateId, list);
  }

  const views = input.templates.map((template) => {
    const items = [...(itemsByTemplate.get(template.id) ?? [])].sort(
      (a, b) => a.sortOrder - b.sortOrder,
    );
    return {
      id: template.id,
      name: template.name,
      taskType: template.taskType,
      version: template.version,
      tier: tierOf(template),
      propertyId: template.propertyId,
      roomTypeId: template.roomTypeId,
      roomTypeName:
        template.roomTypeId === null ? null : (typeName.get(template.roomTypeId) ?? null),
      isActive: template.isActive,
      itemCount: items.length,
      untranslatedCount: items.filter((item) => (item.labels["en"] ?? "") === "").length,
      itemsText: formatItems(items),
    };
  });

  const tierOrder = (tier: TemplateTier): number => TEMPLATE_TIERS.indexOf(tier);
  return [...views].sort(
    (a, b) =>
      tierOrder(a.tier) - tierOrder(b.tier) ||
      a.taskType.localeCompare(b.taskType) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * その施設で実際に選ばれるテンプレートの ID を求める（§6.1）。
 *
 * 客室タイプごとに 1 つ、清掃種別ごとに 1 つ。**生成と同じ
 * `resolveTemplate()` を通す。** 該当が無い組み合わせは含めない
 * （チェックリストの無いタスクは成立する）。
 */
export function resolveEffective(
  templates: readonly TemplateCandidate[],
  propertyId: string,
  roomTypeIds: readonly (string | null)[],
  taskTypes: readonly string[],
): ReadonlySet<string> {
  const effective = new Set<string>();
  for (const roomTypeId of roomTypeIds) {
    for (const taskType of taskTypes) {
      const chosen = resolveTemplate(templates, { propertyId, roomTypeId, taskType });
      if (chosen !== null) effective.add(chosen.id);
    }
  }
  return effective;
}

/** 1 行 1 項目のテキストへ写す。 */
export function formatItems(
  items: readonly {
    section: string;
    labels: Record<string, string>;
    isRequired: boolean;
    photoRequired: boolean;
  }[],
): string {
  return items
    .map((item) => {
      const label = escapeField(item.labels["ja"] ?? "");
      const flags = [item.isRequired ? "必須" : "任意", item.photoRequired ? "写真" : "-"];
      return [escapeField(item.section), label, ...flags].join(` ${FIELD_SEPARATOR} `);
    })
    .join("\n");
}

/** `parseItems()` の結果。**読めなかった行を黙って捨てない。** */
export interface ParsedItems {
  items: CreateChecklistItemInput[];
  /** 読めなかった行の番号（1 始まり）。 */
  skippedLines: number[];
}

/**
 * 1 行 1 項目のテキストを読む。
 *
 * ```
 * ベッドまわり / シーツ・カバー類を交換した / 必須 / -
 * 浴室 / 浴室の水滴を拭き上げた / 必須 / 写真
 * ```
 *
 * **`labels.en` を作らない。** 訳文はこの画面から入れられない（管理画面は
 * 日本語のみ / §12.1）。既存の訳を保ちたい場合は `mergeTranslations()` を通す。
 */
export function parseItems(text: string): ParsedItems {
  const items: CreateChecklistItemInput[] = [];
  const skippedLines: number[] = [];

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;

    const fields = splitFields(line);
    const section = fields[0]?.trim() ?? "";
    const label = fields[1]?.trim() ?? "";
    // セクションとラベルは必須。**片方だけの行を通さない**（現場に空の
    // 項目が並ぶ）。
    if (section === "" || label === "") {
      skippedLines.push(index + 1);
      continue;
    }

    items.push({
      section,
      labels: { ja: label },
      isRequired: isTruthy(fields[2]),
      photoRequired: isTruthy(fields[3]),
    });
  }

  return { items, skippedLines };
}

/**
 * 既存項目の訳文（`labels.en`）を、同じ日本語ラベルの新項目へ引き継ぐ。
 *
 * §12.2 は `labels` に多言語を持たせると定める。この画面は日本語しか
 * 編集できないので、**項目を保存するたびに訳が消えるのを防ぐ。**
 * 対応づけは日本語ラベルの一致で行う（並び順で対応づけると、行を 1 つ
 * 挿入しただけで以降の訳が 1 つずつずれる）。
 */
export function mergeTranslations(
  items: readonly CreateChecklistItemInput[],
  existing: readonly { labels: Record<string, string> }[],
): CreateChecklistItemInput[] {
  const byJa = new Map<string, Record<string, string>>();
  for (const item of existing) {
    const ja = item.labels["ja"] ?? "";
    if (ja !== "") byJa.set(ja, item.labels);
  }

  return items.map((item) => {
    const previous = byJa.get(item.labels["ja"] ?? "");
    if (previous === undefined) return item;
    // 日本語は新しい方を正とする。訳文だけを引き継ぐ。
    return { ...item, labels: { ...previous, ...item.labels } };
  });
}

/** 区切りに使う `/` をラベルに含めたいときのための逃げ道。 */
function escapeField(value: string): string {
  return value.replaceAll(FIELD_SEPARATOR, `${FIELD_SEPARATOR}${FIELD_SEPARATOR}`);
}

/** `//` を `/` に戻しながら列へ割る。 */
function splitFields(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  for (let i = 0; i < line.length; i++) {
    if (line[i] === FIELD_SEPARATOR) {
      if (line[i + 1] === FIELD_SEPARATOR) {
        field += FIELD_SEPARATOR;
        i += 1;
        continue;
      }
      fields.push(field);
      field = "";
      continue;
    }
    field += line[i] ?? "";
  }
  fields.push(field);
  return fields;
}

function isTruthy(raw: string | undefined): boolean {
  return raw !== undefined && TRUTHY.has(raw.trim().toLowerCase());
}
