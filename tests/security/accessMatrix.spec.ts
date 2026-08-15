/**
 * アクセス制御の再検証（PK-SPEC-P7 §6.4 / P7-13）。
 *
 * task:  docs/tasks/P7-13.md
 * ルール: .claude/rules/security.md §1
 *
 * ── `permission.spec.ts` と役割が違う ───────────────────
 * あちらは**マトリクスの中身**（どのロールがどの action を持つか）を
 * 固定する。ここが見るのは「**そのマトリクスが実際に効いているか**」で、
 * API の経路が 1 本でも `assertPermission()` を通さずに生えていないかを
 * ソースごと走査する。
 *
 * **マトリクスが正しくても、呼ばれていなければ意味が無い。**
 * §6.4 の「全ロール × 全画面 × 全 API のマトリクスを再検証する」は
 * この 2 つが揃って初めて満たせる。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const API_DIR = join(ROOT, "apps", "web", "src", "routes", "api", "v1");
const APP_DIR = join(ROOT, "apps", "web", "src", "routes", "app");

/** ブロックコメント・行コメントを落とす。**注記を検査対象にしない。** */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

function sourceFiles(dir: string, extension: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(extension) && !name.endsWith(`.spec${extension}`))
    .sort();
}

/**
 * `assertPermission()` を呼ばない経路と、**その理由。**
 *
 * ── 理由の無い免除を作らせない ──────────────────────────
 * `Set` ではなく `Record` にしてあるのは、**免除に必ず一文を書かせる**ため
 * （`archivePolicy.ts` の `EXCLUSION_REASONS` と同じ向き）。
 * 「なぜ権限判定が要らないのか」を答えられないものは免除ではない。
 */
const API_EXEMPTIONS: Readonly<Record<string, string>> = {
  "auth.ts": "セッションを作る経路。まだロールが無い",
  "session.ts": "セッションを作る経路。まだロールが無い",
  "dev.ts": "本番では 404（シード投入）",
  "webhooks.ts": "署名で守る（security.md §7）",
  "integrationWebhooks.ts": "署名で守る（security.md §7）",
  "public.ts": "API キーのスコープで守る（DECISIONS #151）",
  "files.ts": "署名付き URL の受け口。角印だけ",
  "properties.ts":
    "自分が到達できる施設だけを返す。絞りは第 1 層（listSelectableProperties）",
};

/**
 * 権限判定を共有の関数へ**委ねている**経路と、その委任先。
 *
 * **免除ではない。** 委任先が `assertPermission()` を呼ぶことを下の
 * テストが確かめる。委任先が呼ばなくなれば、そこで落ちる。
 *
 * P7-02 で登録画面（`/app/settings/staff`）を作ったとき、同じ操作の実装が
 * API と画面の 2 つになるのを避けて `lib/staff/register.ts` へ寄せた
 * （DECISIONS #181 と同じ向き）。**権限判定も一緒に移っている。**
 */
const API_DELEGATIONS: Readonly<Record<string, string>> = {
  "users.ts": "lib/staff/register.ts",
};

/**
 * 画面側の免除。
 *
 * **`assertPermission()` か `can()` のどちらかを呼べば合格。**
 * 画面は 403 を見せずに戻すことがある（`vendorPlan.tsx` の注記）ので、
 * `can()` + `redirect` も正当な形。
 */
const SCREEN_EXEMPTIONS: Readonly<Record<string, string>> = {
  "layout.tsx": "シェル。データを読まない",
  "dashboard.tsx": "loader を持たない。文言だけの画面",
  "switchProperty.ts": "施設の切替。到達可能な施設は第 1 層が絞る",
  "evidenceList.tsx":
    "自分が到達できる施設の証跡だけを返す。絞りは第 1 層（listEvidenceForProperty）",
  "propertyBoard.tsx": "到達できない施設は第 1 層が NotFoundError（INV-31）",
};

