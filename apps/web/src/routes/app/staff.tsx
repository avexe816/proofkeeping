import { fieldStaffCreateSchema, FIELD_STAFF_ROLES } from "@pk/contracts";
import { Form, useActionData, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";

import { assertPermission, propertyTarget } from "../../lib/auth/permission.js";
import { t } from "../../lib/i18n.js";
import { listSelectableProperties } from "../../lib/property/selection.js";
import { encodeQr, qrPath } from "../../lib/qr/encode.js";
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

interface StaffData {
  properties: StaffProperty[];
}

type StaffActionResult =
  | { card: LoginCard }
  | { invalid: true }
  | { duplicate: true };

export async function loader({ request, context }: LoaderFunctionArgs): Promise<StaffData> {
  const env = getEnv(context);
  const { tenant } = await requireAppContext(env, request, new Date());
  // **一覧を出す前に権限を見る。** `CLEANER` / `INSPECTOR` / `AUDITOR` は
  // ここで 404（403 はリソースの存在を示唆する / architecture.md §2）。
  assertPermission(tenant, "user.write", propertyTarget(tenant.allowedPropertyIds));

  const properties = await listSelectableProperties(env, tenant);
  return {
    properties: properties.map((property) => ({
      id: property.id,
      code: property.code,
      name: property.name,
    })),
  };
}

function fieldOf(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export async function action({ request, context }: ActionFunctionArgs): Promise<StaffActionResult> {
  const env = getEnv(context);
  const { session, tenant } = await requireAppContext(env, request, new Date());

  const form = await request.formData();
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

export default function Staff() {
  const data = useLoaderData<StaffData>();
  const result = useActionData<StaffActionResult>();
  const card = result !== undefined && "card" in result ? result.card : null;

  if (data.properties.length === 0) {
    return (
      <section className="pk-page">
        <h1 className="pk-page__title">{t("staff.title")}</h1>
        <p className="pk-notice">{t("staff.noProperty")}</p>
      </section>
    );
  }

  return (
    <section className="pk-page">
      <h1 className="pk-page__title">{t("staff.title")}</h1>
      <p className="pk-page__lede">{t("staff.lede")}</p>

      {card === null ? null : (
        <div className="pk-print">
          {/* **PIN が二度と出ないことを先に伝える。** 閉じてから
              気づいても取り戻せない（PIN リセットのやり直しになる）。 */}
          <p className="pk-notice pk-print__hide">{t("staff.card.pinOnce")}</p>
          <LoginCardSheet card={card} />
          <p className="pk-print__hide">{t("staff.card.printHint")}</p>
        </div>
      )}

      {result !== undefined && "invalid" in result ? (
        <p className="pk-notice">{t("staff.error.invalid")}</p>
      ) : null}
      {result !== undefined && "duplicate" in result ? (
        <p className="pk-notice">{t("staff.error.duplicate")}</p>
      ) : null}

      <Form method="post" className="pk-form pk-print__hide">
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

        <fieldset className="pk-form__group">
          <legend>{t("staff.form.properties")}</legend>
          {data.properties.map((property) => (
            <label key={property.id} className="pk-form__check">
              <input type="checkbox" name="propertyIds" value={property.id} />
              {`${property.code} ${property.name}`}
            </label>
          ))}
          <p className="pk-form__note">{t("staff.form.propertiesNote")}</p>
        </fieldset>

        <label htmlFor="locale">{t("staff.form.locale")}</label>
        <select id="locale" name="locale" defaultValue="ja">
          <option value="ja">{t("staff.locale.ja")}</option>
          <option value="en">{t("staff.locale.en")}</option>
        </select>

        <label htmlFor="email">{t("staff.form.email")}</label>
        <input id="email" name="email" type="email" maxLength={254} />
        <p className="pk-form__note">{t("staff.form.emailNote")}</p>

        <button type="submit">{t("staff.form.submit")}</button>
      </Form>
    </section>
  );
}
