/**
 * 権限マトリクスと `assertPermission()`。認可の唯一の判定点。
 *
 * task:  docs/tasks/P0-10.md
 * ルール: .claude/rules/security.md §1
 * 決定:  docs/DECISIONS.md #022（拒否は一律 404）/ #023（読み取りは組織全体・書き込みは自施設）
 *
 * ── この層が担うもの ────────────────────────────────────
 * テナント分離の第 1 層（`withTenantScope()`）は「別組織の行を混ぜない」を守る。
 * **同じ組織の中で、そのロールがその操作に到達してよいか**は別の問いで、
 * 第 1 層は何も言わない。ここがそれを決める。
 *
 * 判定は必ずサーバー側で行う。**フロントでのメニュー非表示は UX 上の措置であり、
 * 権限制御とみなさない**（security.md §1）。`can()` はその出し分けのために
 * 用意してあるが、`assertPermission()` を省く理由にはならない。
 *
 * ── P0-10 が実装する範囲 ────────────────────────────────
 * security.md §1 が「絶対に守る境界」として明記した項目と、P0 に実体のある
 * 資源（組織・税務プロファイル・ユーザー・施設）だけ。
 * **PK-IMPL-CONTRACT §4 のビジネス表（単価・契約条件、請求の確定、シフトと割当…）は
 * 転記していない。** あの表は `SITE_LEAD` / `OPS_MANAGER` / `VIEWER` /
 * `PLATFORM_ADMIN` という別語彙で書かれており、7 語への写像が推測になる
 * （OPEN_QUESTIONS #011）。特に §4 の `OWNER` は「自施設・清掃員氏名 ×」で、
 * security.md §1 の `OWNER`（組織全体）とは別概念である。
 * **各画面の権限は、その画面を作る task が `PERMISSION_ACTIONS` に 1 行足す。**
 *
 * ── 明記の無いセルは DENY ───────────────────────────────
 * security.md §1 に根拠が無いセルはすべて `DENY` にしてある。広げるのは
 * 根拠を持つ task の仕事。`repositories/base.ts` の `ORG_WIDE_ROLES` と同じく、
 * **書き忘れが「見えすぎる」方向に壊れない**向きへ既定を倒している。
 */

import { NotFoundError, isOrgWideRole, type Role, type TenantContext } from "@pk/db";

// ────────────────────────────────────────────────────────────
// アクションのレジストリ
// ────────────────────────────────────────────────────────────

/**
 * 権限判定の対象になる操作。**閉じたレジストリ。**
 *
 * `write` は「状態を変える操作か」。`AUDITOR` が書き込みを一切できないこと
 * （security.md §1）を、ロールごとに人手で確かめるのではなく
 * この印から機械的に検査するために持たせている（permission.spec.ts）。
 *
 * ── 追加するときの手順 ──────────────────────────────────
 * ① ここへ 1 行足す ② `PERMISSION_MATRIX` に 7 ロール分のセルを書く
 * （書かなければ**コンパイルエラー**になる）③ 根拠を仕様書か
 * security.md のどこに置いたかをコメントに残す。
 */
