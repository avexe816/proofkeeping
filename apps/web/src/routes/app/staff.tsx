import {
  fieldStaffCreateSchema,
  FIELD_STAFF_ROLES,
  RESIDENCY_STATUS_TYPE_VALUES,
  STAFF_LOCALES,
} from "@pk/contracts";
import {
  countExpiringResidencies,
  listOrgStaff,
  listResidencyRecords,
  listStaffLedger,
  listStaffPropertyAssignments,
} from "@pk/db";
import {
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import {
  ORGANIZATION_TARGET,
  assertPermission,
  can,
  propertyTarget,
} from "../../lib/auth/permission.js";
import { businessDateOf } from "../../lib/businessDate.js";
import { t } from "../../lib/i18n.js";
import { listSelectableProperties } from "../../lib/property/selection.js";
import { encodeQr, qrPath } from "../../lib/qr/encode.js";
import {
  buildStaffLedger,
  expiringStaff,
  filterStaffRows,
  parseStaffFilter,
  STAFF_FILTERS,
  type StaffFilter,
  type StaffLedgerPage,
  type StaffLedgerView,
} from "../../lib/staff/ledger.js";
import {
  loadStaffDetail,
  setStaffActive,
  updateStaff,
  type StaffDetail,
  type StaffDetailExtra,
  type StaffEditResult,
} from "../../lib/staff/edit.js";
import { saveResidency, type ResidencySaveResult } from "../../lib/staff/residency.js";
import { recordResidencyView } from "../../lib/staff/residencyAudit.js";
import { registerFieldStaff } from "../../lib/staff/register.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

/**
 * 現場スタッフの登録と、現場掲示用の案内（PK-SPEC-P7 §2.3 Step 5 / §2.4 v1.1）。
 *
 *   /app/settings/staff
 *
 * task: docs/tasks/P7-02.md
 * 決定: docs/DECISIONS.md #177 / #181 / #184 / #186
 *
 * ── PDF ではなく印刷用 HTML（§2.4 v1.1 / DECISIONS #184）──
 * 初版は「QR コード付きの現場掲示用 PDF」だったが、PDF は Queue
 * コンシューマ内でしか作らない決まり（CLAUDE.md §2）で、一方 初期 PIN は
 * 保存せず作成の応答で 1 回だけ返す（DECISIONS #177）。Queue へ投げると
 * **PIN をメッセージに載せる**ことになり、両立しない。**人間の判断**で
 * 印刷用 HTML に変えた。印刷はブラウザの印刷機能を使う。
 *
 * ── PIN が通る経路をここで閉じる ────────────────────────
 * PIN が現れるのは **`action` の戻り値だけ。**
 *
 *   loader へ渡さない      GET なので URL にも履歴にも残る
 *   Queue へ渡さない       消し忘れも漏れも起こしようが無い状態を保つ
 *   DB へ書かない          保存するのはハッシュだけ（DECISIONS #177）
 *   監査ログへ載せない     `registerFieldStaff()` の `after` に入れていない
 *   QR に載せない          QR はログイン URL 1 本だけ
 *
 * **画面を再読込すると案内は消える。** 消えるのが正しい。控え損ねたら
 * PIN リセット（管理者のみ・監査ログ）でやり直す。
 *
 * ── QR はブラウザ側で作る（DECISIONS #184）──────────────
 * `lib/qr` は依存ゼロの純粋なコードで、`packages/pdf` を汚さない。
 * 描くのは SVG のパス 1 本で、外部の画像も CDN も読まない。
 * **QR に PIN も組織 ID も入れない。** §2.4 の掲示物は QR の下に
 * 文字で印字する形（QR は「サイトを開く」ためだけのもの）。
 */

/** 印刷する案内 1 枚ぶん。**`action` の戻り値としてだけ存在する。** */
interface LoginCard {
  displayName: string;
  staffNumber: string;
  orgShortId: string;
  /** **1 回だけ現れる 4 桁。** 保存も再表示もできない。 */
  initialPin: string;
  /** QR に載せるログイン URL。**秘密を含まない。** */
  loginUrl: string;
}

interface StaffProperty {
  id: string;
  code: string;
  name: string;
}

/**
 * 右からスライドインするレイヤーの中身（人間の指示 2026-08-22）。
 *
 * **開いているかどうかを URL に持つ。** `?panel=new` で登録、
 * `?panel={membershipId}` で 1 名の詳細。絞り込み（`?status=`）と
 * 同じ扱いで、画面を共有したときに同じものが開く。
 *
 * ── なぜ `useState` にしないのか ────────────────────────
 * 中身がサーバーの値（担当施設・連絡先）だからで、状態を画面側に
 * 持つと、開いた瞬間に別の口でもう一度引くことになる。URL に持てば
 * loader が 1 回で返し、**JS が動かなくても開く。** 戻るボタンで
 * 閉じるのも素直に効く。
 */
type StaffPanel =
  | { mode: "NEW" }
  | { mode: "DETAIL"; detail: StaffDetail };

interface StaffData {
  properties: StaffProperty[];
  /** 台帳（P8-01 / プロトタイプ ops 07）。 */
  ledger: StaffLedgerPage;
  /** **在留期限の列を出すか**（INV-08 v2。`OWNER` / `ORG_ADMIN` が真）。 */
  canReadResidency: boolean;
  /** **在留資格を記録できるか**（`ORG_ADMIN` のみ。`OWNER` は読めても書けない）。 */
  canWriteResidency: boolean;
  /** 一覧の絞り込み（プロトタイプ ops 07 の「全員 / 稼働中 / 研修中」）。 */
  filter: StaffFilter;
  /** レイヤー。閉じているときは `null`。 */
  panel: StaffPanel | null;
  /** 直前の保存の結果。無ければ `null`。 */
  saved: SavedKind | null;
}

/** 保存の種類。**この 4 つ以外は出さない**（URL から来る値なので絞る）。 */
const SAVED_KINDS = ["UPDATED", "DEACTIVATED", "REACTIVATED", "RESIDENCY"] as const;

type SavedKind = (typeof SAVED_KINDS)[number];

function parseSaved(value: string | null): SavedKind | null {
  return (SAVED_KINDS as readonly string[]).includes(value ?? "") ? (value as SavedKind) : null;
}

type StaffActionResult =
  | { card: LoginCard }
  | { invalid: true }
  | { duplicate: true }
  /** 在留資格の保存結果（P8-02）。型は `lib/staff/residency.ts` が持つ。 */
  | ResidencySaveResult
  /** 編集・無効化の結果（型は `lib/staff/edit.ts` が持つ）。 */
  | StaffEditResult;

export async function loader({ request, context }: LoaderFunctionArgs): Promise<StaffData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);
  // **一覧を出す前に権限を見る。** `CLEANER` / `INSPECTOR` / `AUDITOR` は
  // ここで 404（403 はリソースの存在を示唆する / architecture.md §2）。
  assertPermission(tenant, "user.write", propertyTarget(tenant.allowedPropertyIds));

  const properties = await listSelectableProperties(env, tenant);

  // ── 在留期限は読める相手にだけ引く（INV-08）──────────────
  // **`can()` で分岐したうえで、読めないときは引かない。** 引いてから
  // 画面で隠す形にすると、loader の戻り値（= HTML に載る JSON）に
  // 期限が残る。件数の KPI は誰にでも出せる（個人を特定しない）。
  const canReadResidency = can(tenant, "residency.read", ORGANIZATION_TARGET);
  // **読めるだけでは書けない。** `residency.write` は `ORG_ADMIN` のみで、
  // `OWNER` は読めても書けない（permission.ts「編集は広げていない」）。
  // 読めるかどうかでフォームを出すと、`OWNER` に押せない口が見える。
  const canWriteResidency = can(tenant, "residency.write", ORGANIZATION_TARGET);
  const businessDate = businessDateOf(now);
  const expiryHorizon = addDays(businessDate, 90);

  const [staff, ledgerRows, residency, expiringWithin90Days, assignments] = await Promise.all([
    listOrgStaff(env, tenant),
    listStaffLedger(env, tenant),
    canReadResidency ? listResidencyRecords(env, tenant) : Promise.resolve([]),
    countExpiringResidencies(env, tenant, expiryHorizon),
    listStaffPropertyAssignments(env, tenant),
  ]);

  // 在留資格を実際に読んだときだけ記録する（INV-08 v2 / DECISIONS #261）。
  // **口はこのファイルに置かない** — ここは初期 PIN を運ぶ画面で、
  // 監査ログの口と同居させない（`staffScreen.spec.ts`）。
  // 値も氏名も渡せない形にしてある（`recordResidencyView()` の注記）。
  if (canReadResidency) {
    await recordResidencyView(env, tenant, { actorId: session.membershipId });
  }

  // ── レイヤーは開いている 1 名ぶんだけを引く ────────────────
  // 一覧（`listOrgStaff()`）に連絡先を混ぜない。混ぜると組織全員の
  // メールアドレスが HTML に載る（在留期限と同じ考え方 / INV-08）。
  // **知らない ID は `assertIdBelongsToTenant()` が 404 にする。**
  const panelParam = new URL(request.url).searchParams.get("panel");
  const panel: StaffPanel | null =
    panelParam === null || panelParam === ""
      ? null
      : panelParam === "new"
        ? { mode: "NEW" }
        : await detailPanel(env, tenant, panelParam, {
            // 台帳の行 ID は一覧の組み立てから引き当てる（もう一度引かない）。
            staffProfileId:
              ledgerRows.find((row) => row.membershipId === panelParam)?.id ?? null,
            // **読める相手にだけ渡す**（`loadStaffDetail()` の注記 / INV-08）。
            ...(canReadResidency ? { residency } : {}),
          });

  return {
    panel,
    properties: properties.map((property) => ({
      id: property.id,
      code: property.code,
      name: property.name,
    })),
    ledger: buildStaffLedger({
      staff,
      ledger: ledgerRows,
      residency,
      businessDate,
      expiringWithin90Days,
      assignments,
      propertyNames: new Map(properties.map((property) => [property.id, property.name])),
    }),
    canReadResidency,
    canWriteResidency,
    // **絞りは URL に置く。** 画面を共有したときに同じ見え方になる。
    filter: parseStaffFilter(new URL(request.url).searchParams.get("status")),
    // 直前の保存の結果（`savedRedirect()` が付ける）。**リダイレクトを挟むので
    // `useActionData` には残らない。** 知らない値は出さない。
    saved: parseSaved(new URL(request.url).searchParams.get("saved")),
  };
}

