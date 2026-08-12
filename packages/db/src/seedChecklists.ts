/**
 * 既定のチェックリストテンプレート 2 種（PK-SPEC-P1 §6.2）。
 *
 * task: docs/tasks/P1-06.md
 *
 * ── 仕様の表をそのまま持つ ──────────────────────────────
 * §6.2 の「アウト清掃（CHECKOUT）」17 項目と「滞在清掃（STAYOVER）」8 項目。
 * **項目を増やさない。** §7 のリスク表は「チェックリストが長すぎると
 * 形骸化する。16 項目を上限の目安とし、導入時に施設と一緒に削る」と述べる。
 * 既定は削る側の出発点なので、良かれと思って足さないこと。
 *
 * ── 組織共通として投入する ──────────────────────────────
 * `propertyId = null` / `roomTypeId = null`（§6.1 の一番外側）。
 * 施設別・客室タイプ別は W-16 で作る。既定が組織共通にあることで、
 * テンプレートを 1 つも作っていない組織でもタスクにチェックリストが付く。
 *
 * ── 英語 ────────────────────────────────────────────────
 * §12.2 の `labels` は `{ ja, en }`。モバイルは日英対応（§12.1）で、
 * **多言語をプランで制限しない**（INV-35）。既定テンプレートは
 * 最初から英語を持つ。
 */

/** 1 項目の定義。`packages/db` の `checklistItem` へそのまま入る。 */
export interface SeedChecklistItem {
  section: string;
  labels: { ja: string; en: string };
  isRequired: boolean;
  photoRequired: boolean;
}

/** 1 テンプレートの定義。 */
export interface SeedChecklistTemplate {
  taskType: "CHECKOUT" | "STAYOVER";
  name: string;
  items: readonly SeedChecklistItem[];
}

/** 必須・写真なしの項目を作る短縮。**既定は「必須・写真不要」。** */
function item(section: string, ja: string, en: string): SeedChecklistItem {
  return { section, labels: { ja, en }, isRequired: true, photoRequired: false };
}

/** 写真が要る項目。 */
function withPhoto(base: SeedChecklistItem): SeedChecklistItem {
  return { ...base, photoRequired: true };
}

/** 任意項目。**未記録でも `complete` を妨げない。** */
function optional(base: SeedChecklistItem): SeedChecklistItem {
  return { ...base, isRequired: false };
}

/** §6.2 のアウト清掃 17 項目。 */
const CHECKOUT_ITEMS: readonly SeedChecklistItem[] = [
  item("ベッドまわり", "シーツ・カバー類を交換した", "Changed sheets and covers"),
  item("ベッドまわり", "枕カバーを交換した", "Changed pillowcases"),
  withPhoto(item("ベッドまわり", "ベッドメイキングを完了した", "Completed bed making")),
  item("浴室", "浴槽・シャワーを洗浄した", "Cleaned bathtub and shower"),
  item("浴室", "洗面台・鏡を清掃した", "Cleaned sink and mirror"),
  item("浴室", "トイレを洗浄・消毒した", "Cleaned and disinfected toilet"),
  withPhoto(item("浴室", "浴室の水滴を拭き上げた", "Wiped down bathroom surfaces")),
  item("客室", "床を清掃した", "Cleaned the floor"),
  item("客室", "ゴミを回収した", "Collected the trash"),
  item("客室", "什器・スイッチ類を拭いた", "Wiped fixtures and switches"),
  optional(item("客室", "窓・鏡を清掃した", "Cleaned windows and mirrors")),
  item("アメニティ・備品", "タオル類を補充した", "Restocked towels"),
  item("アメニティ・備品", "アメニティを補充した", "Restocked amenities"),
  item("アメニティ・備品", "備品の破損がないことを確認した", "Confirmed fixtures are undamaged"),
  item("最終確認", "忘れ物がないことを確認した", "Confirmed no items were left behind"),
  item("最終確認", "空調・照明を設定した", "Set air conditioning and lighting"),
  withPhoto(item("最終確認", "客室全体を撮影した", "Photographed the whole room")),
];

/** §6.2 の滞在清掃 8 項目。 */
const STAYOVER_ITEMS: readonly SeedChecklistItem[] = [
  item("ベッドまわり", "ベッドを整えた", "Made the bed"),
  // §6.2 は「3泊目のみ」と注記する。**周期の判定を実装しない**ので任意項目にする
  // （施設ごとの周期設定は docs/OPEN_QUESTIONS.md の未決事項 / §17-2）。
  optional(item("ベッドまわり", "シーツを交換した（3泊目のみ）", "Changed sheets (3rd night only)")),
  item("浴室", "浴室を清掃した", "Cleaned the bathroom"),
  item("浴室", "タオル類を交換した", "Replaced the towels"),
  item("客室", "ゴミを回収した", "Collected the trash"),
  item("客室", "床を清掃した", "Cleaned the floor"),
  item("最終確認", "お客様の私物に触れていない", "Did not touch the guest's belongings"),
  withPhoto(item("最終確認", "客室全体を撮影した", "Photographed the whole room")),
];

/** 既定テンプレート 2 種（§6.2）。 */
export const SEED_CHECKLIST_TEMPLATES: readonly SeedChecklistTemplate[] = [
  { taskType: "CHECKOUT", name: "アウト清掃", items: CHECKOUT_ITEMS },
  { taskType: "STAYOVER", name: "滞在清掃", items: STAYOVER_ITEMS },
];
