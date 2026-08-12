/**
 * R2 のキー接頭辞。
 *
 * task:  docs/tasks/P0-16.md
 * ルール: .claude/rules/security.md §4
 *
 * **署名付き URL で読める範囲を 1 か所で決める。** 経路側に文字列を
 * 書くと、後から別の接頭辞を足したときに片方だけ広がる。
 */

/** 署名付き URL で配信してよい接頭辞（`DOCUMENTS` バケット）。 */
export const DOCUMENTS_PREFIX = "seals/";