export const PERMISSION_ACTIONS = {
  /** 組織の基本情報の閲覧。表示名は全ロールの画面に出る。 */
  "organization.read": { write: false },
  /** 組織設定の変更（security.md §6 の監査対象）。 */
  "organization.write": { write: true },
  /** 税務プロファイル（登録番号・端数処理）の閲覧。 */
  "taxProfile.read": { write: false },
  /** 税務プロファイルの変更（security.md §6 の監査対象）。 */
  "taxProfile.write": { write: true },
  /**
   * ユーザー・所属の閲覧。
   *
   * **施設スコープロールも組織全体を読める**（OPEN_QUESTIONS #016 の回答）。
   * `user` / `membership` は `propertyId` を持たず、`scopeToProperties()` が
   * 掛からない。リポジトリ層は `NO_PROPERTY_SCOPE` のまま変更しない。
   */
  "user.read": { write: false },
  /** 招待・ロール変更・無効化・PIN リセット（security.md §6 の監査対象）。 */
  "user.write": { write: true },
  /** 施設の閲覧。 */
  "property.read": { write: false },
  /** 施設マスタの作成・更新・無効化（security.md §6 の監査対象）。 */
  "property.write": { write: true },
  /**
   * 差異レポート（`/app/audit/*`、`/api/v1/findings`）。
   *
   * P0 に実体は無い。**`CLEANER` / `INSPECTOR` が到達できない**という
   * security.md §1 の絶対境界を、資源より先に固定しておくために置く。
   */
  "finding.read": { write: false },
  /**
   * 照合の手動再実行（P4-05 / PK-SPEC-P4 §5.4・§6.4）。
   *
   * §6.4 の表で「手動再実行」が ○ なのは `OWNER` / `ORG_ADMIN` だけ。
   * **施設責任者にも与えない。** 過去 90 日を遡って走らせられる操作で、
   * 差異の再評価は組織全体の運用判断に関わる。
   */
  "reconciliation.run": { write: true },
  /**
   * 差異の状態変更（P4-07 / PK-SPEC-P4 §6.3・§6.4）。
   *
   * §6.4 の表で「状態の変更」が ○ なのは `OWNER` / `ORG_ADMIN` だけ。
   * **`PROPERTY_MANAGER` は読めるが閉じられない**（`finding.read` は
   * `ASSIGNED`）。差異を閉じる判断は組織の内部統制の話で、
   * 差異の当事者になりうる施設側に委ねない。`AUDITOR` は
   * security.md §1 の「書き込み操作を一切できない」。
   */
  "finding.write": { write: true },
  /**
   * 業務上の入室記録（P4-10 / PK-SPEC-P4 §2.3・§4.1）。
   *
   * **§6.4 の権限表にこの操作の行が無い**（あの表は差異レポートの
   * 閲覧・状態変更・ルール設定・再実行・エクスポート）。DECISIONS #115 で
   * 次のように決めた。
   *
   *   - 書き込みは `PROPERTY_MANAGER` 以上。**現場ロールに与えない。**
   *     登録すると §4.1 でその客室・業務日の差異が抑制される。
   *     照合の対象になる側が自分で抑制を作れる形にしない
   *     （§11 の「清掃員が入力を歪める」と同じ筋）。
   *   - `VENDOR_ADMIN` も DENY。受託した清掃会社が自社の作業日の差異を
   *     消せると、差異レポートが清掃会社との合意の材料にならない。
   *   - 閲覧は `AUDITOR` にも開く（読取専用・内部統制の確認）。
   */
  "roomAccess.read": { write: false },
  "roomAccess.write": { write: true },
  /**
   * ルール設定（W-25 / PK-SPEC-P4 §2.7・§6.4）。
   *
   * §6.4 の表で「ルール設定」が ○ なのは `OWNER` / `ORG_ADMIN` だけ。
   * **閲覧も同じ 2 ロールに絞ってある。** 閾値は「この枚数までなら差異に
   * ならない」を示す値で、`baseline.read` を現場ロールへ開かない理由
   * （その注記）がそのまま当てはまる。`AUDITOR` には読み取りを許す
   * （内部統制の確認。判定の設定を確かめられないと監査にならない）。
   */
  "ruleConfig.read": { write: false },
  "ruleConfig.write": { write: true },
  /**
   * 取引先マスタと料金設定（P5-02 / P5-03 / PK-SPEC-P5 §2.1・§2.2）。
   *
   * **既存の `billing.read` と分けてある。** あちらは「請求情報を見られるか」
   * （security.md §1 の絶対境界。`INSPECTOR` は不可）で、こちらは
   * **単価そのものを設定できるか。** 単価は取引条件で、施設の運用より
   * 経営の判断に近い（PK-IMPL-CONTRACT §4 が「単価・契約条件」を
   * 別の行にしているのと同じ筋）。
   *
   * 閲覧は `billing.read` と同じ配り方（施設責任者は担当施設ぶんの請求を
   * 見られるので、その単価も見えないと金額を確かめられない）。
   * **書き込みは `OWNER` / `ORG_ADMIN` だけ。** 施設責任者が自分の施設の
   * 単価を動かせると、請求額を現場側で決められることになる。
   */
  "counterparty.read": { write: false },
  "counterparty.write": { write: true },
  /**
   * 忘れ物の保管場所・返却先。**`CLEANER` は見られない**（security.md §1）。
   * 忘れ物そのものの記録とは別の操作。P0 に実体は無い。
   */
  "lostItem.readStorage": { write: false },
  /** 請求情報。**`INSPECTOR` は見られない**（security.md §1）。P0 に実体は無い。 */
  "billing.read": { write: false },
  /**
   * 清掃タスクの閲覧（P1-05 / PK-SPEC-P1 §5.3・§9）。
   *
   * `CLEANER` は自分の担当を見る必要があるので担当施設で許す。
   * **「自分のタスクだけ」への絞り込みは権限ではなく一覧の条件**
   * （`listTasks({ assigneeId })`）。`SELF` スコープはまだ無い。
   */
  "task.read": { write: false },
  /**
   * 状態変更（start / pause / resume / complete / block / unblock）。
   * §5.3 の「担当者本人、P_MANAGER 以上」。
   */
  "task.write": { write: true },
  /**
   * 割当・取消・タスク生成（§5.3 の assign / cancel、§3.2 の再生成）。
   * **`CLEANER` は自分にも割り当てられない。** 人員配分は施設責任者の判断。
   */
  "task.manage": { write: true },
  /** チェックリスト定義（W-16）。§10.1 の担当ロールは `ORG_ADMIN`。 */
  "checklistTemplate.read": { write: false },
  "checklistTemplate.write": { write: true },
  /** 標準時間マスタ（W-17）。§10.1 の担当ロールは `ORG_ADMIN`。 */
  "standardTime.read": { write: false },
  "standardTime.write": { write: true },
  /** 当日の客室状況（W-05）。§10.1 の担当ロールは `P_MANAGER 以上`。 */
  "roomPlan.read": { write: false },
  "roomPlan.write": { write: true },
  /**
   * 稼働記録（A 系統 / PK-SPEC-P4 §2.1・§8.1）。
   *
   * **§6.4 の権限表に稼働記録の行が無い。** あの表は差異レポートの
   * 閲覧・状態変更・ルール設定・再実行・エクスポートで、取込は載っていない。
   * 当日の客室状況（`roomPlan.*`）と同じ「その日の稼働を入れる操作」なので
   * 同じ配り方にした。**`CLEANER` / `INSPECTOR` は DENY。** 稼働記録は
   * 差異の根拠そのもので、現場に見せる理由が無い（§11 の
   * 「清掃員が入力を歪める」への対策）。
   */
  "occupancy.read": { write: false },
  "occupancy.write": { write: true },
  /**
   * 客室ステータスの手動上書き（W-03 / M-10）。§11.2 の「施設責任者」。
   *
   * **`property.write`（客室マスタ）と分けてある。** 当日の状態を直すことと、
   * 客室そのものを増減させることは別の権限。前者は日常の運用で、
   * 後者は設定の変更にあたる。
   */
  "room.statusOverride": { write: true },
  /**
   * 自分の実績（M-11 / §9.6）。
   *
   * **`SELF` スコープを足していない。** 判定に要るのは「自分のものか」
   * だけで、それは `listTasks({ assigneeId })` が構造として満たしている
   * （他人の ID を受け取る口が無い）。マトリクスに `SELF` を足すと、
   * 対象に `membershipId` を持ち回る必要が出て、**渡し忘れが「広い側」へ
   * 倒れる**（`ORGANIZATION_TARGET` を第 3 引数から省けない理由と同じ）。
   * ここは「自分の記録の閲覧」という操作そのものを 1 行にした。
   * security.md §5 の「本人が自分の記録を閲覧できる画面」に対応する。
   */
  "task.readOwn": { write: false },
  /**
   * 検査の閲覧（M-08 / M-09 / PK-SPEC-P2 §4）。
   *
   * **`CLEANER` は DENY。** 差戻しの内容を清掃者へ見せる画面は M-12 で、
   * それは「自分のタスクの差戻し項目だけ」という別の絞り（§4.6）を持つ。
   * ここを開けると他人のタスクの検査結果まで見えるので、M-12 を作る
   * task（P2-07）が `rework.readOwn` 相当を足すこと。
   */
  "inspection.read": { write: false },
  /**
   * 検査の開始・項目入力・完了（§4.2〜§4.5）。
   *
   * §5.1 の自動割当が対象とするのは `INSPECTOR` と `PROPERTY_MANAGER`。
   * **`CLEANER` は DENY。** §4.2 の自己検査の例外は「検査できるロールの人が
   * たまたま自分の清掃したタスクに当たった」場合の話で、清掃者に検査権限を
   * 与える規定ではない（`CLEANER` を許すと、他人のタスクの検査まで通る）。
   */
  "inspection.write": { write: true },
  /**
   * 差戻しの閲覧（M-12 / PK-SPEC-P2 §4.6）。
   *
   * **`CLEANER` を許す。** §4.6 は「清掃者は差戻し項目だけを表示できる」で、
   * `inspection.read`（DENY）とは別の操作。2 つの絞りが掛かって初めて
   * §4.6 になる。
   *   ① このアクション … 担当施設か（`ASSIGNED`）
   *   ② 応答の組み立て … 自分に割り当てられた差戻しか（`assertReworkVisible()`）
   *      ＋ 不合格かつ再清掃が要る項目だけ（`reworkVisibleItemIds()`）
   *
   * **② を「画面で絞る」にしないこと。** ロールだけでは「他人の差戻しを
   * 見られない」を表せない（`PERMISSION_MATRIX` は施設までしか絞れない）。
   * `SELF` スコープを足さない理由は `task.readOwn` の注記と同じ。
   */
  "rework.read": { write: false },
  /**
   * 再清掃の開始・完了（§4.6）。
   *
   * `task.write`（§5.3 の「担当者本人、P_MANAGER 以上」）と同じ並びにする。
   * 再清掃は清掃作業そのもので、**`INSPECTOR` は行わない**（自分が差し戻した
   * 項目を自分で直せると、§1.1 の「検査は清掃者と分離する」が崩れる）。
   */
  "rework.write": { write: true },
  /**
   * 免除（§4.7）。**`PROPERTY_MANAGER` 以上。**
   *
   * §4.7 の「設備故障等で清掃者が改善できない項目は PROPERTY_MANAGER 以上が
   * 免除できる」をそのまま写す。`rework.write` と分けてあるのは、免除が
   * 「作業を進める」ではなく「不合格のまま客室を扱う」判断だから。
   * **`VENDOR_ADMIN` は DENY**（受託した清掃会社が自分の差戻しを免除できると、
   * 検査そのものが意味を失う）。
   */
  "rework.waive": { write: true },
  /**
   * 検査待ちで取り残されたタスクを、検査せずに閉じる（§13.3 / P2-16）。
   *
   * §13.3 の「P2 リリース前に `AWAITING_INSPECTION` のタスクは**施設責任者が**
   * 処理してから移行する」をそのまま写す。**`INSPECTOR` は DENY。**
   * 検査担当が「検査しないで閉じる」を選べると、検査の記録を残さずに
   * 検査を終わらせられる（§13.1 で廃止した一括承認と同じことが 1 件ずつ
   * できてしまう）。**`VENDOR_ADMIN` も DENY**（`rework.waive` と同じ理由で、
   * 受託側が自分の作業を検査なしで閉じられるようにしない）。
   */
  "inspection.emergencyOverride": { write: true },
  /**
   * 証跡 ZIP の出力（§6.5 / W-07）。**閲覧は `task.read` のまま。**
   *
   * 証跡そのものの閲覧に別のアクションを足していない理由は
   * `routes/api/v1/tasks.ts` の `/evidence/verify` の注記（P2-08）。
   * **持ち出しだけを分けてある。** ZIP は組織の外へ出ていく写しで、
   * security.md §6 が監査対象に挙げているのもこの操作
   * （「データエクスポート・証跡 ZIP 出力」）。
   *
   * `AUDITOR` を `DENY` にしてある。security.md §1 の「書き込み操作を
   * 一切できない」に沿った既定で、**§16.2 の運用と合うかは確かめていない**
   * （監査閲覧が証跡を持ち出せないのは不便かもしれない /
   * OPEN_QUESTIONS #048）。広げるなら根拠を持つ task が動かすこと。
   */
  "evidence.export": { write: true },
  /**
   * 忘れ物の閲覧（W-09 / M-13 / PK-SPEC-P2 §7.4）。
   *
   * **`CLEANER` を許す。** §7.4 は「登録と自分が登録した内容の閲覧」。
   * 2 つの絞りが掛かって初めて §7.4 になる。
   *   ① このアクション … 担当施設か（`ASSIGNED`）
   *   ② 応答の組み立て … `CLEANER` なら `foundById = 自分` で絞り、
   *      `storageLocation` を `null` にする（`lib/report/lostItem.ts`）
   *
   * **② を「画面で絞る」にしないこと**（`rework.read` の注記と同じ）。
   * 保管場所・返却先そのものは既存の `lostItem.readStorage` が
   * `CLEANER` に `DENY` を返す（security.md §1 の絶対境界）。
   */
  "lostItem.read": { write: false },
  /**
   * 忘れ物の登録（§7.4「`CLEANER`: 登録」）。
   *
   * **状態の更新は別**（`lostItem.manage`）。§7.4 は `INSPECTOR` に
   * 「保管済への更新」を許すが `CLEANER` には許さない。
   */
  "lostItem.write": { write: true },
  /**
   * 忘れ物の状態更新（§7.4）。
   *
   * `INSPECTOR` は「保管済への更新」まで。**廃棄・返却・移管は
   * `PROPERTY_MANAGER` 以上**（§7.4「全操作」）だが、
   * `PERMISSION_MATRIX` はロール × 操作までしか表せない。
   * **遷移先ごとの絞りは `lib/report/lostItem.ts` が行う**
   * （`INSPECTOR` は `STORED` へだけ進める）。
   */
  "lostItem.manage": { write: true },
  /**
   * 不具合の閲覧（W-10 / §8）。
   *
   * **`CLEANER` を許す。** 自分が報告したものを確認できないと、
   * 「報告したのに何も起きない」が分からない。一覧の絞り
   * （`reportedById = 自分`）は `lib/report/issue.ts` が行う。
   */
  "issue.read": { write: false },
  /**
   * 不具合の報告（§8.1「清掃中または検査中に不具合を発見した場合」）。
   *
   * **現場のロールが報告できないと成立しない機能。**
   * `CLEANER` / `INSPECTOR` の両方に許す。
   */
  "issue.write": { write: true },
  /**
   * 不具合の状態更新（§8.3）。**現場は報告するだけ。**
   *
   * 対応の判断（着手・解決・対応しない）は運営側。`CLEANER` /
   * `INSPECTOR` は `DENY`。§8.3 の「客室を戻すのは
   * `PROPERTY_MANAGER` 以上」は `room.statusOverride` が別に守る。
   */
  "issue.manage": { write: true },
  /**
   * 日報の閲覧・ダウンロード（W-08 相当 / PK-SPEC-P2 §9.1・§9.6）。
   *
   * 日報は「清掃会社が施設へ提出し、ホテルが実績と検査結果を確認する」
   * 文書（§9.1）。**清掃スタッフと検査担当には見せない。**
   * 明細に全室ぶんの担当者名・所要時間が並ぶので、これを現場ロールへ
   * 開くと `task.readOwn`（自分の記録だけ / security.md §5）の境界が
   * 意味を失う。`VENDOR_ADMIN` は提出する側なので受託施設で許す。
   */
  "dailyReport.read": { write: false },
  /**
   * 日報の生成・再生成（§9.3「PROPERTY_MANAGER 以上が手動再生成可能」）。
   *
   * 自動生成は cron が行い、この権限を通らない（セッションが無い）。
   * ここが守るのは**手動で版を増やす操作**。版は消せないので、
   * 誰でも押せる形にしない。
   */
  "dailyReport.generate": { write: true },
  /**
   * 観察記録の閲覧（M-05 / W-19 / PK-SPEC-P3 §2.1・§4.1）。
   *
   * **`CLEANER` / `INSPECTOR` を許す。** 入室時の記録は現場が入力するもので、
   * 自分が入れた値を確認できないと入力し直しができない。一覧（W-19）で
   * 他人のタスクが混ざるのは施設の記録として当然の範囲（担当施設に限る）。
   *
   * **差異レポート（`finding.read`）とは別物。** こちらは観察した数そのもので、
   * 判定は P3 に存在しない（§0.2）。P4 が差異を作っても、その到達は
   * `finding.read` が引き続き `CLEANER` / `INSPECTOR` に `DENY` を返す。
   */
  "observation.read": { write: false },
  /**
   * 観察記録・リネン記録の入力（§4.1・§4.3）。
   *
   * `task.write` と同じ並び。**記録するのは清掃した本人**で、
   * `INSPECTOR` も自分が清掃したタスクでは入力しうる（§4.2 の例外と同じ位置）。
   * `AUDITOR` は `DENY`（security.md §1「書き込み操作を一切できない」）。
   */
  "observation.write": { write: true },
  /**
   * 観察記録の事後修正（§2.2 MUST / P3-07）。**`PROPERTY_MANAGER` 以上。**
   *
   * `observation.write`（現場の入力）と分けてある。事後の書き換えは
   * 「作業の記録」ではなく「後から数を直す」判断で、security.md §6 が
   * 監査対象に挙げている操作（`observation.amended` / 理由必須）。
   * **`VENDOR_ADMIN` は `DENY`。** 受託した清掃会社が自社の記録を後から
   * 直せると、その記録が P4 の照合の根拠にならない。
   */
  "observation.amend": { write: true },
  /**
   * 施設ごとの観察項目の設定（W-20 / §2.6・§6.1）。
   *
   * §6.1 の担当ロールは `ORG_ADMIN`。**閲覧は施設責任者にも開く**
   * （自分の施設で何が入力対象かを知らないと、未記録率の話ができない）。
   */
  "observationConfig.read": { write: false },
  /** 同上の変更。§6.1 の担当ロールどおり `ORG_ADMIN` 以上のみ。 */
  "observationConfig.write": { write: true },
  /**
   * 消耗ベースラインの閲覧（W-21 / §5・§6.1）。
   *
   * §6.1 の担当ロールは `ORG_ADMIN`。**施設責任者にも開く**（自分の施設で
   * 何枚が通常なのかは、備品の手配をする側が知っている必要がある）。
   * **`CLEANER` / `INSPECTOR` は `DENY`。** ベースラインは P4 の照合の
   * 閾値そのもので、現場に見せると「この枚数までなら気づかれない」を
   * 示すことになる（security.md §1 の差異レポートと同じ扱い）。
   */
  "baseline.read": { write: false },
  /**
   * p90 の手動上書き（§5.5 / W-21）。**`ORG_ADMIN` 以上のみ。**
   *
   * §5.5 が名指ししているロール。上書きは P4 の判定を動かすため、
   * 施設責任者にも開かない。理由必須・監査ログ（security.md §6）。
   */
  "baseline.override": { write: true },
  /**
   * 入力品質の閲覧（W-22 / §6.3）。
   *
   * §6.1 の担当ロールは `ORG_ADMIN`。**施設責任者にも開く**（未記録率の
   * フォローをするのは施設側）。**`VENDOR_ADMIN` は `DENY`。** スタッフ別の
   * 入力率が含まれ、受託先が他社スタッフの記録状況を見る形になる。
   * `AUDITOR` は読取のみ許す（内部統制の確認）。
   */
  "dataQuality.read": { write: false },
} as const satisfies Record<string, { write: boolean }>;