/**
 * 1 名ぶんのレイヤー。**見つからなければ閉じたまま返す。**
 *
 * 無効化したスタッフの ID を踏んでも開く（`listOrgStaff()` が退職者も
 * 返すのと同じ理由 — 再開の入口がこのレイヤーしか無い）。
 */
async function detailPanel(
  env: ReturnType<typeof getEnv>,
  tenant: Parameters<typeof loadStaffDetail>[1],
  membershipId: string,
  extra: StaffDetailExtra,
): Promise<StaffPanel | null> {
  const detail = await loadStaffDetail(env, tenant, membershipId, extra);
  return detail === undefined ? null : { mode: "DETAIL", detail };
}

/** `YYYY-MM-DD` に日を足す。**業務日の文字列のまま扱う**（architecture.md §7）。 */
function addDays(businessDate: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(businessDate);
  if (match === null) return businessDate;
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days);
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * Zod の `message` を文言のキーへ写す。
 *
 * **理由を出し分ける。** 「入力を確認してください」だけだと、
 * 期限が必須だったのか日付の前後が逆だったのかが分からない。
 */
function residencyErrorKey(message: string): Parameters<typeof t>[0] {
  if (message === "EXPIRES_ON_REQUIRED") return "staff.residency.error.expiresOnRequired";
  if (message === "RENEWAL_AFTER_EXPIRY") return "staff.residency.error.renewalAfterExpiry";
  return "staff.residency.error.invalid";
}

