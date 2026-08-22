/**
 * スタッフ管理の画面が守る境界（P8-01 / P8-02）。
 *
 * task: docs/tasks/P8-01.md / docs/tasks/P8-02.md
 * 契約: docs/PK-IMPL-CONTRACT.md INV-08
 *
 * ── なぜソースを読むのか ────────────────────────────────
 * ここで確かめたいのは「**この経路が存在しないこと**」で、
 * 実行しても現れない。列を足した瞬間に落ちる形にするには、
 * 画面のソースを走査するのがいちばん確実
 * （`styles/darkMode.spec.ts` と同じ作り）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ja } from "../../locales/index.js";

const SOURCE = readFileSync(join(import.meta.dirname, "staff.tsx"), "utf8");

/**
 * 在留資格の書き込み。**画面から切り出してある**（`residency.ts` の注記）。
 * PIN を持つ `staff.tsx` に監査ログの口を置かないため。
 */
const WRITE_SOURCE = readFileSync(
  join(import.meta.dirname, "..", "..", "lib", "staff", "residency.ts"),
  "utf8",
);

/**
 * 詳細レイヤーの読み書き（W-07 / 人間の指示 2026-08-22）。
 * **同じ理由で切り出してある**（PIN と監査ログの口を同居させない）。
 */
const EDIT_SOURCE = readFileSync(
  join(import.meta.dirname, "..", "..", "lib", "staff", "edit.ts"),
  "utf8",
);

/**
 * コメントを落としたソース。
 *
 * **禁止事項を説明した doc コメント自体が検査に引っ掛かる**ので、
 * 「この語が無いこと」を見るときはこちらを使う
 * （`repositories.spec.ts` の `repositorySources()` と同じ理由）。
 */
const CODE = SOURCE.split("\n")
  .filter((line) => {
    const trimmed = line.trimStart();
    return (
      !trimmed.startsWith("*") &&
      !trimmed.startsWith("//") &&
      !trimmed.startsWith("/*") &&
      !trimmed.startsWith("{/*")
    );
  })
  .join("\n");

describe("スタッフ管理の画面", () => {
  it("在留期限を `residency.read` で絞っている（INV-08）", () => {
    // `canReadResidency` を通さずに列を出していないこと。
    expect(SOURCE).toContain("canReadResidency");
    expect(SOURCE).toContain('can(tenant, "residency.read"');
  });

  it("読めない相手には在留資格を**引かない**（loader の戻り値に残さない）", () => {
    // 引いてから画面で隠すと、loader の JSON が HTML に載ったままになる。
    expect(SOURCE).toContain("canReadResidency ? listResidencyRecords(env, tenant)");
  });

  it("件数の KPI は権限で分岐しない（仕様 §1.4 の「件数のみ」）", () => {
    // `countExpiringResidencies()` が三項演算子の中に入っていないこと。
    expect(SOURCE).toMatch(/^\s*countExpiringResidencies\(env, tenant, expiryHorizon\),$/m);
  });

  it("免責の文言が画面にある（PK-SPEC-P8 §1.4 MUST）", () => {
    expect(SOURCE).toContain("staff.residency.disclaimer");
    const text = ja["staff.residency.disclaimer"];
    // **短くしない。** 「就労可否を判定するものではありません」が核。
    expect(text).toContain("就労可否を判定するものではありません");
    expect(text).toContain("事業者様の責任");
  });

  it("個人の実績を出す列が無い（security.md §5 / CLAUDE.md §4）", () => {
    for (const forbidden of ["ranking", "fastest", "score", "completedCount", "averageMinutes"]) {
      expect(CODE, forbidden).not.toContain(forbidden);
    }
  });

  it("単価を引いていない（PK-SPEC-P8 §1.3 MUST / プロトタイプに列が無い）", () => {
    for (const forbidden of ["payRule", "listPayRules", "unitPrice", "hourlyRate"]) {
      expect(CODE, forbidden).not.toContain(forbidden);
    }
  });

  it("言語の構成に「評価には使用しません」が入っている（security.md §5）", () => {
    expect(ja["staff.languages.note"]).toContain("評価には使用しません");
  });
});