/** `PERMISSION_ACTIONS` に載っている操作だけを許す型。 */
export type PermissionAction = keyof typeof PERMISSION_ACTIONS;

/** 全アクション。テストと網羅検査のために配列でも持つ。 */
export const PERMISSION_ACTION_LIST = Object.keys(PERMISSION_ACTIONS) as readonly PermissionAction[];

/** 状態を変える操作か。 */
export function isWriteAction(action: PermissionAction): boolean {
  return PERMISSION_ACTIONS[action].write;
}

// ────────────────────────────────────────────────────────────
// スコープと対象
// ────────────────────────────────────────────────────────────

/**
 * マトリクスのセルが取る値。
 *
 * | 値 | 意味 |
 * |---|---|
 * | `DENY` | 常に拒否。404 |
 * | `ORG` | 組織全体。対象を問わず許可 |
 * | `ASSIGNED` | `ctx.allowedPropertyIds` に含まれる施設の資源のみ |
 *
 * **`SELF`（自分の記録のみ）は意図的に持たせていない。** M-11（自分の記録の
 * 閲覧 / security.md §5）が要求するが、P0 に対象の資源が無く、判定に
 * `target.userId` が要る。**その画面を作る task がここに 1 値足すこと。**
 */
export type PermissionScope = "DENY" | "ORG" | "ASSIGNED";