function fieldOf(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * 保存に成功したときの行き先（人間の指示 2026-08-22）。
 *
 * **成功したらレイヤーを閉じる。** `?panel=` を外した URL へ 302 で返す。
 * 画面側で閉じるのではなく**サーバーが行き先を返す**ので、JS が動かなくても
 * 同じように閉じ、戻るボタンで開いたままの状態に戻らない
 * （POST → リダイレクト → GET。二重送信も防ぐ）。
 *
 * 絞り込み（`?status=`）は持ち回り、何をしたかは `?saved=` で伝える
 * （`useActionData` はリダイレクトすると残らない）。
 *
 * **失敗のときは使わない。** 直す場所が見えている必要があるので、
 * レイヤーは開いたまま、理由をその中に出す。
 */
function savedRedirect(request: Request, saved: string): Response {
  const url = new URL(request.url);
  const params = new URLSearchParams();
  const status = url.searchParams.get("status");
  if (status !== null && status !== "") params.set("status", status);
  params.set("saved", saved);
  return redirect(`${STAFF_PATH}?${params.toString()}`);
}

export async function action({
  request,
  context,
}: ActionFunctionArgs): Promise<StaffActionResult | Response> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  const form = await request.formData();

  // 1 画面に 4 つのフォームがある（登録・在留資格・編集・利用の停止/再開）。
  // **`intent` で分ける。** 項目の有無で推測すると、片方の必須項目が
  // 空のときにもう片方として処理されうる。
  if (fieldOf(form, "intent") === "residency") {
    // **PIN と同じファイルに監査ログの口を置かない**
    // （`tests/security/initialPin.spec.ts`）。この画面は初期 PIN を
    // `action` の戻り値として運ぶので、`recordAudit()` を呼ぶ経路が
    // 同居していると、取り違えたときに PIN が監査ログへ入りうる。
    const outcome = await saveResidency(env, tenant, session.membershipId, form);
    return "residencySaved" in outcome ? savedRedirect(request, "RESIDENCY") : outcome;
  }

  // 編集と利用の停止/再開も同じ理由で `lib/staff/edit.ts` にある。
  if (fieldOf(form, "intent") === "staffUpdate") {
    const outcome = await updateStaff(env, tenant, session.membershipId, form);
    return "staffSaved" in outcome ? savedRedirect(request, outcome.staffSaved) : outcome;
  }
  if (fieldOf(form, "intent") === "staffActive") {
    const outcome = await setStaffActive(env, tenant, session.membershipId, {
      membershipId: fieldOf(form, "membershipId"),
      // **既定を「停める」にしない。** 値が落ちたときに人が締め出される
      // 側へ倒れる形にしないため、`"true"` のときだけ再開する。
      isActive: fieldOf(form, "isActive") === "true",
    });
    return "staffSaved" in outcome ? savedRedirect(request, outcome.staffSaved) : outcome;
  }

  const email = fieldOf(form, "email").trim();
  const locale = fieldOf(form, "locale");

  const parsed = fieldStaffCreateSchema.safeParse({
    displayName: fieldOf(form, "displayName"),
    staffNumber: fieldOf(form, "staffNumber"),
    role: fieldOf(form, "role"),
    propertyIds: form.getAll("propertyIds").filter((value) => typeof value === "string"),
    ...(email === "" ? {} : { email }),
    ...(locale === "" ? {} : { locale }),
  });
  if (!parsed.success) return { invalid: true };

  const outcome = await registerFieldStaff(env, tenant, parsed.data, session.membershipId);
  if (!outcome.created) return { duplicate: true };

  return {
    card: {
      displayName: outcome.staff.displayName,
      staffNumber: outcome.staff.staffNumber,
      orgShortId: tenant.orgShortId,
      initialPin: outcome.staff.initialPin,
      // **要求元のオリジンから組み立てる。** 環境ごとに違う host を
      // 設定値として二重に持たない。
      loginUrl: new URL("/m/login", request.url).toString(),
    },
  };
}

/**
 * 案内カード 1 枚。**印刷したときに A4 へ収まる**（`app.css` の `@media print`）。
 *
 * 印字するのは §2.4 の 3 項目。**「施設コード」ではなく「組織 ID」**を出す
 * （DECISIONS #186）。ログインの 3 フィールドは組織 ID・スタッフ番号・PIN で、
 * 施設コードを打ち込む欄はどこにも無い。
 */
function LoginCardSheet({ card }: { card: LoginCard }) {
  // **ここで QR を作る。** 純粋関数で、載せるのはログイン URL 1 本だけ。
  const code = encodeQr(card.loginUrl);

  return (
    <article className="pk-card">
      <h2 className="pk-card__title">{t("staff.card.title")}</h2>

      <svg
        className="pk-card__qr"
        viewBox={`0 0 ${String(code.size)} ${String(code.size)}`}
        role="img"
        aria-label={t("staff.card.qrAlt")}
      >
        {/* 余白（クワイエットゾーン）は viewBox ではなく CSS の padding で取る。 */}
        <rect width={code.size} height={code.size} fill="#fff" />
        <path d={qrPath(code)} fill="#000" />
      </svg>

      <p className="pk-card__or">{t("staff.card.or")}</p>
      <p className="pk-card__url">{card.loginUrl}</p>

      <dl className="pk-card__fields">
        <dt>{t("staff.card.orgShortId")}</dt>
        <dd className="pk-card__value">{card.orgShortId}</dd>
        <dt>{t("staff.card.staffNumber")}</dt>
        <dd className="pk-card__value">{card.staffNumber}</dd>
        <dt>{t("staff.card.pin")}</dt>
        <dd className="pk-card__value">{card.initialPin}</dd>
      </dl>

      <p className="pk-card__notice">{t("staff.card.notice")}</p>
      <p className="pk-card__name">{card.displayName}</p>
    </article>
  );
}

/**
 * 在留期限のセル（プロトタイプ ops 07）。
 *
 * **90 日以内はオレンジ。赤にしない。** 急かす色を人の在籍に当てない
 * （ui-writing.md §3 が経過時間で赤を禁じているのと同じ理由）。
 * 期限切れだけは `--danger`（法令の問題であって、催促ではない）。
 */
function ExpiryCell({ row }: { row: StaffLedgerView }) {
  if (row.expiresOn === null) return <td className="pk-muted">—</td>;

  const days = row.daysUntilExpiry;
  const modifier =
    days === null ? "" : days < 0 ? " pk-expiry--over" : days <= 90 ? " pk-expiry--near" : "";
  return <td className={`pk-expiry${modifier}`}>{row.expiresOn}</td>;
}

/** 在籍年数の表示。**未入力を「0 年目」にしない**（`buildStaffLedger()` の注記）。 */
function experienceOf(row: StaffLedgerView): string {
  if (row.months === null) return "—";
  return row.years !== null && row.years > 0
    ? `${String(row.years)}${t("staff.roster.years")}`
    : `${String(row.months)}${t("staff.roster.months")}`;
}

/**
 * スタッフ一覧と言語の構成（P8-01 / プロトタイプ ops 07）。
 *
 * ── 個人の実績を出さない ────────────────────────────────
 * security.md §5 / CLAUDE.md §4。**完了件数・平均時間・順位の列を
 * 足さないこと。** 出すのは在籍の事実だけ。
 */
