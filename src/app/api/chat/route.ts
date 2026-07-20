import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";

interface JobData {
  jobId: string;
  description: string;
  tradeType: string;
  branch: string;
  revenue: number;
  cost: number;
  profit: number;
  marginPercent: number;
  budgetedRevenue: number;
  startDate: string;
  endDate: string;
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

function aggregateODataRows(rows: Record<string, unknown>[]): JobData[] {
  const jobMap = new Map<string, JobData>();

  for (const row of rows) {
    const jobId = String(row.JobID || row.ProjectID || "Unknown").trim();
    const description = String(row.Description || "").trim();
    const tradeType = String(row.Task || "Unknown").trim();
    const branch = String(row.Branch || "").trim();
    const actualRevenue = Number(row.ActualRevenue) || 0;
    const actualCost =
      (Number(row.ActualLabor) || 0) +
      (Number(row.ActualSubs) || 0) +
      (Number(row.ActualMaterials) || 0) +
      (Number(row.ActualDisposal) || 0) +
      (Number(row.ActualOther) || 0);
    const budgetedRevenue = Number(row.BudgetedRevenue) || 0;
    const startDate = String(row.StartDate || "").split("T")[0];
    const endDate = String(row.EndDate || "").split("T")[0];

    if (jobMap.has(jobId)) {
      const j = jobMap.get(jobId)!;
      j.revenue += actualRevenue;
      j.cost += actualCost;
      j.profit = j.revenue - j.cost;
      j.marginPercent = j.revenue > 0 ? (j.profit / j.revenue) * 100 : 0;
      j.budgetedRevenue += budgetedRevenue;
      if (description && !j.description) j.description = description;
    } else {
      const profit = actualRevenue - actualCost;
      jobMap.set(jobId, {
        jobId,
        description,
        tradeType,
        branch,
        revenue: actualRevenue,
        cost: actualCost,
        profit,
        marginPercent: actualRevenue > 0 ? (profit / actualRevenue) * 100 : 0,
        budgetedRevenue,
        startDate,
        endDate,
      });
    }
  }

  return Array.from(jobMap.values());
}

function formatJobDataForPrompt(jobs: JobData[]): string {
  const topJobs = [...jobs].sort((a, b) => b.revenue - a.revenue).slice(0, 200);

  const summary = topJobs.map((j) => ({
    jobId: j.jobId,
    description: j.description,
    tradeType: j.tradeType,
    branch: j.branch,
    revenue: Math.round(j.revenue * 100) / 100,
    cost: Math.round(j.cost * 100) / 100,
    profit: Math.round(j.profit * 100) / 100,
    marginPct: Number(j.marginPercent.toFixed(1)),
    budgetedRevenue: Math.round(j.budgetedRevenue * 100) / 100,
    startDate: j.startDate,
    endDate: j.endDate,
  }));

  const byTrade: Record<string, { revenue: number; cost: number; count: number }> = {};
  let totalRevenue = 0;
  let totalCost = 0;

  for (const j of jobs) {
    const t = j.tradeType || "Unknown";
    if (!byTrade[t]) byTrade[t] = { revenue: 0, cost: 0, count: 0 };
    byTrade[t].revenue += j.revenue;
    byTrade[t].cost += j.cost;
    byTrade[t].count++;
    totalRevenue += j.revenue;
    totalCost += j.cost;
  }

  const totalProfit = totalRevenue - totalCost;
  const overallMargin =
    totalRevenue > 0
      ? (((totalRevenue - totalCost) / totalRevenue) * 100).toFixed(1)
      : "0";

  const tradeBreakdown = Object.entries(byTrade)
    .map(([trade, stats]) => ({
      trade,
      jobCount: stats.count,
      totalRevenue: Math.round(stats.revenue),
      totalCost: Math.round(stats.cost),
      totalProfit: Math.round(stats.revenue - stats.cost),
      margin:
        stats.revenue > 0
          ? (((stats.revenue - stats.cost) / stats.revenue) * 100).toFixed(1)
          : "0",
    }))
    .sort((a, b) => b.totalRevenue - a.totalRevenue);

  const sortedByProfit = [...jobs].sort((a, b) => b.profit - a.profit);

  const top5Lines = sortedByProfit.slice(0, 5).map((j, i) => {
    const name = j.description || j.tradeType;
    return "  " + (i + 1) + ". " + j.jobId + " — " + name + ": $" +
      Math.round(j.profit).toLocaleString() + " profit, " +
      j.marginPercent.toFixed(1) + "% margin";
  });

  const bottom5Lines = sortedByProfit
    .filter((j) => j.revenue > 0)
    .slice(-5)
    .reverse()
    .map((j, i) => {
      const name = j.description || j.tradeType;
      return "  " + (i + 1) + ". " + j.jobId + " — " + name + ": $" +
        Math.round(j.profit).toLocaleString() + " profit, " +
        j.marginPercent.toFixed(1) + "% margin";
    });

  const tradeLines = tradeBreakdown.map((t) =>
    "  " + t.trade + ": " + t.jobCount + " jobs, Revenue $" +
    t.totalRevenue.toLocaleString() + ", Profit $" +
    t.totalProfit.toLocaleString() + ", Margin " + t.margin + "%"
  );

  return [
    "JOB COST DATA SUMMARY (" + jobs.length + " unique jobs total, showing top " + topJobs.length + " by revenue):",
    "Total Revenue: $" + Math.round(totalRevenue).toLocaleString(),
    "Total Cost: $" + Math.round(totalCost).toLocaleString(),
    "Total Profit: $" + Math.round(totalProfit).toLocaleString(),
    "Overall Margin: " + overallMargin + "%",
    "",
    "BY TASK TYPE:",
    ...tradeLines,
    "",
    "TOP 5 MOST PROFITABLE JOBS:",
    ...top5Lines,
    "",
    "BOTTOM 5 LEAST PROFITABLE (with revenue > 0):",
    ...bottom5Lines,
    "",
    "INDIVIDUAL JOB DATA — top " + topJobs.length + " by revenue (JSON):",
    JSON.stringify(summary, null, 2),
  ].join("\n");
}

export async function POST(request: NextRequest) {
  const user = await getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { message, history } = await request.json();
    if (!message?.trim())
      return NextResponse.json({ error: "Message is required" }, { status: 400 });

    const { data: rows, error: dbError } = await supabaseAdmin
      .from("odata_tw___job_cost")
      .select("data");

    if (dbError || !rows || rows.length === 0) {
      return NextResponse.json({
        response:
          "Job cost data has not been synced yet. Please ask an admin to sync the OData source in the Admin panel.",
      });
    }

    const odataRows = rows.map((r) => r.data as Record<string, unknown>);
    const jobs = aggregateODataRows(odataRows);
    const jobDataText = formatJobDataForPrompt(jobs);

    const systemPrompt =
      "You are a job cost analyst assistant for Allen Bontrager Carpentry, a residential exterior contractor. " +
      "You have access to job profitability data from Acumatica ERP via OData sync.\n\n" +
      jobDataText +
      "\n\nYour role:\n" +
      "- Answer questions about job margins, profitability by task type, top/bottom performers, cost trends, budget vs actuals, etc.\n" +
      "- Be concise and specific. Use dollar amounts and percentages when relevant.\n" +
      "- Format numbers clearly (e.g., $12,500 not 12500, 28.5% not 0.285).\n" +
      "- When listing multiple items, use bullet points or numbered lists.\n" +
      "- If asked something outside the data scope, say so clearly.\n" +
      "- Data is aggregated by Job ID from Acumatica. Costs include labor, subs, materials, disposal, and other.";

    const messages: Anthropic.MessageParam[] = [
      ...(history || []).map((m: { role: string; content: string }) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
      { role: "user" as const, content: message },
    ];

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });

    const responseText =
      response.content[0].type === "text" ? response.content[0].text : "";
    return NextResponse.json({ response: responseText });
  } catch (err) {
    console.error("Chat API error:", err);
    return NextResponse.json({ error: "Failed to process request" }, { status: 500 });
  }
}