/**
 * 権限の対象。
 *
 * **クライアントが送った `propertyId` をここへ入れてはならない**（INV-32）。
 * 必ず資源そのものから解決した値を渡す（例: `taskId` → その task の
 * `propertyId`）。パス変数を直に流し込むと、`ASSIGNED` の判定が
 * 「自分で申告した施設と自分の担当施設を突き合わせる」だけになり、
 * 何も守らない。
 */
export type PermissionTarget =
  /** 組織全体に属する資源（組織設定・税務プロファイル・ユーザー一覧）。 */
  | { kind: "ORGANIZATION" }
  /** 施設に属する資源。`propertyIds` はサーバー側で解決した値。 */
  | { kind: "PROPERTY"; propertyIds: readonly string[] };

/**
 * 組織全体の資源を表す対象。
 *
 * **第 3 引数を省略可能にしていない。** 省略を許すと「施設で絞るべき資源なのに
 * 対象を書き忘れた」場合と区別がつかず、静かに広い側へ倒れる
 * （`repositories/base.ts` の `NO_PROPERTY_SCOPE` と同じ方針）。
 */
export const ORGANIZATION_TARGET: PermissionTarget = { kind: "ORGANIZATION" };

/** 施設に属する資源の対象を作る。 */
export function propertyTarget(propertyIds: readonly string[]): PermissionTarget {
  return { kind: "PROPERTY", propertyIds };
}

