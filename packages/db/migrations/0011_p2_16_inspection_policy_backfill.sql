-- P2-16 P1 暫定機能の移行（PK-SPEC-P2 §13.2 / OPEN_QUESTIONS #044）
--
-- `property.inspection_required`（P1 の真偽）を `property_inspection_policy`
-- の行へ移す。**手書きのマイグレーション。** drizzle-kit の生成物ではない
-- （スキーマは変わらない。移すのはデータ）。
--
-- ── 列は消さない ────────────────────────────────────────
-- architecture.md §6 の 3 段階のうち、これは②「両方書き込み・新列から読む」。
-- `property.inspection_required` の DROP は次リリース（③）で行う。
-- ここで消すと、旧コードが動いているシャードが起動できなくなる。
--
-- ── id を採番せずに施設 ID から作る ──────────────────────
-- ID は `{orgShortId}__{prefix}_{ulid}`（architecture.md §2）。SQL で ULID は
-- 作れないので、**施設 ID の ULID 部分をそのまま流用する。**
--   o7k2m9__prop_01JBXQ... → o7k2m9__ipol_01JBXQ...
-- 1 施設 1 行なので衝突しない。しかも決定的なので、この文を 2 回流しても
-- 同じ行を作ろうとして UNIQUE で弾かれる（`WHERE NOT EXISTS` と合わせて冪等）。
-- `__` は接頭辞の直前にしか現れないため、`instr()` の 1 個目で切って正しい。
--
-- ── 既に行がある施設は触らない ──────────────────────────
-- W-02 で検査方式を設定済みの施設は、その設定が正。P1 の真偽値で上書きしない。
--
-- ── 時刻は固定値 ────────────────────────────────────────
-- 1786700000000 = 2026-08-13T14:53:20Z。移行の実行時刻ではなく**移行そのものの
-- 時刻**を入れる。`unixepoch()` にするとシャードごとに値が変わり、
-- 「いつ移行したか」が 16 通りになる。
INSERT INTO `property_inspection_policy` (
	`id`,
	`organization_id`,
	`property_id`,
	`mode`,
	`sample_rate`,
	`min_daily_sample`,
	`always_inspect_checkin`,
	`always_inspect_rework`,
	`self_inspection_allowed`,
	`auto_assign_inspector`,
	`inspection_sla_minutes`,
	`created_at`,
	`updated_at`
)
SELECT
	substr(p.`id`, 1, instr(p.`id`, '__') - 1) || '__ipol_' || substr(p.`id`, instr(p.`id`, '__') + 7),
	p.`organization_id`,
	p.`id`,
	CASE WHEN p.`inspection_required` = 1 THEN 'ALL' ELSE 'NONE' END,
	CASE WHEN p.`inspection_required` = 1 THEN 100 ELSE 0 END,
	0,
	1,
	1,
	0,
	1,
	20,
	1786700000000,
	1786700000000
FROM `property` p
WHERE p.`id` LIKE '%\_\_prop\_%' ESCAPE '\'
	AND NOT EXISTS (
		SELECT 1
		FROM `property_inspection_policy` pol
		WHERE pol.`organization_id` = p.`organization_id`
			AND pol.`property_id` = p.`id`
	);
