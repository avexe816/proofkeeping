import { setupCompanySchema, SETUP_STEPS, type SetupStep } from "@pk/contracts";
import { ORG_TYPES, findOrganization, recordAudit, updateOrganizationSetup } from "@pk/db";
import {
  Form,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { ORGANIZATION_TARGET, assertPermission } from "../../lib/auth/permission.js";
import { t } from "../../lib/i18n.js";
import {
  SETUP_STEP_TOTAL,
  canComplete,
  completeSetup,
  doneCount,
  markStep,
  nextStep,
  parseSetupState,
  reopenSetup,
  serializeSetupState,
  stateOf,
} from "../../lib/setup/state.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

/**
 * セットアップウィザード（PK-SPEC-P7 §2.3）。
 *
 *   /app/setup
 *
 * task:  docs/tasks/P7-01.md
 * ルール: .claude/rules/ui-writing.md §1
 * 決定:  docs/DECISIONS.md #179 / #180 / #181
 *
 * ── 6 ステップすべてがスキップできる（§2.3 MUST）────────
 * どのステップにも「あとで設定する」がある。**押すと次へ進み、
 * 次に開いたときそのステップで止まらない**（`nextStep()` が飛ばす）。
 * スキップは取り消せる。もう一度開いて「設定した」を押せばよい。
 *
 * ── 既存の画面を作り直さない（DECISIONS #181）──────────
 * Step 3（客室）と Step 4（チェックリスト）は**既存の画面へ送り出すだけ。**
 * ウィザードの中に同じフォームをもう 1 つ置くと、**同じ操作の入口が 2 つに
 * なって片方だけ直る。** §2.3 のワイヤーはステップの中で登録する形だが、
 * **1 つの操作に 1 つの実装**を優先した。
 *
 * **Step 2（施設）と Step 5（スタッフ）には送り先が無い。**
 * 施設を作る画面は存在せず、スタッフの登録は API だけ（P7-01 の前半で
 * `POST /api/v1/users` を置いた）。**偽のリンクを置かず、その旨を出す**
 * （OPEN_QUESTIONS #103）。画面ができたら `STEP_HREF` へ 1 行。
 *
 * ここが持つのは「どこまで進んだか」だけ。**進捗は自動では進まない。**
 * 客室を登録しても Step 3 は完了にならず、戻ってきて押す必要がある。
 * 導入前から客室がある組織と区別できないため（`lib/setup/state.ts`）。
 *
 * ── 100 室の一括登録（§2.3 MUST の 3 分以内）───────────
 * Step 3 が送り出す `/app/settings/rooms` の CSV 取込がそれ。
 * **ウィザード側に別の取込を実装しない。**
 */

interface SetupStepView {
  step: SetupStep;
  state: "DONE" | "SKIPPED" | null;
  /** 送り出す先。Step 1 と 6 は自分の中で完結するので `null`。 */
  href: string | null;
}

interface SetupData {
  organizationName: string;
  orgType: string | null;
  current: SetupStep;
  steps: SetupStepView[];
  doneCount: number;
  total: number;
  canComplete: boolean;
  completedAt: number | null;
}

/**
 * ステップの送り先。**既存の画面をそのまま使う**（DECISIONS #181）。
 *
 * `null` は 2 種類ある。
 *
 *   company / done   このウィザードの中で完結する
 *   property         **まだ画面が無い**（OPEN_QUESTIONS #103）。施設の作成は
 *                    API 経由でしか行えない。**偽のリンクを置かない。**
 *                    画面ができたらここへ 1 行。
 *
 * **Step 5（スタッフ）は P7-02 で画面ができた。** 登録した直後に
 * 現場掲示用の案内（§2.4 v1.1）を印刷するところまでが 1 画面に収まる。
 */
const STEP_HREF: Readonly<Record<SetupStep, string | null>> = {
  company: null,
  property: null,
  rooms: "/app/settings/rooms",
  checklist: "/app/settings/checklists",
  staff: "/app/settings/staff",
  done: null,
};

/** 画面がまだ無いステップ。**案内の文を出す**（OPEN_QUESTIONS #103）。 */
const STEPS_WITHOUT_SCREEN: readonly SetupStep[] = ["property"];

function stepQuery(request: Request): SetupStep | null {
  const raw = new URL(request.url).searchParams.get("step");
  return SETUP_STEPS.find((step) => step === raw) ?? null;
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<SetupData> {
  const env = getEnv(context);
  const now = new Date();
  const { tenant } = await requireAppContext(env, request, now);
  // **組織の設定を触る操作。** 施設スコープのロールは到達しない。
  assertPermission(tenant, "organization.write", ORGANIZATION_TARGET);

  const organization = await findOrganization(env, tenant);
  const state = parseSetupState(organization?.setupState ?? null);

  return {
    organizationName: organization?.name ?? "",
    orgType: organization?.orgType ?? null,
    current: stepQuery(request) ?? nextStep(state),
    steps: SETUP_STEPS.map((step) => ({
      step,
      state: stateOf(state, step),
      href: STEP_HREF[step],
    })),
    doneCount: doneCount(state),
    total: SETUP_STEP_TOTAL,
    canComplete: canComplete(state),
    completedAt: state.completedAt,
  };
}

export async function action({ request, context }: ActionFunctionArgs): Promise<Response> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);
  assertPermission(tenant, "organization.write", ORGANIZATION_TARGET);

  const form = await request.formData();
  const intent = form.get("intent");
  const organization = await findOrganization(env, tenant);
  const state = parseSetupState(organization?.setupState ?? null);

  const rawStep = form.get("step");
  const step = SETUP_STEPS.find((candidate) => candidate === rawStep) ?? null;

  // ── 会社情報（Step 1）。**空でも通す。** スキップと同じ扱いにしない
  //    （名前だけ入れて種別を答えない、が普通に起きる）。
  if (intent === "save-company") {
    const parsed = setupCompanySchema.safeParse({
      name: form.get("name") ?? undefined,
      orgType: form.get("orgType") === "" ? undefined : (form.get("orgType") ?? undefined),
    });
    if (!parsed.success) return redirectToStep("company");

    const next = markStep(state, "company", "DONE");
    await updateOrganizationSetup(env, tenant, {
      ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
      ...(parsed.data.orgType === undefined ? {} : { orgType: parsed.data.orgType }),
      setupState: serializeSetupState(next),
    });
    await recordAudit(env, tenant, {
      actorId: session.membershipId,
      action: "organization.updated",
      targetType: "organization",
      targetId: tenant.organizationId,
      after: { name: parsed.data.name ?? null, orgType: parsed.data.orgType ?? null },
    });
    return redirectToStep(nextStep(next));
  }

  // ── 「設定した」／「あとで設定する」。**どちらも次へ進む。**
  if ((intent === "mark-done" || intent === "mark-skipped") && step !== null) {
    const next = markStep(state, step, intent === "mark-done" ? "DONE" : "SKIPPED");
    await updateOrganizationSetup(env, tenant, { setupState: serializeSetupState(next) });
    return redirectToStep(nextStep(next));
  }

  if (intent === "complete") {
    const next = completeSetup(state, now);
    await updateOrganizationSetup(env, tenant, { setupState: serializeSetupState(next) });
    return redirectToStep("done");
  }

  if (intent === "reopen") {
    const next = reopenSetup(state);
    await updateOrganizationSetup(env, tenant, { setupState: serializeSetupState(next) });
    return redirectToStep(nextStep(next));
  }

  return redirectToStep(step ?? nextStep(state));
}