// ────────────────────────────────────────────────────────────
// マトリクス
// ────────────────────────────────────────────────────────────

/**
 * 7 ロール × 全アクションの権限マトリクス。
 *
 * ── 既定値を持たない ────────────────────────────────────
 * 型が `Record<PermissionAction, Record<Role, PermissionScope>>` なので、
 * **セルを 1 つでも書き漏らすとコンパイルが通らない。** 「表に無いロールは
 * とりあえず拒否」のようなフォールバックを実装しないこと。フォールバックが
 * あると、ロールやアクションを足したときに「意図して DENY にした」のか
 * 「書き忘れた」のかがコードから読めなくなる。
 *
 * ── 太字の根拠（security.md §1「絶対に守る境界」）──────
 *   - `CLEANER` / `INSPECTOR` は差異レポートに到達できない → `finding.read`
 *   - `CLEANER` は忘れ物の保管場所・返却先を見られない → `lostItem.readStorage`
 *   - `INSPECTOR` は請求情報を見られない → `billing.read`
 *   - `AUDITOR` は書き込み操作を一切できない → 全 `write` 行
 *   - `VENDOR_ADMIN` は受託外施設を見られない → `ASSIGNED`
 */
export const PERMISSION_MATRIX: Record<PermissionAction, Record<Role, PermissionScope>> = {
  // 組織名は全ロールの画面に出る。個人情報も施設の情報も含まない。
  "organization.read": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ORG",
    INSPECTOR: "ORG",
    CLEANER: "ORG",
    VENDOR_ADMIN: "ORG",
    AUDITOR: "ORG",
  },
  // 設定画面。`CLEANER` は到達できない（P0-10 完了条件）。
  "organization.write": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "DENY",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "DENY",
  },
  // 登録番号・端数処理は請求の前提。閲覧は組織全体ロールと監査のみ。
  "taxProfile.read": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "DENY",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "ORG",
  },
  "taxProfile.write": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "DENY",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "DENY",
  },
  // OPEN_QUESTIONS #016 の回答。**読み取りは施設スコープロールも組織全体。**
  // 同僚の表示名・スタッフ番号が見えることを許す判断（DECISIONS #023）。
  "user.read": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ORG",
    INSPECTOR: "ORG",
    CLEANER: "ORG",
    VENDOR_ADMIN: "ORG",
    AUDITOR: "ORG",
  },
  // **書き込みは自施設のみ。** `PROPERTY_MANAGER` は担当施設に割り当てられた
  // ユーザーだけを触れる。`VENDOR_ADMIN` が自社スタッフを招待できるかは
  // security.md §1 に明記が無いため DENY。広げるのは招待画面を作る task。
  "user.write": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "DENY",
  },
  // `scopeToProperties()` と同じ境界。施設スコープロールは担当施設のみ。
  "property.read": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "ASSIGNED",
    CLEANER: "ASSIGNED",
    VENDOR_ADMIN: "ASSIGNED",
    AUDITOR: "ORG",
  },
  "property.write": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "DENY",
  },
  // security.md §1: `CLEANER` も `INSPECTOR` も到達できない。404 を返す。
  "finding.read": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "ASSIGNED",
    AUDITOR: "ORG",
  },
  // PK-SPEC-P4 §6.4: 手動再実行は OWNER / ORG_ADMIN だけ。
  "reconciliation.run": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "DENY",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "DENY",
  },
  // PK-SPEC-P4 §6.4: 状態の変更は OWNER / ORG_ADMIN だけ（表のとおり）。
  "finding.write": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "DENY",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "DENY",
  },
  // P4-10。**登録は抑制を作る操作**（§4.1）。現場ロールと受託側には与えない
  // （`PERMISSION_ACTIONS` の注記 / DECISIONS #115）。
  "roomAccess.read": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "ORG",
  },
  "roomAccess.write": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "DENY",
  },
  // PK-SPEC-P4 §6.4: ルール設定は OWNER / ORG_ADMIN だけ。
  // **施設責任者にも開かない**（閾値は判定の内側の値）。
  "ruleConfig.read": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "DENY",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "ORG",
  },
  "ruleConfig.write": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "DENY",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "DENY",
  },
  // P5-02 / P5-03。単価は取引条件（`PERMISSION_ACTIONS` の注記）。
  // 閲覧は `billing.read` と同じ、**書き込みは組織全体ロールだけ。**
  "counterparty.read": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "ORG",
  },
  "counterparty.write": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "DENY",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "DENY",
  },
  // security.md §1: `CLEANER` は保管場所・返却先を見られない。
  "lostItem.readStorage": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "ASSIGNED",
    CLEANER: "DENY",
    VENDOR_ADMIN: "ASSIGNED",
    AUDITOR: "ORG",
  },
  // security.md §1: `INSPECTOR` は請求情報を見られない。
  // `VENDOR_ADMIN`（清掃会社）が受託分の請求を見られるかは明記が無く DENY。
  // 広げるのは P5（請求・領収・多施設）の task。
  "billing.read": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "ORG",
  },
  // ── P1: 清掃タスク ──────────────────────────────────
  // `INSPECTOR` は検査担当。P2 で検査画面が入るまで自分の対象を見る必要がある
  // （§5.2 の `AWAITING_INSPECTION`）ので閲覧は担当施設で許す。
  "task.read": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "ASSIGNED",
    CLEANER: "ASSIGNED",
    VENDOR_ADMIN: "ASSIGNED",
    AUDITOR: "ORG",
  },
  // §5.3 の「担当者本人、P_MANAGER 以上」。`INSPECTOR` は清掃を行わない
  // （検査の書き込みは P2 が別のアクションで足す）。
  "task.write": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "DENY",
    CLEANER: "ASSIGNED",
    VENDOR_ADMIN: "ASSIGNED",
    AUDITOR: "DENY",
  },
  // §5.3: assign / cancel は「P_MANAGER 以上、VENDOR_ADMIN」。
  "task.manage": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "ASSIGNED",
    AUDITOR: "DENY",
  },
  // W-16 / W-17 は §10.1 で `ORG_ADMIN` の画面。**施設責任者に広げない。**
  // 「管理職だから」で広げないこと（PK-IMPL-CONTRACT §11.5）。
  "checklistTemplate.read": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "DENY",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "ORG",
  },
  "checklistTemplate.write": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "DENY",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "DENY",
  },
  "standardTime.read": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "DENY",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "ORG",
  },
  "standardTime.write": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "DENY",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "DENY",
  },
  // W-05 は §10.1 で `P_MANAGER 以上`。`VENDOR_ADMIN` は稼働予定の入力者では
  // ないため明記が無く DENY（広げるのは根拠を持つ task）。
  "roomPlan.read": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "ORG",
  },
  "roomPlan.write": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "DENY",
  },
  // PK-SPEC-P4 §8.1 の取込。`roomPlan.*` と同じ配り方（上の注記）。
  // `VENDOR_ADMIN`（清掃会社）は稼働記録の持ち主ではないため DENY。
  "occupancy.read": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "ORG",
  },
  "occupancy.write": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "DENY",
  },
  // §11.2 は「施設責任者は客室ステータスを手動で変更できる」。
  // `VENDOR_ADMIN`（清掃会社）に明記が無いため DENY（広げるのは根拠を持つ task）。
  "room.statusOverride": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "DENY",
  },
  // M-11。**全ロールが自分の記録を見られる**（security.md §5 MUST）。
  // `AUDITOR` も読み取りなので許す。対象は常に自分で、他人は選べない。
  "task.readOwn": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ORG",
    INSPECTOR: "ORG",
    CLEANER: "ORG",
    VENDOR_ADMIN: "ORG",
    AUDITOR: "ORG",
  },
  // ── P2: 検査 ────────────────────────────────────────
  // §5.1 の自動割当は `INSPECTOR` と `PROPERTY_MANAGER` を対象にする。
  // `VENDOR_ADMIN`（清掃会社）が受託施設の検査を行うかは §4・§5 に明記が
  // 無いため DENY（自社の清掃を自社が検査する形になり、§4.2 の
  // 自己検査の制限と整合しない）。広げるのは根拠を持つ task。
  "inspection.read": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "ASSIGNED",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "ORG",
  },
  "inspection.write": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "ASSIGNED",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "DENY",
  },
  // ── P2-07: 差戻しと再清掃 ──────────────────────────────
  // **`CLEANER` を許す唯一の検査系アクション**（§4.6）。`INSPECTOR` も許すのは
  // 差し戻した内容を再検査のときに読み直す必要があるため（§4.6 の「次回検査へ
  // 紐づける」）。「自分の差戻しか」の絞りはここでは掛からない
  // （`assertReworkVisible()` が掛ける）。
  "rework.read": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "ASSIGNED",
    CLEANER: "ASSIGNED",
    VENDOR_ADMIN: "ASSIGNED",
    AUDITOR: "ORG",
  },
  // `task.write` と同じ並び。**`INSPECTOR` は DENY**（§1.1 の分離）。
  "rework.write": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "DENY",
    CLEANER: "ASSIGNED",
    VENDOR_ADMIN: "ASSIGNED",
    AUDITOR: "DENY",
  },
  // §4.7「PROPERTY_MANAGER 以上」。**`VENDOR_ADMIN` に広げない。**
  "rework.waive": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "DENY",
  },
  // ── P2-16: 残存タスクの緊急上書き（§13.3）────────────────
  // `rework.waive` と同じ並び。「検査を経ずに客室を READY にする」判断は
  // 施設責任者以上のものにする。
  "inspection.emergencyOverride": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "DENY",
  },
  // 証跡 ZIP の持ち出し（§6.5）。**現場ロールは DENY。**
  // `INSPECTOR` / `CLEANER` は自分の作業の記録を M-09 / M-11 で見られるが、
  // 書庫として組織の外へ出す操作は運営側のもの。`VENDOR_ADMIN` も DENY
  // （受託した清掃会社が施設の証跡一式を持ち出せる形にしない）。
  // `AUDITOR` の DENY は上の注記（OPEN_QUESTIONS #048）。
  "evidence.export": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "DENY",
  },
  // ── P2-11 忘れ物（§7.4）──────────────────────────────
  // 「`CLEANER`: 登録と自分が登録した内容の閲覧」。**自分の分だけ**という
  // 絞りは応答の組み立て側（`lib/report/lostItem.ts`）。
  "lostItem.read": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "ASSIGNED",
    CLEANER: "ASSIGNED",
    VENDOR_ADMIN: "ASSIGNED",
    AUDITOR: "ORG",
  },
  // 登録は現場が行う（§7.1「発見 → その場で写真・カテゴリ・場所を登録」）。
  "lostItem.write": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "ASSIGNED",
    CLEANER: "ASSIGNED",
    VENDOR_ADMIN: "ASSIGNED",
    AUDITOR: "DENY",
  },
  // 状態の更新。**`CLEANER` は DENY**（§7.4 は登録と閲覧まで）。
  // `INSPECTOR` は「保管済への更新」だけで、遷移先の絞りは使用側。
  "lostItem.manage": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "ASSIGNED",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "DENY",
  },
  // ── P2-12 設備不具合（§8）────────────────────────────
  "issue.read": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "ASSIGNED",
    CLEANER: "ASSIGNED",
    VENDOR_ADMIN: "ASSIGNED",
    AUDITOR: "ORG",
  },
  // §8.1「清掃中または検査中に不具合を発見した場合」。現場が報告する。
  "issue.write": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "ASSIGNED",
    CLEANER: "ASSIGNED",
    VENDOR_ADMIN: "ASSIGNED",
    AUDITOR: "DENY",
  },
  // 対応の判断は運営側。**現場は報告するだけ。**
  "issue.manage": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "DENY",
  },
  // ── P2-14 日報（§9.1・§9.3・§9.6）────────────────────
  // 提出する側（`VENDOR_ADMIN`）と受け取る側（施設・運営）が読む。
  // **現場ロール（`INSPECTOR` / `CLEANER`）は DENY**（上の注記）。
  "dailyReport.read": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "ASSIGNED",
    AUDITOR: "ORG",
  },
  // §9.3「PROPERTY_MANAGER 以上が手動再生成可能」。
  // `VENDOR_ADMIN` は DENY（版を増やせるのは施設側の判断）。
  "dailyReport.generate": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "DENY",
  },
  // ── P3-03〜P3-07 / P3-11 観察記録（PK-SPEC-P3 §2・§4・§6.1）──
  // 現場が入力し、現場が自分の入れた値を見る。**判定はここに無い**（§0.2）。
  "observation.read": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "ASSIGNED",
    CLEANER: "ASSIGNED",
    VENDOR_ADMIN: "ASSIGNED",
    AUDITOR: "ORG",
  },
  "observation.write": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "ASSIGNED",
    CLEANER: "ASSIGNED",
    VENDOR_ADMIN: "ASSIGNED",
    AUDITOR: "DENY",
  },
  // §2.2 MUST「事後修正は PROPERTY_MANAGER 以上のみ」。
  "observation.amend": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "DENY",
  },
  "observationConfig.read": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "ORG",
  },
  // §6.1 の担当ロールは `ORG_ADMIN`。施設責任者は読むだけ。
  "observationConfig.write": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "DENY",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "DENY",
  },
  // ── P3-09〜P3-12 ベースラインと入力品質（同 §5・§6.2・§6.3）──
  // **現場ロールは到達しない。** 閾値は照合の内側の値（`PERMISSION_ACTIONS`
  // の注記）。
  "baseline.read": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "ORG",
  },
  // §5.5「ORG_ADMIN はベースラインの p90 を手動で上書きできる」。
  "baseline.override": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "DENY",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "DENY",
  },
  "dataQuality.read": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "ORG",
  },
};