describe("在留資格の書き込み（P8-02）", () => {
  it("**loader の `can()` に頼らず `assertPermission()` を通す**（security.md §1）", () => {
    // 画面の出し分けは権限制御ではない。書き込みは必ず落とす。
    expect(WRITE_SOURCE).toContain('assertPermission(tenant, "residency.write"');
  });

  it("2 つのフォームを `intent` で分けている（項目の有無で推測しない）", () => {
    expect(SOURCE).toContain('fieldOf(form, "intent") === "residency"');
  });

  it("**PIN を持つ画面に監査ログの口を置いていない**（initialPin.spec.ts）", () => {
    // `staff.tsx` は初期 PIN を `action` の戻り値として運ぶ。
    // 同居させると、取り違えたときに PIN が監査ログへ入りうる。
    expect(CODE).not.toContain("recordAudit");
  });

  it("監査ログを残す（security.md §6）", () => {
    expect(WRITE_SOURCE).toContain('action: "residency.updated"');
  });

  it("**監査ログに載せるのは期限と種別だけ**（ノートを写さない）", () => {
    // `after` にノート・週上限・許可の要否を入れていないこと。
    const after = /after: \{ statusType: [^}]*\}/.exec(WRITE_SOURCE)?.[0] ?? "";
    expect(after).toContain("statusType");
    expect(after).toContain("expiresOn");
    for (const forbidden of ["note", "weeklyHourLimit", "workPermitRequired", "statusLabel"]) {
      expect(after, forbidden).not.toContain(forbidden);
    }
  });

  it("期限切れの解除ボタンを置いていない（仕様 §1.4 MUST）", () => {
    // 解除は `expiresOn` の更新だけ。**別の経路を作らない。**
    for (const forbidden of ["unblock", "clearExpiry", "解除", "強制"]) {
      expect(CODE, forbidden).not.toContain(forbidden);
    }
  });

  it("就労可否を聞くフォーム項目が無い（同 MUST）", () => {
    for (const forbidden of ["canWork", "就労可", "働けますか"]) {
      expect(CODE, forbidden).not.toContain(forbidden);
    }
  });
});