describe("§6.4 全 API が権限判定を通る", () => {
  const files = sourceFiles(API_DIR, ".ts");

  it("API の経路が 37 本以上ある（走査が空振りしていない）", () => {
    // ここが 0 になると、下のテストが全部素通りする。
    expect(files.length).toBeGreaterThanOrEqual(30);
  });

  it.each(
    files.filter(
      (name) => API_EXEMPTIONS[name] === undefined && API_DELEGATIONS[name] === undefined,
    ),
  )("%s は assertPermission() を呼ぶ", (name) => {
    expect(code(join(API_DIR, name))).toContain("assertPermission(");
  });

  /**
   * **委任先まで追いかける。** 「共有の関数へ寄せた」を理由に
   * 権限判定そのものが消えるのを防ぐ。
   */
  it.each(Object.entries(API_DELEGATIONS))("%s の委任先 %s が assertPermission() を呼ぶ", (
    name,
    target,
  ) => {
    expect(files, name).toContain(name);
    expect(code(join(ROOT, "apps", "web", "src", ...target.split("/")))).toContain(
      "assertPermission(",
    );
  });

  it("**免除に理由が書いてある**（理由の無い免除を作らせない）", () => {
    for (const [name, reason] of Object.entries(API_EXEMPTIONS)) {
      expect(reason.length, name).toBeGreaterThan(10);
    }
  });

  it("**免除した経路が実在する**（消えたファイルの免除を残さない）", () => {
    for (const name of Object.keys(API_EXEMPTIONS)) {
      expect(files, name).toContain(name);
    }
  });

  it("**第 1 層に頼る免除は 1 本だけ。** 増やすときは理由を確かめる", () => {
    // 「リポジトリ層が絞るから」は正当だが、**増えるほど三重防御の
    // 1 層目だけに寄る。** ここが増えたら §19.4 を読み直すこと。
    const layerOne = Object.entries(API_EXEMPTIONS).filter(([, reason]) =>
      reason.includes("第 1 層"),
    );
    expect(layerOne.map(([name]) => name)).toEqual(["properties.ts"]);
  });
});

describe("§6.4 全画面が権限判定を通る", () => {
  const files = sourceFiles(APP_DIR, ".tsx");

  it("画面が 20 枚以上ある（走査が空振りしていない）", () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  it.each(files.filter((name) => SCREEN_EXEMPTIONS[name] === undefined))(
    "%s の loader が assertPermission() か can() を呼ぶ",
    (name) => {
      // **フロントの非表示は権限制御とみなさない**（CLAUDE.md §5）。
      // loader がサーバー側で落とすこと。
      const source = code(join(APP_DIR, name));
      // **3 つ目の形**: `ScopeForbiddenError` を捕まえて戻す
      // （`orgDashboard.tsx`）。判定そのものは呼んだ lib が行っている。
      const guarded =
        source.includes("assertPermission(") ||
        source.includes("can(") ||
        source.includes("ScopeForbiddenError");
      expect(guarded, name).toBe(true);
    },
  );

  it("**免除に理由が書いてある**", () => {
    for (const [name, reason] of Object.entries(SCREEN_EXEMPTIONS)) {
      expect(reason.length, name).toBeGreaterThan(8);
    }
  });

  it("**免除した画面が実在する**", () => {
    const all = [...files, ...readdirSync(APP_DIR).filter((name) => name.endsWith(".ts"))];
    for (const name of Object.keys(SCREEN_EXEMPTIONS)) {
      expect(all, name).toContain(name);
    }
  });
});

/**
 * §6.4 の重点確認 5 件。
 *
 * **4 件は `permission.spec.ts` が既に押さえている**（マトリクスの中身）。
 * ここが足すのは残る 1 件と、「その 4 件が消えていないこと」。
 */
describe("§6.4 の重点確認", () => {
  const MATRIX_SPEC = code(
    join(ROOT, "apps", "web", "src", "lib", "auth", "permission.spec.ts"),
  );

  it.each([
    ["CLEANER が差異レポートに到達できない", "差異レポートに到達できない"],
    ["CLEANER が忘れ物の保管場所を見られない", "忘れ物の保管場所"],
    ["INSPECTOR が請求情報を見られない", "請求情報を見られない"],
    ["AUDITOR が書き込み操作を一切できない", "書き込みアクションすべてで DENY"],
  ])("%s（`permission.spec.ts` が固定している）", (_label, marker) => {
    expect(MATRIX_SPEC).toContain(marker);
  });

  it("**VENDOR_ADMIN が受託外施設を見られない**（施設スコープで絞る）", () => {
    // 5 件目。マトリクスでは表せない（`VENDOR_ADMIN` は施設スコープの
    // ロールで、action の可否ではなく**見える施設の範囲**の話）。
    //
    // **絞りは「組織全体ロールに入っていないこと」で効く**（`base.ts`）。
    // 名指しの除外ではなく、`ORG_WIDE_ROLES` に載っていない全ロールが
    // `allowedPropertyIds` で絞られる。**この向きが安全側**で、
    // ロールを足したときに既定で絞られる（載せ忘れが漏洩にならない）。
    const base = code(join(ROOT, "packages", "db", "src", "repositories", "base.ts"));
    const orgWide = /ORG_WIDE_ROLES[^=]*=[^[]*\[([^\]]*)\]/.exec(base)?.[1] ?? "";
    expect(orgWide, "ORG_WIDE_ROLES が読めていない").not.toBe("");
    expect(orgWide).not.toContain("VENDOR_ADMIN");
    // 越境そのものは `tests/tenant-isolation/` の第 4 パターンが見る。
    expect(orgWide).not.toContain("CLEANER");
    expect(orgWide).not.toContain("INSPECTOR");
    expect(orgWide).not.toContain("PROPERTY_MANAGER");
  });
});