// ────────────────────────────────────────────────────────────
// 判定
// ────────────────────────────────────────────────────────────

/** ロールとアクションからスコープを引く。判定そのものは `can()`。 */
export function resolveScope(role: Role, action: PermissionAction): PermissionScope {
  return PERMISSION_MATRIX[action][role];
}

/**
 * 権限があるかを返す。**throw しない。**
 *
 * ナビゲーションの出し分けなど、「無ければ出さない」だけの用途に使う。
 * **これで分岐したからといって `assertPermission()` を省かないこと。**
 * 画面を隠すのは UX 上の措置で、権限制御ではない（security.md §1）。
 */
export function can(
  ctx: TenantContext,
  action: PermissionAction,
  target: PermissionTarget,
): boolean {
  const scope = resolveScope(ctx.role, action);
  if (scope === "DENY") return false;
  if (scope === "ORG") return true;

  // ASSIGNED。組織全体ロールがここへ来ることは無い（マトリクス上 ORG のため）が、
  // 来ても `allowedPropertyIds` は空なので拒否になる。`isOrgWideRole()` を
  // ここで参照しないのは、判定の根拠をマトリクス 1 か所に閉じるため。
  if (target.kind !== "PROPERTY") {
    // 施設で絞れない対象を、施設スコープの権限で通さない。
    return false;
  }
  if (target.propertyIds.length === 0) {
    // 施設が 1 つも紐付かない資源。担当施設に含まれると言えないので拒否。
    // 結果として `PROPERTY_MANAGER` は施設割当を持たないユーザーを作れない。
    // 招待 API は「招待と施設割当を同時に行う」形にすること（P0-10 申し送り）。
    return false;
  }

  const allowed = new Set(ctx.allowedPropertyIds);
  // **部分集合であること。交差ではない。** 担当施設 A と担当外 B にまたがる
  // 資源を交差で許すと、B に対する影響力が生まれる。
  return target.propertyIds.every((propertyId) => allowed.has(propertyId));
}

