import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";

const DB_SCHEMA = `DATABASE STRUCTURE:
Table: odata_tw___job_cost
Each ROW = one TASK within a job. Jobs have multiple tasks (e.g. "CONTRACT", "LABOR", "MATERIAL").

Example: Job "22123" might have 3 rows:
  - Task "CONTRACT": ActualRevenue=$50,000, ActualLabor=$0
  - Task "LABOR": ActualRevenue=$0, ActualLabor=$15,000
  - Task "MATERIAL": ActualRevenue=$0, ActualMaterials=$8,000

Fields in the JSONB "data" column:
- JobID: text — job number, always TRIM() it, has trailing spaces
- Description: text — job name (same for all tasks in a job)
- Task: text — task code within the job (e.g. "CONTRACT", "LABOR", "SUBS")
- Branch: text — division code (e.g. "ABC1", "ABC2", "QC1")
- StartDate: text — ISO timestamp like "2026-01-15T00:00:00" (may be empty string)
- EndDate: text — ISO timestamp like "2026-07-01T00:00:00" (may be empty string)
- ActualRevenue, BudgetedRevenue: numeric stored as text
- ActualLabor, BudgetedLabor: numeric stored as text
- ActualSubs, BudgetedSubs: numeric stored as text
- ActualMaterials, BudgetedMaterials: numeric stored as text
- ActualDisposal, BudgetedDisposal: numeric stored as text
- ActualOther, BudgetedOther: numeric stored as text

WHEN TO AGGREGATE BY JOB (SUM across tasks, GROUP BY JobID):
- "What is the profit on job 22123?" → SUM all tasks for that job
- "Which jobs are most profitable?" → SUM per job, then rank
- "Average margin across all jobs?" → SUM per job first, then average the job totals
- Any question about jobs as a whole

WHEN TO KEEP TASK ROWS SEPARATE (no GROUP BY, or GROUP BY Task):
- "Show me the labor cost breakdown for job 22123" → show each task row
- "Which tasks have the highest labor?" → group by Task
- "What does the CONTRACT task look like across jobs?" → filter by Task

CRITICAL SAFE PATTERNS (use these exactly):
-- Numeric cast: COALESCE((NULLIF(data->>'FieldName',''))::numeric, 0)
-- Date cast: (NULLIF(data->>'EndDate',''))::timestamp
-- Date filter (never cast directly, always use NULLIF first):
AND NULLIF(data->>'EndDate','') IS NOT NULL
AND (NULLIF(data->>'EndDate',''))::timestamp >= '2026-06-01'
-- JobID: always TRIM(data->>'JobID') and WHERE TRIM(data->>'JobID') != ''

JOB-LEVEL AGGREGATION PATTERN (use this as your template):
SELECT
  TRIM(data->>'JobID') AS job_id,
  MAX(data->>'Description') AS description,
  MAX(data->>'Branch') AS branch,
  SUM(COALESCE((NULLIF(data->>'ActualRevenue',''))::numeric, 0)) AS actual_revenue,
  SUM(COALESCE((NULLIF(data->>'ActualLabor',''))::numeric, 0) +
      COALESCE((NULLIF(data->>'ActualSubs',''))::numeric, 0) +
      COALESCE((NULLIF(data->>'ActualMaterials',''))::numeric, 0) +
      COALESCE((NULLIF(data->>'ActualDisposal',''))::numeric, 0) +
      COALESCE((NULLIF(data->>'ActualOther',''))::numeric, 0)) AS total_cost,
  SUM(COALESCE((NULLIF(data->>'ActualRevenue',''))::numeric, 0)) -
  SUM(COALESCE((NULLIF(data->>'ActualLabor',''))::numeric, 0) +
      COALESCE((NULLIF(data->>'ActualSubs',''))::numeric, 0) +
      COALESCE((NULLIF(data->>'ActualMaterials',''))::numeric, 0) +
      COALESCE((NULLIF(data->>'ActualDisposal',''))::numeric, 0) +
      COALESCE((NULLIF(data->>'ActualOther',''))::numeric, 0)) AS profit
FROM odata_tw___job_cost
WHERE TRIM(data->>'JobID') != ''
GROUP BY TRIM(data->>'JobID')
ORDER BY profit DESC
LIMIT 100

Return ONLY the SQL query. No markdown, no backticks, no explanation.`;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

function sse(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function POST(request: NextRequest) {
  const user = await getUser(request);
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let message: string;
  let conversationHistory: { role: string; content: string }[] = [];
  try {
    const body = await request.json();
    message = body.message;
    conversationHistory = body.conversationHistory || [];
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!message?.trim()) {
    return new Response(JSON.stringify({ error: "Message is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (data: object) => controller.enqueue(enc.encode(sse(data)));

      try {
        send({ type: "status", message: "Generating query..." });

        // Step 1: Generate SQL with Haiku
        const sqlGen = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          system: `You are a PostgreSQL expert. Generate a SQL query to answer the user's question using the schema below.\n\n${DB_SCHEMA}`,
          messages: [{ role: "user", content: message }],
        });
        const sql =
          sqlGen.content[0].type === "text"
            ? sqlGen.content[0].text.trim()
            : "";

        if (!sql.toUpperCase().startsWith("SELECT")) {
          send({ type: "text", text: "I couldn't generate a valid query for that question. Try rephrasing." });
          send({ type: "done" });
          controller.close();
          return;
        }

        send({ type: "status", message: "Running query..." });

        // Step 2: Execute SQL via Supabase RPC
        const { data: rows, error: dbError } = await supabaseAdmin.rpc(
          "execute_query",
          { query_text: sql }
        );
        if (dbError) {
          console.error("DB error:", dbError, "SQL:", sql);
          send({ type: "text", text: "There was a database error. Please try rephrasing your question." });
          send({ type: "done" });
          controller.close();
          return;
        }

        send({ type: "status", message: "Formatting response..." });

        // Step 3: Format results into natural language with Haiku
        const messages: Anthropic.MessageParam[] = [
          ...conversationHistory.map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          })),
          { role: "user" as const, content: message },
        ];

        const formatResp = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          system: `You are a job cost analyst for Allen Bontrager Carpentry, a residential exterior contractor. Answer the user's question based on the query results below. Be concise and specific. Format numbers clearly ($12,500 not 12500, 28.5% not 0.285). Use bullet points for lists.

SQL Results (JSON):
${JSON.stringify(rows, null, 2)}`,
          messages,
        });

        const responseText =
          formatResp.content[0].type === "text"
            ? formatResp.content[0].text
            : "";

        send({ type: "text", text: responseText });
        send({ type: "done" });
      } catch (err) {
        console.error("Chat API error:", err);
        send({ type: "error", message: "Failed to process request" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
