import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";

interface JobData {
  jobId: string;
  jobName: string;
  tradeType: string;
  branch: string;
  revenue: number;
  cost: number;
  profit: number;
  marginPercent: number;
  budgetedRevenue: number;
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

function aggregateODataRows(rows: Record<string, unknown>[]): JobData[] {
  const jobMap = new Map<string, JobData>();
  for (const row of rows) {
    const jobId = String(row.JobID || row.ProjectID || "Unknown");
    const tradeType = String(row.Task || "Unknown");
    const branch = String(row.Branch || "");
    const actualRevenue = Number(row.ActualRevenue) || 0;
    const actualCost = (Number(row.ActualSubs) || 0) + (Number(row.ActualMaterials) || 0) + (Number(row.ActualDisposal) || 0) + (Number(row.ActualLabor) || 0);
    const budgetedRevenue = Number(row.BudgetedRevenue) || 0;
    if (jobMap.has(jobId)) {
      const j = jobMap.get(jobId)!;
      j.revenue += actualRevenue;
      j.cost += actualCost;
      j.profit = j.revenue - j.cost;
      j.marginPercent = j.revenue > 0 ? (j.profit / j.revenue) * 100 : 0;
      j.budgetedRevenue += budgetedRevenue;
    } else {
      const profit = actualRevenue - actualCost;
      jobMap.set(jobId, { jobId, jobName: jobId, tradeType, branch, revenue: actualRevenue, cost: actualCost, profit, marginPercent: actualRevenue > 0 ? (profit / actualRevenue) * 100 : 0, budgetedRevenue });
    }
  }
  return Array.from(jobMap.values());
}

function formatJobDataForPrompt(jobs: JobData[]): string {
  const summary = jobs.map(j => ({ jobId: j.jobId, tradeType: j.tradeType, branch: j.branch, revenue: j.revenue, cost: j.cost, profit: j.profit, marginPercent: Number(j.marginPercent.toFixed(1)), budgetedRevenue: j.budgetedRevenue }));
  const byTrade: Record<string, { revenue: number; cost: number; count: number }> = {};
  let totalRevenue = 0, totalCost = 0;
  for (const j of jobs) {
    if (!byTrade[j.tradeType]) byTrade[j.tradeType] = { revenue: 0, cost: 0, count: 0 };
    byTrade[j.tradeType].revenue += j.revenue;
    byTrade[j.tradeType].cost += j.cost;
    byTrade[j.tradeType].count++;
    totalRevenue += j.revenue;
    totalCost += j.cost;
  }
  const totalProfit = totalRevenue - totalCost;
  const overallMargin = totalRevenue > 0 ? (((totalRevenue - totalCost) / totalRevenue) * 100).toFixed(1) : "0";
  const tradeBreakdown = Object.entries(byTrade).map(([trade, stats]) => ({ trade, jobCount: stats.count, totalRevenue: stats.revenue, totalCost: stats.cost, totalProfit: stats.revenue - stats.cost, margin: stats.revenue > 0 ? (((stats.revenue - stats.cost) / stats.revenue) * 100).toFixed(1) : "0" })).sort((a, b) => b.totalRevenue - a.totalRevenue);
  return `JOB COST DATA SUMMARY:\nTotal Jobs: ${jobs.length}\nTotal Revenue: $${totalRevenue.toLocaleString()}\nTotal Cost: $${totalCost.toLocaleString()}\nTotal Profit: $${totalProfit.toLocaleString()}\nOverall Margin: ${overallMargin}%\n\nBY TASK TYPE:\n${tradeBreakdown.map(t => `  ${t.trade}: ${t.jobCount} jobs, Revenue $${t.totalRevenue.toLocaleString()}, Profit $${t.totalProfit.toLocaleString()}, Margin ${t.margin}%`).join("\n")}\n\nINDIVIDUAL JOB DATA (JSON):\n${JSON.stringify(summary, null, 2)}`;
}

export async function POST(request: NextRequest) {
  const user = await getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { message, history } = await request.json();
    if (!message?.trim()) return NextResponse.json({ error: "Message is required" }, { status: 400 });

    const { data: rows, error: dbError } = await supabaseAdmin.from("odata_tw___job_cost").select("data");
    if (dbError || !rows || rows.length === 0) {
      return NextResponse.json({ response: "Job cost data has not been synced yet. Please ask an admin to sync the OData source in the Admin panel." });
    }

    const odataRows = rows.map(r => r.data as Record<string, unknown>);
    const jobs = aggregateODataRows(odataRows);
    const jobDataText = formatJobDataForPrompt(jobs);

    const systemPrompt = `You are a job cost analyst assistant for Allen Bontrager Carpentry, a residential exterior contractor. You have access to job profitability data from Acumatica ERP via OData sync.\n\n${jobDataText}\n\nYour role:\n- Answer questions about job margins, profitability by task type, top/bottom performers, cost trends, budget vs actuals, etc.\n- Be concise and specific. Use dollar amounts and percentages when relevant.\n- Format numbers clearly (e.g., $12,500 not 12500, 28.5% not 0.285).\n- When listing multiple items, use bullet points or numbered lists.\n- If asked something outside the data scope, say so clearly.\n- Data is aggregated by Job ID from Acumatica's TW - Job Cost entity.`;

    const messages: Anthropic.MessageParam[] = [
      ...(history || []).map((m: { role: string; content: string }) => ({ role: m.role as "user" | "assistant", content: m.content })),
      { role: "user" as const, content: message },
    ];

    const response = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 1024, system: systemPrompt, messages });
    const responseText = response.content[0].type === "text" ? response.content[0].text : "";
    return NextResponse.json({ response: responseText });
  } catch (err) {
    console.error("Chat API error:", err);
    return NextResponse.json({ error: "Failed to process request" }, { status: 500 });
  }
}
