import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getUserFromCookies } from "@/lib/auth";

const ACUMATICA_BASE = "https://allenbontragercarpentry.acumatica.com";

async function runSync(req: NextRequest): Promise<NextResponse> {
  // Auth: allow Vercel cron (Authorization: Bearer <CRON_SECRET>)
  // OR admin x-cron-secret header, OR admin JWT cookie
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

    const sessionCookie = (loginResp.headers.get("set-cookie") ?? "").split(";")[0];

    // 2. Paginate through Project endpoint
    const allProjects: Record<string, unknown>[] = [];
    let skip = 0;
    const top = 500;
    while (true) {
      const r = await fetch(
        `${ACUMATICA_BASE}/entity/Default/23.200.001/Project?$top=${top}&$skip=${skip}`,
        { headers: { Cookie: sessionCookie } }
      );
      if (!r.ok) break;
      const rows = await r.json();
      if (!Array.isArray(rows) || rows.length === 0) break;
      allProjects.push(...rows);
      if (rows.length < top) break;
      skip += top;
    }

    // 3. Paginate through ProjectBudget endpoint
    const allBudgets: Record<string, unknown>[] = [];
    skip = 0;
    while (true) {
      const r = await fetch(
        `${ACUMATICA_BASE}/entity/Default/23.200.001/ProjectBudget?$top=${top}&$skip=${skip}`,
        { headers: { Cookie: sessionCookie } }
      );
      if (!r.ok) break;
      const rows = await r.json();
      if (!Array.isArray(rows) || rows.length === 0) break;
      allBudgets.push(...rows);
      if (rows.length < top) break;
      skip += top;
    }

    // 4. Aggregate budgets by project
    const budgetByProject: Record<string, { revenue: number; cost: number }> = {};
    for (const b of allBudgets) {
      const projId = (b.ProjectID as { value?: string })?.value;
      const type = (b.Type as { value?: string })?.value;
      const amount = Number((b.ActualAmount as { value?: number })?.value ?? 0);
      if (!projId) continue;
      if (!budgetByProject[projId]) budgetByProject[projId] = { revenue: 0, cost: 0 };
      if (type === "Revenue") budgetByProject[projId].revenue += amount;
      else if (type === "Cost" || type === "Expense") budgetByProject[projId].cost += amount;
    }

    // 5. Transform projects to job data
    const jobData = allProjects
      .map((p) => {
        const projectId = (p.ProjectID as { value?: string })?.value ?? "";
        if (!projectId) return null;
        const budgets = budgetByProject[projectId] ?? { revenue: 0, cost: 0 };
        const revenue = budgets.revenue || Number((p.Income as { value?: number })?.value ?? 0);
        const cost = budgets.cost || Number((p.Expenses as { value?: number })?.value ?? 0);
        const profit = revenue - cost;
        const marginPercent = revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0;
        const description = (p.Description as { value?: string })?.value ?? "";
        return {
          jobId: projectId,
          jobName: description,
          customer: (p.Customer as { value?: string })?.value ?? "",
          status: (p.Status as { value?: string })?.value ?? "",
          tradeType: inferTradeType(description, projectId),
          revenue,
          cost,
          profit,
          marginPercent,
        };
      })
      .filter(Boolean);

    // 6. Clear and re-insert
    await supabaseAdmin.from("job_data").delete().neq("id", 0);
    for (let i = 0; i < jobData.length; i += 500) {
      const { error } = await supabaseAdmin
        .from("job_data")
        .insert(jobData.slice(i, i + 500).map((row) => ({ data: row })));
      if (error) throw new Error(`Insert failed: ${error.message}`);
    }

    // 7. Log success and logout
    await supabaseAdmin.from("sync_log").insert({ row_count: jobData.length, status: "success" });
    await fetch(`${ACUMATICA_BASE}/entity/auth/logout`, { method: "POST", headers: { Cookie: sessionCookie } }).catch(() => {});

    return NextResponse.json({ success: true, rowCount: jobData.length });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    try { await supabaseAdmin.from("sync_log").insert({ status: "error", error: msg }); } catch { /* ignore */ }
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

// GET: called by Vercel cron (sends GET with Authorization: Bearer <CRON_SECRET>)
export async function GET(req: NextRequest) {
  return runSync(req);
}

// POST: called by admin UI button
export async function POST(req: NextRequest) {
  return runSync(req);
}

function inferTradeType(description: string, projectId: string): string {
  const d = description.toLowerCase(), id = projectId.toLowerCase();
  if (d.includes("roof") || id.includes("roof")) return "Roofing";
  if (d.includes("sid") || id.includes("sid")) return "Siding";
  if (d.includes("deck") || id.includes("deck")) return "Decking";
  if (d.includes("window") || d.includes("door") || id.includes("win") || id.includes("door")) return "Windows & Doors";
  if (d.includes("gutter") || id.includes("gut")) return "Gutters";
  return "Other";
}
