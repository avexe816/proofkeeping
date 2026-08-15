/**
 * 文書に当てる語彙。`customerDocs.spec.ts` と `runbook.spec.ts` が使う。
 *
 * task:  docs/tasks/P7-15.md / docs/tasks/P7-16.md
 * 決定:  docs/DECISIONS.md #174
 * ルール: .claude/rules/ui-writing.md §2
 *
 * ── なぜ `forbidden-words-list.js` を再利用しないのか ────
 * あちらには「エラー」「失敗」「不備」など、PK-IMPL-CONTRACT §5.1 の
 * **現場 UI のマイクロコピー**も入っている。あれは「オフラインの現場に
 * 不安を与えない」ための表現規則で、運用文書（「10 回失敗で 30 分ロック」
 * 「マイグレーションが失敗したら」）に当てると事実を書けなくなる。
 *
 * **ここに置くのは ui-writing.md §2 の語彙だけ。** 2 つの表が別々に
 * 存在するのではなく、**片方がもう片方の部分集合であることを
 * `customerDocs.spec.ts` が確かめている**（写経の防止）。
 *
 * ── 走査するのは読者が目にする本文だけ ──────────────────
 * HTML のコメントは印刷にも画面にも出ない。逆に「なぜその語を避けるのか」を
 * 書き残せる場所がコメントしか無い（`forbidden-words-list.js` を CI の
 * `--include` から外してあるのと同じ事情）。
 */

/** 避ける語と、代わりに使う語。 */
export const PROSE_FORBIDDEN: Readonly<Record<string, string>> = {
  不正: "使用しない",
  検知: "照合",
  監視: "稼働照合 / 内部統制の支援",
  疑わしい: "要確認項目",
  疑い: "使用しない",
  証拠: "証跡",
  異常: "通常と違う点",
  不審: "気づいたこと",
  報告義務: "記録のお願い",
  やり直し: "再清掃",
  無断宿泊: "使用しない",
};

/** 読者が目にする本文だけにする。 */
export function prose(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, "");
}

/** 本文に含まれる避けるべき語を返す。 */
export function forbiddenHits(source: string): string[] {
  const body = prose(source);
  return Object.keys(PROSE_FORBIDDEN).filter((word) => body.includes(word));
}