function redirectToStep(step: SetupStep): Response {
  return new Response(null, { status: 303, headers: { Location: `/app/setup?step=${step}` } });
}

/** 文言キー。**JSX に日本語を直書きしない**（ui-writing.md §1）。 */
function stepTitleKey(step: SetupStep): Parameters<typeof t>[0] {
  return `setup.step.${step}.title` as Parameters<typeof t>[0];
}

function stepBodyKey(step: SetupStep): Parameters<typeof t>[0] {
  return `setup.step.${step}.body` as Parameters<typeof t>[0];
}

export default function Setup() {
  const data = useLoaderData<SetupData>();
  const current = data.steps.find((view) => view.step === data.current) ?? data.steps[0];
  const index = SETUP_STEPS.indexOf(data.current) + 1;

  return (
    <section className="pk-page">
      <h1 className="pk-page__title">{t("setup.title")}</h1>
      <p className="pk-page__lede">{t("setup.lede")}</p>

      <p className="pk-setup__progress">
        {`${t("setup.progress")}: ${String(data.doneCount)} / ${String(data.total)}`}
      </p>

      <ol className="pk-setup__steps">
        {data.steps.map((view) => (
          <li key={view.step} className={view.step === data.current ? "is-current" : ""}>
            <a href={`/app/setup?step=${view.step}`}>{t(stepTitleKey(view.step))}</a>
            {view.state === "DONE" ? <span>{t("setup.state.done")}</span> : null}
            {view.state === "SKIPPED" ? <span>{t("setup.state.skipped")}</span> : null}
          </li>
        ))}
      </ol>

      {data.completedAt === null ? null : (
        <div className="pk-setup__closed">
          <p>{t("setup.closed")}</p>
          <Form method="post">
            <input type="hidden" name="intent" value="reopen" />
            <button type="submit">{t("setup.reopen")}</button>
          </Form>
        </div>
      )}

      <article className="pk-setup__panel">
        <h2>{`${String(index)} / ${String(SETUP_STEPS.length)} ${t(stepTitleKey(data.current))}`}</h2>
        <p>{t(stepBodyKey(data.current))}</p>

        {data.current === "company" ? (
          <Form method="post" className="pk-form">
            <input type="hidden" name="intent" value="save-company" />
            <label htmlFor="name">{t("setup.company.name")}</label>
            <input id="name" name="name" defaultValue={data.organizationName} maxLength={120} />

            <label htmlFor="orgType">{t("setup.company.orgType")}</label>
            <select id="orgType" name="orgType" defaultValue={data.orgType ?? ""}>
              <option value="">{t("setup.company.orgType.unset")}</option>
              {ORG_TYPES.map((value) => (
                <option key={value} value={value}>
                  {t(`setup.orgType.${value}` as Parameters<typeof t>[0])}
                </option>
              ))}
            </select>
            <p className="pk-form__note">{t("setup.company.orgTypeNote")}</p>

            <button type="submit">{t("setup.save")}</button>
          </Form>
        ) : null}

        {current === undefined || current.href === null ? null : (
          <p>
            <a className="pk-button" href={current.href}>
              {t("setup.open")}
            </a>
          </p>
        )}

        {/* **画面がまだ無いことを隠さない。** 押せないリンクより正直な一文。 */}
        {STEPS_WITHOUT_SCREEN.includes(data.current) ? (
          <p className="pk-form__note">{t("setup.noScreen")}</p>
        ) : null}

        {data.current === "done" ? (
          <Form method="post">
            <input type="hidden" name="intent" value="complete" />
            <button type="submit" disabled={!data.canComplete}>
              {t("setup.complete")}
            </button>
            {data.canComplete ? null : <p>{t("setup.completeBlocked")}</p>}
          </Form>
        ) : (
          <div className="pk-setup__actions">
            <Form method="post">
              <input type="hidden" name="intent" value="mark-done" />
              <input type="hidden" name="step" value={data.current} />
              <button type="submit">{t("setup.markDone")}</button>
            </Form>
            {/* §2.3 MUST。**どのステップにもこれがある。** */}
            <Form method="post">
              <input type="hidden" name="intent" value="mark-skipped" />
              <input type="hidden" name="step" value={data.current} />
              <button type="submit">{t("setup.skip")}</button>
            </Form>
          </div>
        )}
      </article>
    </section>
  );
}
