/**
 * 開通リンクの受け渡し（PF-16 / DECISIONS #245）。**経路はメール 1 通だけ。**
 *
 * task: docs/tasks/PF-16.md
 * 手順: docs/runbook/platform-bootstrap.md
 *
 * ── なぜメールなのか ────────────────────────────────────
 * 1 回限りの秘密を人へ渡す口が、この製品には既に 1 つある（Resend /
 * `consumers/notify.ts`）。**新しい受け渡しの仕組みを増やさない。**
 *
 * ── 採らなかった案 ──────────────────────────────────────
 *   * **workflow のログ・summary・artifact へ出す** — Actions のログは
 *     リポジトリの読み取り権限を持つ全員が読め、保存もされる。
 *     「1 回限り」が成り立たない。**要件で明示的に禁じられている。**
 *   * **workflow_dispatch の入力で受け取ったパスワードを使う** — 入力は
 *     マスクされず実行の記録に残る。既定パスワードを禁じた #240 の 3 と
 *     同じ穴になる。
 *   * **応答（HTTP）で runner へ返す** — 返した時点で runner のシェルに
 *     載り、`set -x` やエラー出力で漏れる余地ができる。
 *
 * ── 送れないなら発行しない ──────────────────────────────
 * `RESEND_API_KEY` が無い環境では**券を作らずに断る**（`bootstrap.ts` の 1）。
 * 「送れなかったから代わりにログへ」は採らない。
 *
 * ── 本文に何を書かないか ────────────────────────────────
 * パスワードも TOTP secret も復旧コードも、この時点では存在しない。
 * 書くのはリンクと期限だけ。**件名にも本文にも token 以外の秘密を載せない。**
 */

import type { Env } from "@pk/db";

/** 送信の入力。**平文の token はリンクの中にだけ現れる。** */
export interface BootstrapMailInput {
  to: string;
  /** `/plat/bootstrap/{token}` の完全な URL。 */
  link: string;
  expiresAt: Date;
}

/** 日本時間の `M月D日 H:MM`。期限を本文に書くためだけの整形。 */
function formatJst(at: Date): string {
  const jst = new Date(at.getTime() + 9 * 60 * 60 * 1000);
  const month = jst.getUTCMonth() + 1;
  const day = jst.getUTCDate();
  const hour = jst.getUTCHours();
  const minute = String(jst.getUTCMinutes()).padStart(2, "0");
  return `${String(month)}月${String(day)}日 ${String(hour)}:${minute}`;
}

/**
 * 開通リンクを送る。送れたら `true`。
 *
 * **失敗の中身をログへ流さない。** 宛先は個人情報（security.md §3）で、
 * 本文にはリンク（＝ token）が入っている。例外の中身も出さない。
 */
export async function sendBootstrapLink(env: Env, input: BootstrapMailInput): Promise<boolean> {
  if (typeof env.RESEND_API_KEY !== "string" || env.RESEND_API_KEY.trim() === "") return false;

  const body = [
    "ProofKeeping 運営コンソールの開通のご案内です。",
    "",
    "下のリンクを開き、パスワードを設定してください。",
    "続けて認証アプリの登録（2 要素認証）と復旧コードの保管をお願いします。",
    "",
    input.link,
    "",
    `このリンクは ${formatJst(input.expiresAt)}（日本時間）まで有効です。`,
    "一度使うと無効になります。期限を過ぎた場合は、発行の手順からやり直してください。",
    "",
    "心当たりが無い場合は、このメールを破棄してください。",
  ].join("\n");

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.RESEND_FROM_ADDRESS,
        to: [input.to],
        subject: "ProofKeeping 運営コンソールの開通",
        text: body,
      }),
    });
    return response.ok;
  } catch {
    // **中身を出さない**（宛先もリンクも入っている）。名前だけ残す。
    console.error("platform-bootstrap-mail-failed");
    return false;
  }
}
