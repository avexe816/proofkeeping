import {
  createCertification,
  createTrainingProgram,
  listCertifications,
  listOrgStaff,
  listStaffLedger,
  listTrainingPrograms,
  listTrainingRecords,
  upsertTrainingRecord,
  type TrainingProgramRow,
} from "@pk/db";
import {
  Form,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { ORGANIZATION_TARGET, assertPermission } from "../../lib/auth/permission.js";
import { businessDateOf } from "../../lib/businessDate.js";
import { t } from "../../lib/i18n.js";
import {
  buildTrainingPage,
  DEFAULT_TRAINING_PROGRAMS,
  type TrainingPage,
} from "../../lib/staff/trainingPage.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

/**
 * 研修と資格（P8-10 / プロトタイプ ops 08）。
 *
 *   /app/training
 *
 * task: docs/tasks/P8-10.md
 *
 * ── 記録の画面であって評価の画面ではない ────────────────
 * 研修は「修了したか」、資格は「いつ切れるか」。**点数・順位・
 * 修了までの速さを出さない**（security.md §5）。
 *
 * ── 門は `user.write`（OWNER / ORG_ADMIN）───────────────
 * スタッフ名を組織全体で並べ、記録の口を持つ画面。`ORGANIZATION_TARGET`
 * に対する `user.write` は組織全体ロールしか通らない。
 */

interface StaffOption {
  membershipId: string;
  displayName: string;
}

interface TrainingData {
  page: TrainingPage;
  programs: TrainingProgramRow[];
  staffOptions: StaffOption[];
}

type TrainingActionResult =
  | { recorded: true }
  | { certified: true }
  | { seeded: number }
  | { invalid: true };

export async function loader({ request, context }: LoaderFunctionArgs): Promise<TrainingData> {
  const env = getEnv(context);
  const now = new Date();
  const { tenant } = await requireAppContext(env, request, now);
  assertPermission(tenant, "user.write", ORGANIZATION_TARGET);

  const [staff, ledger, programs, records, certifications] = await Promise.all([
    listOrgStaff(env, tenant),
    listStaffLedger(env, tenant),
    listTrainingPrograms(env, tenant),
    listTrainingRecords(env, tenant),
    listCertifications(env, tenant),
  ]);

  return {
    page: buildTrainingPage({
      staff,
      ledger,
      programs,
      records,
      certifications,
      businessDate: businessDateOf(now),
    }),
    programs: programs.filter((program) => program.isActive),
    staffOptions: staff
      .filter((person) => person.isActive)
      .map((person) => ({ membershipId: person.membershipId, displayName: person.displayName })),
  };
}

function fieldOf(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export async function action({
  request,
  context,
}: ActionFunctionArgs): Promise<TrainingActionResult> {
  const env = getEnv(context);
  const now = new Date();
  const { tenant } = await requireAppContext(env, request, now);
  assertPermission(tenant, "user.write", ORGANIZATION_TARGET);

  const form = await request.formData();
  const intent = fieldOf(form, "intent");

  // ── 標準の 6 項目を投入する（プログラムが空のとき）────────
  if (intent === "seed-programs") {
    const existing = await listTrainingPrograms(env, tenant);
    // **2 回押しても増えない。** 1 件でもあれば何もしない（冪等）。
    if (existing.length > 0) return { seeded: 0 };
    let order = 1;
    for (const program of DEFAULT_TRAINING_PROGRAMS) {
      await createTrainingProgram(env, tenant, {
        name: program.name,
        expectedMinutes: program.expectedMinutes,
        // 研修資料は 7 言語で用意する（プロトタイプの注記）。**資料の
        // 実体は ProofKeeping の外**なので、ここは対応の宣言だけ。
        languages: ["ja", "en", "zh-CN", "vi", "id", "my", "ne"],
        sortOrder: order,
      });
      order += 1;
    }
    return { seeded: DEFAULT_TRAINING_PROGRAMS.length };
  }

  // ── 研修の修了を記録する ────────────────────────────────
  if (intent === "record-training") {
    const membershipId = fieldOf(form, "membershipId");
    const programId = fieldOf(form, "programId");
    const completedOn = fieldOf(form, "completedOn");
    const mentor = fieldOf(form, "mentorMembershipId");
    if (
      membershipId === "" ||
      programId === "" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(completedOn) ||
      mentor === membershipId
    ) {
      // **自分を同行者にできない**（自分の研修を自分が見届けたことにしない。
      // 清掃担当者本人が自分のタスクを検査できないのと同じ向き / security.md §1）。
      return { invalid: true };
    }
    await upsertTrainingRecord(env, tenant, {
      membershipId,
      programId,
      completedOn,
      mentorMembershipId: mentor === "" ? null : mentor,
    });
    return { recorded: true };
  }

  // ── 資格・講習を記録する ────────────────────────────────
  if (intent === "record-certification") {
    const membershipId = fieldOf(form, "membershipId");
    const name = fieldOf(form, "name").trim();
    const expiresOn = fieldOf(form, "expiresOn");
    if (
      membershipId === "" ||
      name === "" ||
      name.length > 64 ||
      (expiresOn !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn))
    ) {
      return { invalid: true };
    }
    await createCertification(env, tenant, {
      membershipId,
      name,
      expiresOn: expiresOn === "" ? null : expiresOn,
      note: null,
    });
    return { certified: true };
  }

  return { invalid: true };
}

function StaffSelect({
  id,
  name,
  options,
  required,
}: {
  id: string;
  name: string;
  options: readonly StaffOption[];
  required: boolean;
}) {
  return (
    <select className="pk-select" id={id} name={name} required={required} defaultValue="">
      <option value="">—</option>
      {options.map((option) => (
        <option key={option.membershipId} value={option.membershipId}>
          {option.displayName}
        </option>
      ))}
    </select>
  );
}

export default function Training() {
  const data = useLoaderData<TrainingData>();
  const result = useActionData<TrainingActionResult>();

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("training.title")}</h1>
      </div>

      {result !== undefined && "invalid" in result ? (
        <p className="pk-notice">{t("training.invalid")}</p>
      ) : null}
      {result !== undefined && "recorded" in result ? (
        <p className="pk-notice">{t("training.recorded")}</p>
      ) : null}
      {result !== undefined && "certified" in result ? (
        <p className="pk-notice">{t("training.certified")}</p>
      ) : null}
      {result !== undefined && "seeded" in result ? (
        <p className="pk-notice">{`${t("training.seeded")}: ${String(result.seeded)}`}</p>
      ) : null}

      <ul className="pk-board__counts">
        <li>{`${t("training.kpi.inTraining")} ${String(data.page.summary.inTraining)}`}</li>
        <li>{`${t("training.kpi.completedThisMonth")} ${String(data.page.summary.completedThisMonth)}`}</li>
        <li>{`${t("training.kpi.programs")} ${String(data.page.summary.programs)}`}</li>
        <li>{`${t("training.kpi.needsRenewal")} ${String(data.page.summary.needsRenewal)}`}</li>
      </ul>

      {/* 研修中は同行作業のみ（プロトタイプ 08 / **逐語**）。 */}
      <p className="pk-muted">{t("training.trainee.note")}</p>

      <h2 className="pk-section__title">{t("training.trainee.title")}</h2>
      {data.page.trainees.length === 0 ? (
        <p className="pk-muted">{t("training.trainee.empty")}</p>
      ) : (
        <table className="pk-grid">
          <thead>
            <tr>
              <th>{t("training.trainee.name")}</th>
              <th>{t("training.trainee.progress")}</th>
              <th>{t("training.trainee.mentor")}</th>
              <th>{t("training.trainee.status")}</th>
            </tr>
          </thead>
          <tbody>
            {data.page.trainees.map((row) => (
              <tr key={row.membershipId}>
                <th scope="row">{row.displayName}</th>
                <td>{`${String(row.completed)} / ${String(row.total)}`}</td>
                <td>{row.mentorName ?? "—"}</td>
                <td>{t("training.trainee.accompanied")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="pk-section__title">{t("training.program.title")}</h2>
      {data.programs.length === 0 ? (
        <Form method="post">
          <input type="hidden" name="intent" value="seed-programs" />
          <p className="pk-muted">{t("training.program.empty")}</p>
          <button className="pk-button" type="submit">
            {t("training.program.seed")}
          </button>
        </Form>
      ) : (
        <>
          <table className="pk-grid">
            <thead>
              <tr>
                <th>{t("training.program.name")}</th>
                <th>{t("training.program.minutes")}</th>
                <th>{t("training.program.languages")}</th>
              </tr>
            </thead>
            <tbody>
              {data.programs.map((program) => (
                <tr key={program.id}>
                  <th scope="row">{program.name}</th>
                  <td>{`${String(program.expectedMinutes)}${t("training.program.minutesUnit")}`}</td>
                  <td>{`${String(program.languages.length)}${t("training.program.languagesUnit")}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* 研修資料は 7 言語（プロトタイプ 08 / **逐語**）。 */}
          <p className="pk-muted">{t("training.program.note")}</p>
        </>
      )}

      <h2 className="pk-section__title">{t("training.record.title")}</h2>
      <Form method="post" className="pk-form">
        <input type="hidden" name="intent" value="record-training" />
        <label htmlFor="training-member">{t("training.record.staff")}</label>
        <StaffSelect id="training-member" name="membershipId" options={data.staffOptions} required />
        <label htmlFor="training-program">{t("training.record.program")}</label>
        <select className="pk-select" id="training-program" name="programId" required defaultValue="">
          <option value="">—</option>
          {data.programs.map((program) => (
            <option key={program.id} value={program.id}>
              {program.name}
            </option>
          ))}
        </select>
        <label htmlFor="training-date">{t("training.record.completedOn")}</label>
        <input className="pk-input" id="training-date" type="date" name="completedOn" required />
        <label htmlFor="training-mentor">{t("training.record.mentor")}</label>
        <StaffSelect
          id="training-mentor"
          name="mentorMembershipId"
          options={data.staffOptions}
          required={false}
        />
        <button className="pk-button pk-button--primary" type="submit">
          {t("training.record.submit")}
        </button>
      </Form>

      <h2 className="pk-section__title">{t("training.cert.title")}</h2>
      {data.page.certifications.length === 0 ? (
        <p className="pk-muted">{t("training.cert.empty")}</p>
      ) : (
        <table className="pk-grid">
          <thead>
            <tr>
              <th>{t("training.cert.name")}</th>
              <th>{t("training.cert.course")}</th>
              <th>{t("training.cert.expiresOn")}</th>
              <th>{t("training.cert.status")}</th>
            </tr>
          </thead>
          <tbody>
            {data.page.certifications.map((row) => (
              <tr key={row.id}>
                <th scope="row">{row.displayName}</th>
                <td>{row.name}</td>
                <td className={row.needsRenewal ? "pk-expiry pk-expiry--near" : "pk-expiry"}>
                  {row.expiresOn ?? "—"}
                </td>
                <td>{row.needsRenewal ? t("training.cert.renew") : t("training.cert.valid")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {/* 期限 60 日前の通知（プロトタイプ 08 の注記）。 */}
      <p className="pk-muted">{t("training.cert.note")}</p>

      <Form method="post" className="pk-form">
        <input type="hidden" name="intent" value="record-certification" />
        <label htmlFor="cert-member">{t("training.cert.staff")}</label>
        <StaffSelect id="cert-member" name="membershipId" options={data.staffOptions} required />
        <label htmlFor="cert-name">{t("training.cert.courseName")}</label>
        <input className="pk-input" id="cert-name" name="name" maxLength={64} required />
        <label htmlFor="cert-expires">{t("training.cert.expiresOnInput")}</label>
        <input className="pk-input" id="cert-expires" type="date" name="expiresOn" />
        <button className="pk-button pk-button--primary" type="submit">
          {t("training.cert.submit")}
        </button>
      </Form>
    </section>
  );
}
