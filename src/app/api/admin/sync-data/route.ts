import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getUserFromCookies } from "@/lib/auth";

const ACUMATICA_BASE = "https://allenbontragercarpentry.acumatica.com";

export async function POST(req: NextRequest) {
  // Auth: allow cron secret header OR admin JWT cookie
  const cronHeader = req.headers.get("x-cron-secret");
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && cronHeader === cronSecret;

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

    if (!loginResp.ok) {
      throw new Error(`Acumatica login failed: ${loginResp.status}`);
    }

    const setCookie = loginResp.headers.get("set-cookie") ?? "";
    const sessionCookie = setCookie.split(";")[0];

    // 2. Paginate through Project endpoint
    const allProjects: Record<string, unknown>[] = [];
    let skip = 0;
    const top = 500;
    while (true) {
      const resp = await fetch(
        `${ACUMATICA_BASE}/entity/Default/23.200.001/Project?$top=${top}&$skip=${skip}`,
        { headers: { Cookie: sessionCookie } }
      );
      if (!resp.ok) break;
      const rows = await resp.json();
      if (!Array.isArray(rows) || rows.length === 0) break;
      allProjects.push(...rows);
      if (rows.length < top) break;
      skip += top;
    }

    // 3. Paginate through ProjectBudget endpoint
    const allBudgets: Record<string, unknown>[] = [];
    skip = 0;
    while (true) {
      const resp = await fetch(
        `${ACUMATICA_BASE}/entity/Default/23.200.001/ProjectBudget?$top=${top}&$skip=${skip}`,
        { headers: { Cookie: sessionCookie } }
      );
      if (!resp.ok) break;
      const rows = await resp.json();
      if (!Array.isArray(rows) || rows.length === 0) break;
      allBudgets.push(...rows);
      if (rows.length < top) break;
      skip += top;
    }

    // 4. Aggregate budgets by project
    const budgetByProject: Record<string, { revenue: number; cost: number }> = {};
    for (const b of allBudgets) {
      const projId = (b.ProjectID as {value?: string})?.value;
      const type = (b.Type as {value?: string})?.value;
      const amount = Number((b.ActualAmount as {value?: number})?.value ?? 0);
      if (!projId) continue;
      if (!budgetByProject[projId]) budgetByProject[projId] = { revenue: 0, cost: 0 };
      if (type === "Revenue") budgetByProject[projId].revenue += amount;
      else if (type === "Cost" || type === "Expense") budgetByProject[projId].cost += amount;
    }

    // 5. Transform to structured job data
    const jobData = allProjects
      .map((p) => {
        const projectId = (p.ProjectID as {value?: string})?.value ?? "";
        if (!projectId) return null;
        const budgets = budgetByProject[projectId] ?? { revenue: 0, cost: 0 };
        const revenue = budgets.revenue || Number((p.Income as {value?: number})?.value ?? 0);
        const cost = budgets.cost || Number((p.Expenses as {value?: number})?.value ?? 0);
        const profit = revenue - cost;
        const marginPercent = revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0;
        const description = (p.Description as {value?: string})?.value ?? "";
        return {
          jobId: projectId,
          jobName: description,
          customer: (p.Customer as {value?: string})?.value ?? "",
          status: (p.Status as {value?: string})?.value ?? "",
          tradeType: inferTradeType(description, projectId),
          revenue,
          cost,
          profit,
          marginPercent,
        };
      })
      .filter(Boolean);

    // 6. Clear old data and insert new
    await supabaseAdmin.from("job_data").delete().neq("id", 0);
    const insertData = jobData.map((row) => ({ data: row }));
    for (let i = 0; i < insertData.length; i += 500) {
      const { error } = await supabaseAdmin
        .from("job_data")
        .insert(insertData.slice(i, i + 500));
      if (error) throw new Error(`Insert failed: ${error.message}`);
    }

    // 7. Log success
    await supabaseAdmin.from("sync_log").insert({
      row_count: jobData.length,
      status: "success",
    });

    // 8. Logout
    await fetch(`${ACUMATICA_BASE}/entity/auth/logout`, {
      method: "POST",
      headers: { Cookie: sessionCookie },
    }).catch(() => {});

    return NextResponse.json({ success: true, rowCount: jobData.length });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    await supabaseAdmin
      .from("sync_log")
      .insert({ status: "error", error: msg })
      .catch(() => {});
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

function inferTradeType(description: string, projectId: string): string {
  const desc = description.toLowerCase();
  const id = projectId.toLowerCase();
  if (desc.includes("roof") || id.includes("roof")) return "Roofing";
  if (desc.includes("sid") || id.includes("sid")) return "Siding";
  if (desc.includes("deck") || id.includes("deck")) return "Decking";
  if (
    desc.includes("window") || desc.includes("door") ||
    id.includes("win") || id.includes("door")
  ) return "Windows & Doors";
  if (desc.includes("gutter") || id.includes("gut")) return "Gutters";
  return "Other";
}