/**
 * 権限が無ければ `NotFoundError` を投げる。**API ハンドラはこれを呼ぶ。**
 *
 * ── なぜ boolean を返さないのか ─────────────────────────
 * `can()` を主にすると `if (!can(...)) return 404` の**書き忘れが型で通り、
 * 素通りする。** throw なら、呼んでいない経路は「判定が無い」として
 * レビューとテストに残る。失敗の形を「余分に見える」から
 * 「例外が飛ぶ」へ寄せる（`scopeToProperties()` と同じ方針 / DECISIONS #017）。
 *
 * ── 403 ではなく 404 ────────────────────────────────────
 * 投げるのは `@pk/db` の `NotFoundError`。**このファイルで再定義しない**
 * （同名クラスが 2 つあると `instanceof` が片方で外れ、404 のはずが 500 になる /
 * `packages/db/src/errors.ts` の申し送り）。HTTP への写像は
 * `middleware/resourceGuard.ts` が一元的に行う。
 */
export function assertPermission(
  ctx: TenantContext,
  action: PermissionAction,
  target: PermissionTarget,
): void {
  if (!can(ctx, action, target)) throw new NotFoundError();
}

/**
 * 組織全体ロールか（`@pk/db` の再エクスポート）。
 *
 * マトリクスの不変条件テストが参照する。判定そのものには使わない
 * （根拠を `PERMISSION_MATRIX` 1 か所に閉じるため）。
 */
export { isOrgWideRole };