describe("スタッフ詳細レイヤー（人間の指示 2026-08-22）", () => {
  it("開いているかどうかを URL に持つ（`useState` に持たない）", () => {
    // 画面を共有したときに同じものが開く。JS が動かなくても開く。
    expect(SOURCE).toContain('searchParams.get("panel")');
    expect(CODE).not.toContain("useState");
  });

  it("絞り込みを持ち回る（開いて閉じたら一覧が変わる、をしない）", () => {
    expect(SOURCE).toContain("function panelHref(filter: StaffFilter");
    expect(SOURCE).toContain('params.set("status", filter)');
  });

  it("レイヤーの中身は開いている 1 名ぶんだけを引く（INV-08 と同じ考え方）", () => {
    // 一覧（`listOrgStaff()`）に連絡先を混ぜると、組織全員のメールが
    // loader の戻り値（= HTML に載る JSON）に出る。
    expect(SOURCE).toContain("loadStaffDetail(env, tenant, membershipId, extra)");
    expect(CODE).not.toContain("listOrgStaffDetail");
  });

  it("**在留資格をレイヤーへ渡すのは読める相手だけ**（INV-08）", () => {
    // 一覧はすでに引いてあるので引き当てるだけ。**渡すかどうかを
    // `canReadResidency` で切る** — 渡してから画面で隠す形にしない。
    expect(SOURCE).toContain("...(canReadResidency ? { residency } : {})");
  });

  it("在留資格のフォームは `residency.write` で出す（`OWNER` は読めても書けない）", () => {
    // 読めるかどうかで出すと、`OWNER` に押しても通らない口が見える。
    expect(SOURCE).toContain('can(tenant, "residency.write"');
    expect(SOURCE).toContain("canWriteResidency ? (");
  });

  it("在留資格のフォームが対象を選ばせない（取り違えを作らない）", () => {
    // レイヤーは開いている本人のもの。`staffProfileId` は隠しで運ぶ。
    const form = /intent" value="residency"[\s\S]*?<\/Form>/.exec(SOURCE)?.[0] ?? "";
    expect(form, "在留資格のフォームが読めていない").not.toBe("");
    expect(form).toContain('type="hidden" name="staffProfileId"');
    expect(form).not.toContain("staff.residency.staff");
  });

  it("表示言語の選択肢を画面で並べ直さない（`STAFF_LOCALES` が唯一の正）", () => {
    // 以前は `ja` / `en` を直書きしていて、7 言語のうち 2 つしか選べなかった。
    expect(SOURCE).toContain("STAFF_LOCALES.map((locale)");
    expect(CODE).not.toContain('<option value="en">');
  });

  it("4 つのフォームを `intent` で分けている（項目の有無で推測しない）", () => {
    expect(SOURCE).toContain('fieldOf(form, "intent") === "residency"');
    expect(SOURCE).toContain('fieldOf(form, "intent") === "staffUpdate"');
    expect(SOURCE).toContain('fieldOf(form, "intent") === "staffActive"');
  });

  it("**PIN を持つ画面に監査ログの口を置いていない**（編集を足しても同じ）", () => {
    // 既存の検査（`describe("在留資格の書き込み")`）と同じ境界。
    // 編集・停止の `recordAudit()` は `lib/staff/edit.ts` にある。
    expect(CODE).not.toContain("recordAudit");
    expect(EDIT_SOURCE).toContain('action: "user.updated"');
  });

  it("停止は片道にしない（再開の口がある）", () => {
    // 消せない操作を画面に置かない。停止したまま戻せないと、
    // 復旧の口が別の管理者を探すことしか無くなる。
    expect(EDIT_SOURCE).toContain('action: input.isActive ? "user.reactivated"');
    expect(SOURCE).toContain("staff.panel.resume");
  });

  it("物理削除の口を作っていない（PK-SPEC-P0 §26）", () => {
    // 過去のタスク・検査・証跡がこの人を参照している。行を消すと、
    // 記録の側が誰の作業だったかを失う。
    for (const forbidden of ["deleteUser", "deleteStaff", 'method="delete"', "DELETE"]) {
      expect(CODE, forbidden).not.toContain(forbidden);
      expect(EDIT_SOURCE, forbidden).not.toContain(forbidden);
    }
  });

  it("この画面から管理系ユーザーを触れない（W-12 の安全装置を迂回しない）", () => {
    expect(EDIT_SOURCE).toContain("FIELD_STAFF_ROLES");
    expect(EDIT_SOURCE).toContain("staffNotField");
  });

  it("**閉じるはレイヤーの左端。** 右上に置かない（人間の指示 2026-08-22）", () => {
    // レイヤーは右端に出るので、右上の × はトップバーのログアウトボタンの
    // 真下に来る。閉じると × ごと消えるため、勢いで 2 回押すと 2 回目が
    // ログアウトに当たる。**見出しより先に閉じるが来ること**を固定する。
    const head = /pk-drawer__head[\s\S]*?<\/div>/.exec(SOURCE)?.[0] ?? "";
    expect(head, "pk-drawer__head が読めていない").not.toBe("");
    expect(head.indexOf("pk-drawer__close")).toBeGreaterThan(-1);
    expect(head.indexOf("pk-drawer__title")).toBeGreaterThan(-1);
    expect(head.indexOf("pk-drawer__close")).toBeLessThan(head.indexOf("pk-drawer__title"));
  });

  it("閉じるを右端へ寄せる指定が残っていない（CSS で戻らないこと）", () => {
    const css = readFileSync(
      join(import.meta.dirname, "..", "..", "styles", "app.css"),
      "utf8",
    );
    const rule = /\.pk-drawer__close\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule, ".pk-drawer__close の規則が読めていない").not.toBe("");
    expect(rule).not.toMatch(/margin-left:\s*auto/);
  });

  it("編集にスタッフ番号と PIN の欄が無い（ログインの 3 フィールド）", () => {
    // 番号は現場に配った案内カードにも刷ってある。PIN の再発行は W-12。
    const editForm = /intent" value="staffUpdate"[\s\S]*?<\/Form>/.exec(SOURCE)?.[0] ?? "";
    expect(editForm).not.toBe("");
    for (const forbidden of ["staffNumber", "pin", "PIN"]) {
      expect(editForm, forbidden).not.toContain(forbidden);
    }
  });
});

// ────────────────────────────────────────────────────────────
// 閲覧の記録（INV-08 v2 / DECISIONS #261）
// ────────────────────────────────────────────────────────────

describe("在留資格を見たことを記録する", () => {
  it("**読めたときだけ記録する**（読めない相手の行を作らない）", () => {
    expect(SOURCE).toContain("if (canReadResidency) {");
    expect(SOURCE).toContain("recordResidencyView(env, tenant, {");
  });

  /**
   * **監査ログの口をこの画面に置かない。**
   *
   * `staff.tsx` は初期 PIN を `action` の戻り値として運ぶ。ここに
   * `recordAudit` 系を直接置くと、取り違えたときに PIN が監査ログへ
   * 入りうる（上の「PIN を持つ画面に監査ログの口を置いていない」）。
   * 記録は `lib/staff/residencyAudit.ts` が持ち、**この画面が渡すのは
   * 操作者だけ。時刻は `ctx.now` から取る。**
   */
  it("**渡すのは操作者だけ。時刻は `ctx.now`**（値を渡せる形にしない）", () => {
    const call = /recordResidencyView\(env, tenant, \{([\s\S]*?)\}\);/.exec(SOURCE);
    expect(call, "recordResidencyView の呼び出しが読めていない").not.toBeNull();
    const body = call?.[1] ?? "";
    for (const forbidden of ["before", "after", "expiresOn", "displayName", "statusType", "pin"]) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });
});

