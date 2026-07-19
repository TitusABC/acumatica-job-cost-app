import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";

interface JobData {
  jobId: string;
  jobName: string;
  customer?: string;
  tradeType: string;
  status: string;
  revenue: number;
  cost: number;
  profit: number;
  marginPercent: number;
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

function formatJobDataForPrompt(jobs: JobData[], isDemo: boolean): string {
  const demoNote = isDemo ? "NOTE: This is demo/sample data.\n\n" : "";
  const summary = jobs.map((j) => ({ jobId: j.jobId, jobName: j.jobName, tradeType: j.tradeType, status: j.status, revenue: j.revenue, cost: j.cost, profit: j.profit, marginPercent: j.marginPercent }));
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
  return `${demoNote}JOB DATA SUMMARY:\nTotal Jobs: ${jobs.length}\nTotal Revenue: $${totalRevenue.toLocaleString()}\nTotal Cost: $${totalCost.toLocaleString()}\nTotal Profit: $${totalProfit.toLocaleString()}\nOverall Margin: ${overallMargin}%\n\nBY TRADE TYPE:\n${tradeBreakdown.map((t) => `  ${t.trade}: ${t.jobCount} jobs, Revenue $${t.totalRevenue.toLocaleString()}, Profit $${t.totalProfit.toLocaleString()}, Margin ${t.margin}%`).join("\n")}\n\nINDIVIDUAL JOB DATA (JSON):\n${JSON.stringify(summary, null, 2)}`;
}

export async function POST(request: NextRequest) {
  const user = await getUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { message, history } = await request.json();
    if (!message?.trim()) return NextResponse.json({ error: "Message is required" }, { status: 400 });

    const { data: rows, error: dbError } = await supabaseAdmin.from("job_data").select("data");
    if (dbError || !rows || rows.length === 0) {
      return NextResponse.json({ response: "Job data has not been synced yet. Please ask an admin to click \"Refresh Data Now\" in the Admin panel to load data from Acumatica." });
    }

    const jobs = rows.map((r) => r.data as JobData);
    const jobDataText = formatJobDataForPrompt(jobs, false);

    const systemPrompt = `You are a job cost analyst assistant for Allen Bontrager Carpentry, a residential exterior contractor. You have access to job profitability data from Acumatica ERP.

${jobDataText}

Your role:
- Answer questions about job margins, profitability by trade type, top/bottom performers, cost trends, etc.
- Be concise and specific. Use dollar amounts and percentages when relevant.
- Format numbers clearly (e.g., $12,500 not 12500, 28.5% not 0.285).
- When listing multiple items, use bullet points or numbered lists.
- If asked something outside the data scope, say so clearly.
- Trade types include: Roofing, Siding, Decking, Windows & Doors, Gutters.`;

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
