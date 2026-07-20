import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getUserFromCookies } from "@/lib/auth";

const ACUMATICA_BASE = "https://allenbontragercarpentry.acumatica.com";

// Account group name normalization
function normalizeGroup(g: string): string {
  const map: Record<string, string> = {
    disposal: "disposal", d: "disposal",
    labor: "labor", l: "labor",
    material: "materials", materials: "materials", m: "materials",
    sub: "subs", subs: "subs", s: "subs",
    revenue: "revenue", r: "revenue",
    other: "other", o: "other",
  };
  return map[g?.toLowerCase()] ?? "";
}

async function runSync(req: NextRequest): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  const xCronHeader = req.headers.get("x-cron-secret");
  const isCron =
    !!cronSecret &&
    (authHeader === `Bearer ${cronSecret}` || xCronHeader === cronSecret);

  if (!isCron) {
    const user = await getUserFromCookies();
    if (!user || user.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    // 1. Login to Acumatica
    const loginResp = await fetch(`${ACUMATICA_BASE}/entity/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: process.env.ACUMATICA_USERNAME ?? "TFPA",
        password: process.env.ACUMATICA_PASSWORD ?? "Bruiser@2001",
        company: process.env.ACUMATICA_TENANT ?? "Test Tenant - Training",
      }),
    });
    if (!loginResp.ok) throw new Error(`Acumatica login failed: ${loginResp.status}`);

    const allSetCookies: string[] = (loginResp.headers as any).getSetCookie?.() ??
      (loginResp.headers.get("set-cookie") ? [loginResp.headers.get("set-cookie")!] : []);
    const sessionCookie = allSetCookies.map((c) => c.split(";")[0]).join("; ");

    // 2. Paginate through all Projects
    const allProjects: Record<string, unknown>[] = [];
    let skip = 0;
    const top = 500;
    while (true) {
      const r = await fetch(
        `${ACUMATICA_BASE}/entity/Default/23.200.001/Project?$top=${top}&$skip=${skip}&$select=ProjectID,Description,Status,Customer`,
        { headers: { Cookie: sessionCookie } }
      );
      if (!r.ok) break;
      const rows = await r.json();
      if (!Array.isArray(rows) || rows.length === 0) break;
      allProjects.push(...rows);
      if (rows.length < top) break;
      skip += top;
    }

    // Build project lookup map
    const projectMap: Record<string, { description: string; customer: string; status: string }> = {};
    for (const p of allProjects) {
      const id = (p.ProjectID as { value?: string })?.value;
      if (!id) continue;
      projectMap[id] = {
        description: (p.Description as { value?: string })?.value ?? "",
        customer: (p.Customer as { value?: string })?.value ?? "",
        status: (p.Status as { value?: string })?.value ?? "",
      };
    }

    // 3. Paginate through all ProjectBudget rows
    const allBudgets: Record<string, unknown>[] = [];
    skip = 0;
    while (true) {
      const r = await fetch(
        `${ACUMATICA_BASE}/entity/Default/23.200.001/ProjectBudget?$top=${top}&$skip=${skip}&$select=ProjectID,ProjectTaskID,AccountGroup,Type,RevisedBudgetedAmount,ActualAmount`,
        { headers: { Cookie: sessionCookie } }
      );
      if (!r.ok) break;
      const rows = await r.json();
      if (!Array.isArray(rows) || rows.length === 0) break;
      allBudgets.push(...rows);
      if (rows.length < top) break;
      skip += top;
    }

    // 4. Pivot budget rows by (projectId, taskId) -> { revenue, labor, materials, subs, disposal, other }
    type BudgetAccum = {
      budgetedRevenue: number; actualRevenue: number;
      budgetedLabor: number; actualLabor: number;
      budgetedMaterials: number; actualMaterials: number;
      budgetedSubs: number; actualSubs: number;
      budgetedDisposal: number; actualDisposal: number;
      budgetedOther: number; actualOther: number;
    };
    const pivot: Record<string, BudgetAccum> = {};

    for (const b of allBudgets) {
      const projId = (b.ProjectID as { value?: string })?.value;
      const taskId = (b.ProjectTaskID as { value?: string })?.value ?? "";
      const rawGroup = (b.AccountGroup as { value?: string })?.value ?? "";
      const group = normalizeGroup(rawGroup);
      if (!projId || !group) continue;
      const key = `${projId}|||${taskId}`;
      if (!pivot[key]) {
        pivot[key] = {
          budgetedRevenue: 0, actualRevenue: 0,
          budgetedLabor: 0, actualLabor: 0,
          budgetedMaterials: 0, actualMaterials: 0,
          budgetedSubs: 0, actualSubs: 0,
          budgetedDisposal: 0, actualDisposal: 0,
          budgetedOther: 0, actualOther: 0,
        };
      }
      const budgeted = Number((b.RevisedBudgetedAmount as { value?: number })?.value ?? 0);
      const actual = Number((b.ActualAmount as { value?: number })?.value ?? 0);
      if (group === "revenue") {
        pivot[key].budgetedRevenue += budgeted;
        pivot[key].actualRevenue += actual;
      } else if (group === "labor") {
        pivot[key].budgetedLabor += budgeted;
        pivot[key].actualLabor += actual;
      } else if (group === "materials") {
        pivot[key].budgetedMaterials += budgeted;
        pivot[key].actualMaterials += actual;
      } else if (group === "subs") {
        pivot[key].budgetedSubs += budgeted;
        pivot[key].actualSubs += actual;
      } else if (group === "disposal") {
        pivot[key].budgetedDisposal += budgeted;
        pivot[key].actualDisposal += actual;
      } else if (group === "other") {
        pivot[key].budgetedOther += budgeted;
        pivot[key].actualOther += actual;
      }
    }

    // 5. Build final job rows
    const jobData = Object.entries(pivot).map(([key, budgets]) => {
      const [jobId, task] = key.split("|||");
      const proj = projectMap[jobId] ?? { description: "", customer: "", status: "" };
      const totalBudgetedCost = budgets.budgetedLabor + budgets.budgetedMaterials + budgets.budgetedSubs + budgets.budgetedDisposal + budgets.budgetedOther;
      const totalActualCost = budgets.actualLabor + budgets.actualMaterials + budgets.actualSubs + budgets.actualDisposal + budgets.actualOther;
      const profit = budgets.actualRevenue - totalActualCost;
      const marginPercent = budgets.actualRevenue > 0 ? Math.round((profit / budgets.actualRevenue) * 1000) / 10 : 0;
      return {
        jobId,
        description: proj.description,
        task,
        customer: proj.customer,
        status: proj.status,
        budgetedRevenue: budgets.budgetedRevenue,
        actualRevenue: budgets.actualRevenue,
        budgetedLabor: budgets.budgetedLabor,
        actualLabor: budgets.actualLabor,
        budgetedMaterials: budgets.budgetedMaterials,
        actualMaterials: budgets.actualMaterials,
        budgetedSubs: budgets.budgetedSubs,
        actualSubs: budgets.actualSubs,
        budgetedDisposal: budgets.budgetedDisposal,
        actualDisposal: budgets.actualDisposal,
        budgetedOther: budgets.budgetedOther,
        actualOther: budgets.actualOther,
        totalBudgetedCost,
        totalActualCost,
        profit,
        marginPercent,
      };
    });

    // 6. Clear and re-insert
    await supabaseAdmin.from("job_data").delete().neq("id", 0);
    for (let i = 0; i < jobData.length; i += 500) {
      const { error } = await supabaseAdmin
        .from("job_data")
        .insert(jobData.slice(i, i + 500).map((row) => ({ data: row })));
      if (error) throw new Error(`Insert failed: ${error.message}`);
    }

    // 7. Log and logout
    await supabaseAdmin.from("sync_log").insert({ row_count: jobData.length, status: "success" });
    await fetch(`${ACUMATICA_BASE}/entity/auth/logout`, { method: "POST", headers: { Cookie: sessionCookie } }).catch(() => {});

    return NextResponse.json({ success: true, rowCount: jobData.length });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    try { await supabaseAdmin.from("sync_log").insert({ status: "error", error: msg }); } catch { /* ignore */ }
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function GET(req: NextRequest) { return runSync(req); }
export async function POST(req: NextRequest) { return runSync(req); }
