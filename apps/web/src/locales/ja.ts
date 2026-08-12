/**
 * UI 文言（日本語）。**JSX に文字列を直書きしないための置き場**（ui-writing.md §1）。
 *
 * task: docs/tasks/P0-14.md
 *
 * ── ここは i18n 基盤ではない ────────────────────────────
 * `t()` の本実装・`en` の雛形・言語のユーザー属性での保持は **P0-15 の担当**。
 * P0-14 は「JSX から日本語を追い出す」ためだけに、キーと日本語の対応表を置く。
 * P0-15 はこの表を JSON へ移し、言語の選択を足す。**キー名は据え置けるように
 * 画面ごとの接頭辞（`nav.` `login.` …）を付けてある。**
 *
 * ── 文言の制約 ──────────────────────────────────────────
 * このファイルは `locales/` 配下として `pk/no-forbidden-words` の対象
 * （`packages/config/eslint/base.js` の files を参照）。
 * 「監視」「不正」「異常」「エラー」「失敗」などは書けない（ui-writing.md §2 /
 * PK-IMPL-CONTRACT §5.1）。状態は事実として述べる。
 */

export const ja = {
  // ── 共通 ──────────────────────────────────────────────
  "app.brand": "ProofKeeping",
  "app.title": "ProofKeeping",

  // ── ログイン（P0-08 の 3 フィールド）────────────────────
  "login.title": "ログイン",
  "login.subtitle": "オーナー・施設管理者の方はこちら",
  "login.orgShortId": "組織 ID",
  "login.orgShortId.hint": "6 桁の英数字",
  "login.staffNumber": "スタッフ番号",
  "login.password": "パスワード",
  "login.submit": "ログイン",
  "login.rejected": "組織 ID・スタッフ番号・パスワードのいずれかが一致しません。",
  "login.rateLimited": "しばらく時間をおいてから、もう一度お試しください。",
  "login.invalid": "入力の形式をご確認ください。",
  "login.forCleaner": "清掃スタッフの方はモバイル画面をご利用ください。",

  // ── ナビゲーション（ui-prototypes/owner/pkown-v3-A-login-daily.html）──
  "nav.section.daily": "日次運用",
  "nav.section.records": "記録の確認",
  "nav.section.analysis": "資材と分析",
  "nav.section.settings": "設定",
  "nav.dashboard": "ダッシュボード",
  "nav.board": "客室ボード",
  "nav.findings": "稼働の差異",
  "nav.findingDetail": "差異の詳細",
  "nav.cleaningRecords": "清掃記録",
  "nav.inspection": "検査・再清掃",
  "nav.linen": "リネン消費",
  "nav.report": "月次レポート",
  "nav.billing": "契約と請求",
  "nav.propertySettings": "施設設定",
  "nav.permission": "権限と監査",
  /** 未購入モジュール。到達できないことではなく、契約の状態を述べる。 */
  "nav.locked": "ご契約に含まれていません",
  "nav.locked.notice":
    "この機能はご契約のプランに含まれていません。ご利用には追加のお手続きが必要です。",
  /** 画面が未実装の項目。順次追加されることだけを述べる。 */
  "nav.planned": "準備中",

  // ── サイドバー フッター（PK-SPEC-UI-A01 §4.3）────────────
  "sidebar.scope.org": "閲覧範囲：組織全体",
  "sidebar.scope.assigned": "閲覧範囲：担当施設のみ",
  "sidebar.scope.readonly": "閲覧のみ（記録の変更はできません）",

  // ── 施設セレクタ（要約表示と全社サマリーは P0-21）────────
  "property.switch": "施設の切り替え",
  "property.current": "表示中の施設",
  "property.roomCount": "室",
  "property.none": "表示できる施設がありません。管理者にお問い合わせください。",

  // ── ユーザーメニュー（PK-SPEC-UI-A01 §3.3）──────────────
  "user.menu": "アカウント",
  "user.logout": "ログアウト",
  "role.OWNER": "オーナー",
  "role.ORG_ADMIN": "運営管理者",
  "role.PROPERTY_MANAGER": "施設責任者",
  "role.INSPECTOR": "検査担当",
  "role.CLEANER": "清掃スタッフ",
  "role.VENDOR_ADMIN": "清掃会社管理者",
  "role.AUDITOR": "監査閲覧",
  "role.scope.org": "全施設",
  "role.scope.assigned": "担当施設",

  // ── ダッシュボード（中身は後続 task）────────────────────
  "dashboard.title": "ダッシュボード",
  "dashboard.placeholder": "各画面は順次追加されます。",

  // ── 画面共通の状態表示 ──────────────────────────────────
  "page.notFound": "お探しの画面は見つかりませんでした。",
  "page.unexpected": "画面を表示できませんでした。時間をおいてお試しください。",
} as const;

/** 文言のキー。**この型に無いキーはコンパイルが通らない。** */
export type MessageKey = keyof typeof ja;