// ────────────────────────────────────────────────────────────
// 自動で動く規則の見せ方（OPEN_QUESTIONS #124 の決着 / 2026-08-22）
// ────────────────────────────────────────────────────────────

describe("在留資格の自動ルール", () => {
  it("**押せないスイッチを置かない**（設定できると誤認させない）", () => {
    // 見た目だけのスイッチは「切れるはずのものが壊れている」と読める。
    for (const forbidden of ["pk-ruleswitch", "__knob", "ruleswitch"]) {
      expect(CODE, forbidden).not.toContain(forbidden);
    }
    expect(CODE).toContain("pk-rulelist");
  });

  it("状態を普通の文字で読ませる（`role=\"img\"` と `title` に預けない）", () => {
    expect(CODE).toContain("pk-rulelist__state");
    // 印は装飾。**説明を `role="img"` や `title` に預けない。**
    // （`role="img"` は案内カードの QR が正当に使うので、走査は
    //   `ResidencyRule` の中だけに絞る。）
    const rule = /function ResidencyRule\([\s\S]*?\n\}/.exec(SOURCE)?.[0] ?? "";
    expect(rule, "ResidencyRule が読めていない").not.toBe("");
    expect(rule).toContain('aria-hidden="true"');
    expect(rule).not.toContain('role="img"');
    expect(rule).not.toContain("title=");
  });

  it("通知は「常時有効」、割当停止は「必須」と出す", () => {
    expect(SOURCE).toContain("staff.residency.manage.stateAlways");
    expect(SOURCE).toContain("staff.residency.manage.stateRequired");
    expect(ja["staff.residency.manage.stateAlways"]).toBe("常時有効");
    expect(ja["staff.residency.manage.stateRequired"]).toBe("必須");
  });

  it("**赤は実際の期限切れにだけ使う**（但し書きを赤で出さない）", () => {
    expect(CODE).not.toContain("pk-alert--danger");
    const css = readFileSync(join(import.meta.dirname, "..", "..", "styles", "app.css"), "utf8");
    expect(css).not.toContain(".pk-alert--danger");
    // 期限切れの行の色は残す（`ExpiryCell` の `--over`）。
    expect(css).toContain(".pk-expiry--over");
  });

  it("§1.4 MUST の但し書きは残っている", () => {
    expect(SOURCE).toContain("staff.residency.manage.illegal");
    expect(SOURCE).toContain("staff.residency.manage.human");
  });
});

// ────────────────────────────────────────────────────────────
// 保存したらレイヤーが閉じる／待っている間（人間の指示 2026-08-22）
// ────────────────────────────────────────────────────────────

describe("レイヤーの保存と待ち時間", () => {
  it("**成功したらリダイレクトで閉じる**（画面側で閉じない）", () => {
    // POST → リダイレクト → GET。JS が動かなくても閉じ、戻るボタンで
    // 開いたままの状態に戻らない。
    expect(SOURCE).toContain("function savedRedirect(request: Request, saved: string): Response");
    expect(SOURCE).toContain('savedRedirect(request, outcome.staffSaved)');
    expect(SOURCE).toContain('savedRedirect(request, "RESIDENCY")');
  });

  it("成功の知らせは `?saved=` で運ぶ（`useActionData` はリダイレクトで消える）", () => {
    expect(SOURCE).toContain('searchParams.get("saved")');
    expect(SOURCE).toContain("parseSaved");
  });

  it("知らない `saved` の値を画面に出さない（URL から来る）", () => {
    expect(SOURCE).toContain("SAVED_KINDS as readonly string[]).includes");
  });

  it("**失敗の理由はレイヤーの中に出す**（幕の下に隠さない）", () => {
    expect(SOURCE).toContain("error={drawerErrorKey(result)}");
    expect(SOURCE).toContain('<p className="pk-notice pk-notice--warn">{t(error)}</p>');
  });

  it("送信中はポインタを変え、送信ボタンを押せなくする", () => {
    expect(SOURCE).toContain('navigation.state !== "idle"');
    expect(SOURCE).toContain("pk-drawer--busy");
    expect(SOURCE).toContain("disabled={busy}");
  });

  it("閉じるは文字ではなく図形（フォントで上下がずれない）", () => {
    // `×` は字面の位置がフォントごとに違い、見出しとの上下がずれる。
    // **コメントを落として見る** — この検査の理由を書いた注記そのものに
    // `×` が出てくる（`repositories.spec.ts` の `CODE` と同じ理由）。
    const head = /pk-drawer__head[\s\S]*?<\/div>/.exec(CODE)?.[0] ?? "";
    expect(head, "pk-drawer__head が読めていない").not.toBe("");
    expect(head).toContain("pk-drawer__closeIcon");
    expect(head).not.toContain("×");
  });
});
