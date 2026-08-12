import type { Role } from "@pk/db";
import { Form } from "react-router";

import { t, type MessageKey } from "../lib/i18n.js";

/**
 * ユーザー領域（PK-SPEC-UI-A01 §3.3）。
 *
 * task: docs/tasks/P0-14.md
 *
 * **役割と閲覧範囲のバッジは v3 標準の必須項目**（A01 §3.3 / 受け入れ基準 14）。
 * 複数の役割を兼ねる担当者が「いまどの権限で何を見ているか」を取り違えないため、
 * 常に見える位置に出す。
 *
 * ── メニュー項目を先に置かない ──────────────────────────
 * A01 §3.3 はアカウント設定・通知の設定・言語・ヘルプ・ログアウトの 5 つを
 * 固定と定めるが、**実体があるのはログアウトだけ**（言語は P0-15、
 * 通知は P2 以降、アカウント設定は P0 に task が無い）。
 * 押しても何も起きない項目を先に置かない。
 */

const ROLE_LABEL: Record<Role, MessageKey> = {
  OWNER: "role.OWNER",
  ORG_ADMIN: "role.ORG_ADMIN",
  PROPERTY_MANAGER: "role.PROPERTY_MANAGER",
  INSPECTOR: "role.INSPECTOR",
  CLEANER: "role.CLEANER",
  VENDOR_ADMIN: "role.VENDOR_ADMIN",
  AUDITOR: "role.AUDITOR",
};

export function UserMenu(props: { displayName: string; role: Role; isOrgWide: boolean }) {
  const scope = props.isOrgWide ? t("role.scope.org") : t("role.scope.assigned");

  return (
    <div className="pk-user">
      <div className="pk-user__identity">
        <span className="pk-user__name">{props.displayName}</span>
        <span className="pk-user__badge">
          {t(ROLE_LABEL[props.role])}
          {" · "}
          {scope}
        </span>
      </div>
      <Form method="post" action="/logout">
        <button className="pk-button pk-button--onBrand" type="submit">
          {t("user.logout")}
        </button>
      </Form>
    </div>
  );
}
