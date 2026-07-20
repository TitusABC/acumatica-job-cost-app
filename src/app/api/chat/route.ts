import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";

interface JobData {
  jobId: string;
  description: string;
  task: string;
  customer?: string;
  status?: string;
  budgetedRevenue: number;
  actualRevenue: number;
  budgetedLabor: number;
  actualLabor: number;
  budgetedMaterials: number;
  actualMaterials: number;
  budgetedSubs: number;
  actualSubs: number;
  budgetedDisposal: number;
  actualDisposal: number;
  budgetedOther: number;
  actualOther: number;
  totalBudgetedCost: number;
  totalActualCost: number;
  profit: number;
  marginPercent: number;
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

function formatJobDataForPrompt(jobs: JobData[], isDemo: boolean): string {
  const demoNote = isDemo ? "NOTE: This is demo/sample data.\n\n" : "";
  
  let totalRevenue = 0, totalCost = 0;
  let totalBudgetedRevenue = 0, totalBudgetedCost = 0;
  for (const j of jobs) {
    totalRevenue += j.actualRevenue;
    totalCost += j.totalActualCost;
    totalBudgetedRevenue += j.budgetedRevenue;
    totalBudgetedCost += j.totalBudgetedCost;
  }
  const totalProfit = totalRevenue - totalCost;
  const overallMargin = totalRevenue > 0 ? (((totalRevenue - totalCost) / totalRevenue) * 100).toFixed(1) : "0";

  // Group by jobId for job-level summary
  const byJob: Record<string, {
    description: string; tasks: string[]; actualRevenue: number; totalActualCost: number;
    actualLabor: number; actualMaterials: number; actualSubs: number; actualDisposal: number; actualOther: number;
    budgetedRevenue: number; totalBudgetedCost: number;
  }> = {};
  for (const j of jobs) {
    if (!byJob[j.jobId]) {
      byJob[j.jobId] = {
        description: j.description, tasks: [], actualRevenue: 0, totalActualCost: 0,
        actualLabor: 0, actualMaterials: 0, actualSubs: 0, actualDisposal: 0, actualOther: 0,
        budgetedRevenue: 0, totalBudgetedCost: 0
      };
    }
    const entry = byJob[j.jobId];
    if (j.task && !entry.tasks.includes(j.task)) entry.tasks.push(j.task);
    entry.actualRevenue += j.actualRevenue;
    entry.totalActualCost += j.totalActualCost;
    entry.actualLabor += j.actualLabor;
    entry.actualMaterials += j.actualMaterials;
    entry.actualSubs += j.actualSubs;
    entry.actualDisposal += j.actualDisposal;
    entry.actualOther += j.actualOther;
    entry.budgetedRevenue += j.budgetedRevenue;
    entry.totalBudgetedCost += j.totalBudgetedCost;
  }

  const jobSummary = Object.entries(byJob)
    .map(([jobId, j]) => {
      const profit = j.actualRevenue - j.totalActualCost;
      const margin = j.actualRevenue > 0 ? ((profit / j.actualRevenue) * 100).toFixed(1) : "0";
      const revenueVariance = j.actualRevenue - j.budgetedRevenue;
      const costVariance = j.totalActualCost - j.totalBudgetedCost;
      return { jobId, description: j.description, tasks: j.tasks.join(", "), actualRevenue: j.actualRevenue, totalActualCost: j.totalActualCost, profit, margin: margin + "%", actualLabor: j.actualLabor, actualMaterials: j.actualMaterials, actualSubs: j.actualSubs, actualDisposal: j.actualDisposal, actualOther: j.actualOther, budgetedRevenue: j.budgetedRevenue, totalBudgetedCost: j.totalBudgetedCost, revenueVariance, costVariance };
    })
    .sort((a, b) => b.actualRevenue - a.actualRevenue);

  return `${demoNote}JOB COST DATA SUMMARY (from Acumatica GI640593):
Total Job+Task Rows: ${jobs.length}
Total Unique Jobs: ${Object.keys(byJob).length}
Total Actual Revenue: $${totalRevenue.toLocaleString()}
Total Actual Cost: $${totalCost.toLocaleString()}
Total Actual Profit: $${totalProfit.toLocaleString()}
Overall Margin: ${overallMargin}%
Total Budgeted Revenue: $${totalBudgetedRevenue.toLocaleString()}
Total Budgeted Cost: $${totalBudgetedCost.toLocaleString()}

DATA STRUCTURE:
Each row represents one Job+Task combination with budget/actual breakdowns by cost category:
- Revenue: contract revenue
- Labor: direct labor costs
- Materials: material costs
- Subs: subcontractor costs
- Disposal: disposal/waste costs
- Other: miscellaneous costs

JOB-LEVEL SUMMARY (JSON):
${JSON.stringify(jobSummary, null, 2)}`;
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

    const systemPrompt = `You are a job cost analyst assistant for Allen Bontrager Carpentry, a residential exterior contractor. You have access to job cost data from Acumatica ERP (GI640593).

${jobDataText}

Your role:
- Answer questions about job margins, profitability, budget vs actual variances, cost category breakdowns, top/bottom performers, etc.
- Be concise and specific. Use dollar amounts and percentages when relevant.
- Format numbers clearly (e.g., $12,500 not 12500, 28.5% not 0.285).
- When listing multiple items, use bullet points or numbered lists.
- Cost categories: Labor, Materials, Subs (subcontractors), Disposal, Other.
- Profit = Actual Revenue - Total Actual Cost (Labor + Materials + Subs + Disposal + Other).
- Budget variance: positive means over budget (bad for costs, good for revenue).`;

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