function StaffRoster({
  ledger,
  canReadResidency,
  filter,
}: {
  ledger: StaffLedgerPage;
  canReadResidency: boolean;
  filter: StaffFilter;
}) {
  const expiring = expiringStaff(ledger.rows);
  const visible = filterStaffRows(ledger.rows, filter);

  return (
    <>
      {/* KPI 4 枚（プロトタイプ ops 07）。**絞り込みでは動かない** —
          母数が読めなくなるため（`filterStaffRows()` の注記）。 */}
      <dl className="pk-stats pk-stats--4">
        <div className="pk-stats__item">
          <dt>
            <span className="pk-stats__icon" aria-hidden="true">
              👥
            </span>
            {t("staff.kpi.registered")}
          </dt>
          <dd>
            {String(ledger.summary.registered)}
            <span className="pk-stats__unit">{t("staff.unit.people")}</span>
          </dd>
        </div>
        <div className="pk-stats__item pk-stats__item--accent-ok">
          <dt>
            <span className="pk-stats__icon" aria-hidden="true">
              ✓
            </span>
            {t("staff.kpi.active")}
          </dt>
          <dd>
            {String(ledger.summary.active)}
            <span className="pk-stats__unit">{t("staff.unit.people")}</span>
          </dd>
        </div>
        <div className="pk-stats__item pk-stats__item--accent-info">
          <dt>
            <span className="pk-stats__icon" aria-hidden="true">
              🎓
            </span>
            {t("staff.kpi.training")}
          </dt>
          <dd>
            {String(ledger.summary.training)}
            <span className="pk-stats__unit">{t("staff.unit.people")}</span>
          </dd>
        </div>
        {/* **件数だけは誰にでも出す**（INV-08 / 仕様 §1.4 の「件数のみ」）。 */}
        <div className="pk-stats__item pk-stats__item--accent-warn">
          <dt>
            <span className="pk-stats__icon" aria-hidden="true">
              📅
            </span>
            {t("staff.kpi.expiring")}
          </dt>
          <dd>
            {String(ledger.summary.expiringWithin90Days)}
            <span className="pk-stats__unit">{t("staff.unit.people")}</span>
          </dd>
          <p className="pk-report__delta">{t("staff.kpi.expiringNote")}</p>
        </div>
      </dl>

      {/* 期限が近い方の案内（プロトタイプ ops 07 の警告バナー）。
          **名前と日付は `residency.read` を持つ相手にだけ出る** —
          読めない相手には `expiresOn` が `null` で入るので空になる。 */}
      {expiring.length === 0 ? null : (
        <div className="pk-alert pk-alert--warn">
          <p className="pk-alert__title">{t("staff.expiring.title")}</p>
          <p>
            {expiring
              .map((row) => `${row.displayName}（${row.expiresOn ?? ""}）`)
              .join(" · ")}
          </p>
          <p className="pk-muted">{t("staff.expiring.note")}</p>
        </div>
      )}

      {/* 絞り込み（プロトタイプ ops 07）。**GET。** 押した状態が URL に残る。 */}
      <form method="get" className="pk-filter">
        <label htmlFor="status">{t("staff.filter.label")}</label>
        <select id="status" name="status" defaultValue={filter}>
          {STAFF_FILTERS.map((value) => (
            <option key={value} value={value}>
              {t(`staff.filter.${value}` as Parameters<typeof t>[0])}
            </option>
          ))}
        </select>
        <button type="submit">{t("staff.filter.apply")}</button>
      </form>

      {/* プロトタイプ ops 07「👥 スタッフ一覧」。 */}
      <section className="pk-panel">
        <div className="pk-panel__head">
          <span className="pk-panel__icon" aria-hidden="true">
            👥
          </span>
          {t("staff.roster.card")}
        </div>
        {visible.length === 0 ? (
          <div className="pk-panel__body">
            <p className="pk-muted">{t("staff.roster.empty")}</p>
          </div>
        ) : (
          <div className="pk-panel__body pk-panel__body--flush pk-scroll-x">
            <table className="pk-tbl">
              <thead>
                <tr>
                  <th>{t("staff.roster.name")}</th>
                  <th>{t("staff.roster.staffNumber")}</th>
                  <th>{t("staff.roster.languages")}</th>
                  <th>{t("staff.roster.experience")}</th>
                  <th>{t("staff.roster.properties")}</th>
                  {canReadResidency ? <th>{t("staff.roster.expiresOn")}</th> : null}
                  <th>{t("staff.roster.status")}</th>
                  {/* 「詳細」の列。**見出しは空にしない** — 読み上げで
                      列の意味が消える（表の他の列と同じ扱いにする）。 */}
                  <th>{t("staff.roster.detailColumn")}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={row.membershipId}>
                    <th scope="row">{row.displayName}</th>
                    <td>{row.staffNumber ?? "—"}</td>
                    <td>{row.languages.map((code) => t(languageKey(code))).join(" · ")}</td>
                    <td>{experienceOf(row)}</td>
                    {/* **割当が無ければ空欄。**「全施設」と読み替えない。 */}
                    <td>{row.properties.length === 0 ? "—" : row.properties.join(" · ")}</td>
                    {canReadResidency ? <ExpiryCell row={row} /> : null}
                    <td>{t(`staff.status.${row.workStatus}` as Parameters<typeof t>[0])}</td>
                    <td>
                      {/* プロトタイプ ops 07 の「詳細」ボタン。押すと右から
                          レイヤーが出る（人間の指示 2026-08-22）。
                          **`<Link>` にしてある** — 素の `<a>` だと画面ごと
                          読み直しになり、レイヤーが出てくる動きが消える。 */}
                      <Link className="pk-button" to={panelHref(filter, row.membershipId)}>
                        {t("staff.roster.detail")}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {/* 在留資格の免責（PK-SPEC-P8 §1.4 MUST / **編集不可**）。
            列を出しているときだけ出す。**この文言を短くしないこと。** */}
        {canReadResidency ? (
          <div className="pk-panel__foot">{t("staff.residency.disclaimer")}</div>
        ) : null}
      </section>

      {/* ── 2 枚並び（プロトタイプ ops 07 の下段）──────────────────
          「🌐 言語の構成」と「📅 在留資格の管理」が左右に並ぶ。
          在留資格を読めない相手には左だけが残る（`.pk-cols` は
          子が 1 枚でも崩れない）。 */}
      <div className={canReadResidency ? "pk-cols pk-cols--2" : "pk-cols"}>
        {ledger.languages.length === 0 ? null : (
          <section className="pk-panel">
            <div className="pk-panel__head">
              <span className="pk-panel__icon" aria-hidden="true">
                🌐
              </span>
              {t("staff.languages.title")}
              {/* プロトタイプの「登録31名」。**母数を見出しに出す** —
                  下の合計と一致しないことの説明が付く。 */}
              <span className="pk-panel__note">
                {`${t("staff.kpi.registered")}${String(ledger.summary.registered)}${t(
                  "staff.unit.people",
                )}`}
              </span>
            </div>
            <div className="pk-panel__body pk-panel__body--flush pk-scroll-x">
              <table className="pk-tbl">
                <tbody>
                  {ledger.languages.map((row) => (
                    <tr key={row.language}>
                      <th scope="row">{t(languageKey(row.language))}</th>
                      <td className="pk-num">
                        {`${String(row.count)}${t("staff.languages.unit")}`}
                      </td>
                      {/* 棒（プロトタイプの `.bar`）。**数値を必ず併記する。**
                          棒だけだと読み上げでも色覚でも値が取れない。 */}
                      <td>
                        <span className="pk-meterbar pk-meterbar--wide">
                          <span className="pk-meterbar__track">
                            <i
                              className="pk-meterbar__fill pk-meterbar__fill--chart"
                              style={{ width: `${String(row.ratio)}%` }}
                            />
                          </span>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* **1 人が複数の言語を持つので合計は人数と一致しない**（逐語）。 */}
            <div className="pk-panel__foot">{t("staff.languages.note")}</div>
          </section>
        )}

        {/* 在留資格の管理（プロトタイプ ops 07「📅 在留資格の管理」）。 */}
        {canReadResidency ? (
          <section className="pk-panel">
            <div className="pk-panel__head">
              <span className="pk-panel__icon" aria-hidden="true">
                📅
              </span>
              {t("staff.residency.manage.title")}
            </div>
            <div className="pk-panel__body">
              {/* **3 つとも設定を持たない**（OPEN_QUESTIONS #124 の決着）。
                  通知の 2 つは常時有効、期限当日の割当停止は必須。
                  スイッチに見せない（`ResidencyRule` の注記）。 */}
              <ul className="pk-rulelist">
                <ResidencyRule
                  title={t("staff.residency.manage.notice90")}
                  note={t("staff.residency.manage.notice90Note")}
                  state={t("staff.residency.manage.stateAlways")}
                />
                <ResidencyRule
                  title={t("staff.residency.manage.notice30")}
                  note={t("staff.residency.manage.notice30Note")}
                  state={t("staff.residency.manage.stateAlways")}
                />
                <ResidencyRule
                  title={t("staff.residency.manage.block")}
                  note={t("staff.residency.manage.blockNote")}
                  state={t("staff.residency.manage.stateRequired")}
                />
              </ul>

              {/* §1.4 MUST。**この境界を消さないこと。**
                  **赤にしない。** 赤は実際に期限が切れている行
                  （`ExpiryCell` の `--over`）にだけ使う。ここは常時出ている
                  但し書きで、状態を表していない（オーナー判断 2026-08-22）。 */}
              <p className="pk-notice">
                <strong className="pk-notice__title">
                  {t("staff.residency.manage.illegal")}
                </strong>
                {t("staff.residency.manage.human")}
              </p>
            </div>
            {ledger.residencyBreakdown.length === 0 ? null : (
              <>
                <div className="pk-panel__foot">{t("staff.residency.breakdown.title")}</div>
                <div className="pk-panel__body pk-panel__body--flush">
                  <table className="pk-tbl">
                    <tbody>
                      {ledger.residencyBreakdown.map((row) => (
                        <tr key={row.statusType}>
                          <th scope="row">
                            {t(
                              `staff.residency.type.${row.statusType}` as Parameters<typeof t>[0],
                            )}
                          </th>
                          <td className="pk-num">
                            {`${String(row.count)}${t("staff.residency.breakdown.unit")}`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        ) : null}
      </div>
    </>
  );
}

/**
 * 自動で動く規則の 1 行（OPEN_QUESTIONS #124 の決着 / オーナー判断 2026-08-22）。
 *
 * ── スイッチをやめた ────────────────────────────────────
 * プロトタイプ ops 07 は切り替えスイッチだが、**3 つとも設定を持たない。**
 * 見た目だけスイッチにしていた頃は、押しても何も起きず、
 * 「切れるはずのものが壊れている」と読めた。**設定できると誤認させない**
 * ため、チェックの印＋規則名＋状態の一覧に置き換えた。
 *
 * ── 状態は文字で読ませる ────────────────────────────────
 * 印は `aria-hidden`（装飾）。**状態は普通の文字**なので、読み上げでも
 * 拡大表示でも同じことが伝わる。`role="img"` と `title` に説明を
 * 預けない（どちらも読み手を選ぶ）。
 */
function ResidencyRule({ title, note, state }: { title: string; note: string; state: string }) {
  return (
    <li className="pk-rulelist__item">
      <span className="pk-rulelist__icon" aria-hidden="true">
        ✓
      </span>
      <span className="pk-rulelist__text">
        <span className="pk-rulelist__title">{title}</span>
        <span className="pk-rulelist__note">{note}</span>
      </span>
      <span className="pk-rulelist__state">{state}</span>
    </li>
  );
}

/**
 * 在留資格の記録（P8-02 / 仕様 §1.4）。**レイヤーの中に置く**
 * （人間の指示 2026-08-22）。
 *
 * ── 対象を選ばせない ────────────────────────────────────
 * 以前は画面の下に置いた独立フォームで、**先頭に「対象のスタッフ」の
 * 選択があった。** 一覧の誰を見ていようと関係なく選び直す形で、
 * 取り違えが起こりうる。レイヤーは**開いている本人**のものなので、
 * `staffProfileId` は隠しで運び、選択そのものを無くす。
 *
 * ── 1 人ずつ、上書きで記録する ──────────────────────────
 * 表は 1 スタッフ 1 行（`uq_residency_staff`）。**履歴を行で持たない**ので、
 * このフォームは常に上書き。訂正の追跡は監査ログ（`residency.updated`）。
 *
 * ── 就労可否を聞かない ──────────────────────────────────
 * 仕様 §1.4 MUST。聞くのは**種別と日付**だけで、
 * 「働けるか」のチェックボックスを置かない。判断は事業者が行う。
 *
 * ── 期限切れの解除ボタンを置かない ──────────────────────
 * 同 MUST。**`expiresOn` を更新する以外に停止を解く経路を作らない。**
 */
function ResidencyPanelForm({ detail }: { detail: StaffDetail }) {
  const current = detail.residency;

  return (
    <Form method="post" className="pk-form">
      <input type="hidden" name="intent" value="residency" />
      <input type="hidden" name="staffProfileId" value={detail.staffProfileId ?? ""} />

      <label htmlFor="statusType">{t("staff.residency.statusType")}</label>
      <select
        id="statusType"
        name="statusType"
        defaultValue={current?.statusType ?? "SPECIFIED_SKILLED_1"}
      >
        {RESIDENCY_STATUS_TYPE_VALUES.map((value) => (
          <option key={value} value={value}>
            {t(`staff.residency.type.${value}` as Parameters<typeof t>[0])}
          </option>
        ))}
      </select>

      <label htmlFor="expiresOn">{t("staff.residency.expiresOn")}</label>
      <input id="expiresOn" name="expiresOn" type="date" defaultValue={current?.expiresOn ?? ""} />
      <p className="pk-form__note">{t("staff.residency.expiresOnNote")}</p>

      <label htmlFor="renewalAppliedOn">{t("staff.residency.renewalAppliedOn")}</label>
      <input
        id="renewalAppliedOn"
        name="renewalAppliedOn"
        type="date"
        defaultValue={current?.renewalAppliedOn ?? ""}
      />

      <label className="pk-form__check">
        <input
          type="checkbox"
          name="workPermitRequired"
          defaultChecked={current?.workPermitRequired ?? false}
        />
        {t("staff.residency.workPermitRequired")}
      </label>

      <label htmlFor="weeklyHourLimit">{t("staff.residency.weeklyHourLimit")}</label>
      <input
        id="weeklyHourLimit"
        name="weeklyHourLimit"
        type="number"
        min={0}
        max={168}
        defaultValue={current?.weeklyHourLimit ?? ""}
      />

      <SubmitButton label={t("staff.residency.submit")} />
    </Form>
  );
}

/** この画面の場所。**レイヤーの開閉は同じ画面の中で行う。** */
const STAFF_PATH = "/app/settings/staff";

/**
 * レイヤーの開閉を表す URL。
 *
 * **絞り込みを持ち回る。** 「稼働中」で絞った状態から詳細を開いて閉じたら、
 * 絞り込みが外れて一覧が変わる、という動きにしない。
 *
 * @param panel `null` で閉じる。`"new"` で登録、それ以外は `membershipId`。
 */
function panelHref(filter: StaffFilter, panel: string | null): string {
  const params = new URLSearchParams();
  if (filter !== "ALL") params.set("status", filter);
  if (panel !== null) params.set("panel", panel);
  const query = params.toString();
  return query === "" ? STAFF_PATH : `${STAFF_PATH}?${query}`;
}

/** 言語コード → 辞書のキー。**知らないコードは素のまま出さない。** */
function languageKey(code: string): Parameters<typeof t>[0] {
  const known = ["ja", "en", "zh-CN", "vi", "id", "my", "ne"];
  return (known.includes(code) ? `staff.language.${code}` : "staff.language.other") as Parameters<
    typeof t
  >[0];
}

/**
 * 直前の保存が失敗した理由 → 文言のキー。**成功はここに来ない**
 * （成功はリダイレクトになるので `useActionData` に残らない）。
 */
function drawerErrorKey(
  result: StaffActionResult | undefined,
): Parameters<typeof t>[0] | null {
  if (result === undefined) return null;
  if ("duplicate" in result) return "staff.error.duplicate";
  if ("invalid" in result || "staffInvalid" in result) return "staff.error.invalid";
  if ("residencyInvalid" in result) return residencyErrorKey(result.residencyInvalid);
  if ("staffNotFound" in result) return "staff.panel.error.notFound";
  if ("staffNotField" in result) return "staff.panel.adminOnly";
  if ("staffSelf" in result) return "staff.panel.error.self";
  return null;
}

/**
 * 右からスライドインするレイヤー（人間の指示 2026-08-22）。
 *
 * ── 素の HTML で開いて閉じる ────────────────────────────
 * 中身はサーバーが描き、閉じるのはリンク 1 本。**JS が動かなくても
 * 開閉する。** 動き（スライドイン）は CSS の `@keyframes` で、
 * `prefers-reduced-motion` を立てている人には出さない（`app.css`）。
 *
 * ── 背景の暗幕もリンク ──────────────────────────────────
 * 幕の外を押すと閉じる、という当たり前の動きを `onClick` ではなく
 * `<Link>` で作る。**キーボードでも到達できる**（`onClick` を載せた
 * `<div>` には Tab で行けない）。
 */
function StaffDrawer({
  title,
  closeHref,
  error,
  children,
}: {
  title: string;
  closeHref: string;
  /** 直前の保存が失敗した理由。**レイヤーの中に出す**（下の注記）。 */
  error: Parameters<typeof t>[0] | null;
  children: React.ReactNode;
}) {
  // ── 送信中・読み込み中は待っていることを見せる（人間の指示 2026-08-22）──
  // 開くのも保存もサーバーへの往復なので、押してから戻るまでに間がある。
  // **その間ポインタを「処理中」にし、送信ボタンを押せなくする。**
  // JS が動かないときは何も起きない（見た目の措置で、二重送信の防止は
  // サーバー側の `Idempotency-Key` と POST → リダイレクトが受け持つ）。
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <div className={busy ? "pk-drawer pk-drawer--busy" : "pk-drawer"} aria-busy={busy}>
      <Link className="pk-drawer__scrim" to={closeHref} aria-label={t("staff.panel.close")} />
      <aside className="pk-drawer__panel" aria-label={title}>
        {/* ── 閉じるは**左端**。右上に置かない（人間の指示 2026-08-22）──
            レイヤーは右端に出るので、右上の × は**トップバーのログアウト
            ボタンの真下**に来る。閉じると × ごと消えるため、勢いで
            2 回押すと 2 回目がログアウトに当たる。**破壊的でない操作の
            すぐ後ろに、取り返しのつかない操作を置かない。** */}
        <div className="pk-drawer__head">
          {/* **文字ではなく図形で描く。** `×` は文字なので、字面の位置が
              フォントごとに違い、見出しとの上下が環境によってずれる
              （手元の Linux では 0.75px、Hiragino では目に見える差になる）。
              SVG なら viewBox の中で幾何学的に中央に決まる。 */}
          <Link className="pk-drawer__close" to={closeHref} aria-label={t("staff.panel.close")}>
            <svg
              className="pk-drawer__closeIcon"
              viewBox="0 0 12 12"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M1.5 1.5 L10.5 10.5 M10.5 1.5 L1.5 10.5" />
            </svg>
          </Link>
          <h2 className="pk-drawer__title">{title}</h2>
        </div>
        <div className="pk-drawer__body">
          {/* **失敗の理由はレイヤーの中に出す。** 画面の側に出すと、
              直すべき欄が目の前にあるのに、その説明が幕の下に隠れる。 */}
          {error === null ? null : <p className="pk-notice pk-notice--warn">{t(error)}</p>}
          {children}
        </div>
      </aside>
    </div>
  );
}

/**
 * レイヤーの中の送信ボタン。
 *
 * **送信中は押せなくする。** 往復の間にもう一度押せると、同じ保存が
 * 2 度飛ぶ（二重送信そのものはサーバー側の POST → リダイレクトで
 * 実害が出ないが、押した側には何が起きたか分からない）。
 * ポインタの形は `.pk-drawer--busy` が受け持つ。
 */
function SubmitButton({ label, className }: { label: string; className?: string }) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <button type="submit" disabled={busy} {...(className === undefined ? {} : { className })}>
      {label}
    </button>
  );
}

/**
 * モバイルの表示言語（登録と編集で同じ形）。
 *
 * ── 7 つ出す ────────────────────────────────────────────
 * 以前は `日本語 / English` の 2 つだけだった。カタログ側は 7 言語ぶん
 * 揃っていて（契約 §7.1）、モバイルは初回起動で自国語を選べる設計なのに、
 * **選ばせる側だけが 2 つのまま**だった（人間の指摘 2026-08-22）。
 * 一覧は `STAFF_LOCALES`（`packages/contracts`）が唯一の正で、
 * ここで並べ直さない。**表示名はその言語自身の表記**にする
 * （`staff.language.*`）— 読めない言語で書かれていると選べない。
 */
function LocaleOptions({ id, current }: { id: string; current: string }) {
  // 知らない値（過去に別の値で作られた行）は既定へ倒す。
  const selected = (STAFF_LOCALES as readonly string[]).includes(current) ? current : "ja";

  return (
    <select id={id} name="locale" defaultValue={selected}>
      {STAFF_LOCALES.map((locale) => (
        <option key={locale} value={locale}>
          {t(languageKey(locale))}
        </option>
      ))}
    </select>
  );
}

/** 担当する施設のチェックボックス（登録と編集で同じ形）。 */
function PropertyChecks({
  properties,
  selected,
}: {
  properties: readonly StaffProperty[];
  selected: readonly string[];
}) {
  return (
    <fieldset className="pk-form__group">
      <legend>{t("staff.form.properties")}</legend>
      {properties.map((property) => (
        <label key={property.id} className="pk-form__check">
          <input
            type="checkbox"
            name="propertyIds"
            value={property.id}
            defaultChecked={selected.includes(property.id)}
          />
          {`${property.code} ${property.name}`}
        </label>
      ))}
      <p className="pk-form__note">{t("staff.form.propertiesNote")}</p>
    </fieldset>
  );
}

/**
 * 登録のフォーム（レイヤーの中）。
 *
 * **画面の最下部ではなくレイヤーに置く**（人間の指示 2026-08-22）。
 * 一覧の下に長いフォームが常時開いていると、一覧を読みに来た人が
 * 毎回それを跨ぐことになる。
 */
function StaffCreateForm({ properties }: { properties: readonly StaffProperty[] }) {
  return (
    <Form method="post" className="pk-form">
      <label htmlFor="displayName">{t("staff.form.displayName")}</label>
      <input id="displayName" name="displayName" maxLength={64} required />

      <label htmlFor="staffNumber">{t("staff.form.staffNumber")}</label>
      <input id="staffNumber" name="staffNumber" required />

      <label htmlFor="role">{t("staff.form.role")}</label>
      <select id="role" name="role" defaultValue="CLEANER">
        {FIELD_STAFF_ROLES.map((role) => (
          <option key={role} value={role}>
            {t(`role.${role}` as Parameters<typeof t>[0])}
          </option>
        ))}
      </select>

      <PropertyChecks properties={properties} selected={[]} />

      <label htmlFor="locale">{t("staff.form.locale")}</label>
      <LocaleOptions id="locale" current="ja" />
      <p className="pk-form__note">{t("staff.form.localeNote")}</p>

      <label htmlFor="email">{t("staff.form.email")}</label>
      <input id="email" name="email" type="email" maxLength={254} />
      <p className="pk-form__note">{t("staff.form.emailNote")}</p>

      <SubmitButton label={t("staff.form.submit")} />
    </Form>
  );
}

/**
 * 詳細と編集（レイヤーの中）。
 *
 * ── 触れるのは現場スタッフだけ ──────────────────────────
 * `isFieldStaff` が偽なら、読める値を出して終わりにする。管理系ユーザーの
 * ロール変更・無効化は W-12（権限と監査）が持っており、**同じ操作の入口を
 * 2 つ作らない**（`lib/staff/edit.ts` の注記 / DECISIONS #181）。
 *
 * ── スタッフ番号と PIN の欄が無いのは意図 ───────────────
 * 番号はログインの 3 フィールドの 1 つで、現場に配った案内カードにも
 * 刷ってある（`contracts/user.ts` の注記）。PIN の再発行も W-12。
 *
 * ── 「削除」ではなく「利用を停止する」──────────────────
 * 行は消えない（PK-SPEC-P0 §26）。過去のタスクと証跡がこの人を
 * 参照しているため、消すと記録の側が誰の作業か分からなくなる。
 * 停止するとログインが止まり、シフトと研修の割当候補からも外れる。
 * **戻せる**（`lib/staff/edit.ts`）。
 */
function StaffDetailForm({
  detail,
  properties,
  canWriteResidency,
}: {
  detail: StaffDetail;
  properties: readonly StaffProperty[];
  /** **`residency.write` を持つときだけ在留資格の欄を出す**（`OWNER` は読めても書けない）。 */
  canWriteResidency: boolean;
}) {
  return (
    <>
      <dl className="pk-drawer__facts">
        <dt>{t("staff.roster.staffNumber")}</dt>
        <dd>{detail.staffNumber ?? "—"}</dd>
        <dt>{t("staff.panel.account")}</dt>
        <dd>
          <span
            className={
              detail.isActive
                ? "pk-tag pk-tag--ok"
                : "pk-tag pk-tag--muted"
            }
          >
            {t(detail.isActive ? "staff.panel.active" : "staff.panel.inactive")}
          </span>
        </dd>
      </dl>

      {detail.isFieldStaff ? null : (
        <p className="pk-notice">{t("staff.panel.adminOnly")}</p>
      )}

      {detail.isFieldStaff ? (
        <>
          <h3 className="pk-drawer__section">{t("staff.panel.section.profile")}</h3>
          <Form method="post" className="pk-form">
            <input type="hidden" name="intent" value="staffUpdate" />
            <input type="hidden" name="membershipId" value={detail.membershipId} />

            <label htmlFor="editDisplayName">{t("staff.form.displayName")}</label>
            <input
              id="editDisplayName"
              name="displayName"
              maxLength={64}
              required
              defaultValue={detail.displayName}
            />

            <label htmlFor="editRole">{t("staff.form.role")}</label>
            <select id="editRole" name="role" defaultValue={detail.role}>
              {FIELD_STAFF_ROLES.map((role) => (
                <option key={role} value={role}>
                  {t(`role.${role}` as Parameters<typeof t>[0])}
                </option>
              ))}
            </select>

            <PropertyChecks properties={properties} selected={detail.propertyIds} />

            <label htmlFor="editLocale">{t("staff.form.locale")}</label>
            <LocaleOptions id="editLocale" current={detail.locale} />
            <p className="pk-form__note">{t("staff.form.localeNote")}</p>

            <label htmlFor="editEmail">{t("staff.form.email")}</label>
            <input
              id="editEmail"
              name="email"
              type="email"
              maxLength={254}
              defaultValue={detail.email ?? ""}
            />
            <p className="pk-form__note">{t("staff.form.emailNote")}</p>

            <SubmitButton label={t("staff.panel.save")} />
          </Form>

          {/* 利用の停止と再開。**編集と同じフォームに混ぜない** —
              「保存」を押したつもりで人を止めることになる。 */}
          <h3 className="pk-drawer__section pk-drawer__section--danger">
            {t("staff.panel.section.account")}
          </h3>
          <Form method="post" className="pk-form pk-drawer__danger">
            <input type="hidden" name="intent" value="staffActive" />
            <input type="hidden" name="membershipId" value={detail.membershipId} />
            <input type="hidden" name="isActive" value={detail.isActive ? "false" : "true"} />
            <p className="pk-form__note">
              {t(detail.isActive ? "staff.panel.stopNote" : "staff.panel.resumeNote")}
            </p>
            <SubmitButton
              label={t(detail.isActive ? "staff.panel.stop" : "staff.panel.resume")}
            />
          </Form>
        </>
      ) : null}

      {/* ── 在留資格（P8-02 / 人間の指示 2026-08-22）───────────────
          **画面の下の独立フォームからここへ移した。** 以前は「対象の
          スタッフ」を選び直す形で、一覧の誰を見ていようと関係なく
          選べたため取り違えが起こりうる。レイヤーは開いている本人の
          ものなので、対象を選ばせる必要が無い。
          **現場スタッフに限らない** — 台帳に行がある人は誰でも記録の
          対象になる（編集・停止だけが現場スタッフ限定）。 */}
      {canWriteResidency ? (
        <>
          <h3 className="pk-drawer__section">{t("staff.panel.section.residency")}</h3>
          {detail.staffProfileId === null ? (
            <p className="pk-notice">{t("staff.residency.noProfile")}</p>
          ) : (
            <>
              <ResidencyPanelForm detail={detail} />
              {/* §1.4 MUST。**この文言を短くしないこと。** */}
              <p className="pk-drawer__disclaimer">{t("staff.residency.disclaimer")}</p>
            </>
          )}
        </>
      ) : null}
    </>
  );
}

/** レイヤーの見出し。 */
function panelTitle(panel: StaffPanel): string {
  return panel.mode === "NEW" ? t("staff.panel.newTitle") : panel.detail.displayName;
}

export default function Staff() {
  const data = useLoaderData<StaffData>();
  const result = useActionData<StaffActionResult>();
  const card = result !== undefined && "card" in result ? result.card : null;

  if (data.properties.length === 0) {
    return (
      <section className="pk-page">
        <div className="pk-pagehead">
          <h1 className="pk-pagehead__title">{t("staff.title")}</h1>
        </div>
        <p className="pk-notice">{t("staff.noProperty")}</p>
      </section>
    );
  }

  // **登録できたらレイヤーを閉じる。** 案内カードは画面の側に出す —
  // 印刷するものが幕の下にあると、そのまま印刷して白紙になる。
  const panel = card === null ? data.panel : null;

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("staff.title")}</h1>
        <div className="pk-pagehead__actions">
          <Link
            className="pk-button pk-button--primary"
            to={panelHref(data.filter, "new")}
          >
            {t("staff.panel.new")}
          </Link>
        </div>
      </div>
      <p className="pk-page__lede">{t("staff.lede")}</p>

      {/* **成功の知らせは画面の側に出す。** レイヤーはもう閉じている
          （`savedRedirect()`）。理由は `?saved=` で運ばれてくる。 */}
      {data.saved === null ? null : (
        <p className="pk-notice">
          {t(`staff.panel.saved.${data.saved}` as Parameters<typeof t>[0])}
        </p>
      )}

      <StaffRoster
        ledger={data.ledger}
        canReadResidency={data.canReadResidency}
        filter={data.filter}
      />

      {card === null ? null : (
        <div className="pk-print">
          {/* **PIN が二度と出ないことを先に伝える。** 閉じてから
              気づいても取り戻せない（PIN リセットのやり直しになる）。 */}
          <p className="pk-notice pk-print__hide">{t("staff.card.pinOnce")}</p>
          <LoginCardSheet card={card} />
          <p className="pk-print__hide">{t("staff.card.printHint")}</p>
        </div>
      )}

      {panel === null ? null : (
        <StaffDrawer
          title={panelTitle(panel)}
          closeHref={panelHref(data.filter, null)}
          error={drawerErrorKey(result)}
        >
          {panel.mode === "NEW" ? (
            <StaffCreateForm properties={data.properties} />
          ) : (
            <StaffDetailForm
              detail={panel.detail}
              properties={data.properties}
              canWriteResidency={data.canWriteResidency}
            />
          )}
        </StaffDrawer>
      )}
    </section>
  );
}
