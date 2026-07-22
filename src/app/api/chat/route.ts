import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getUser } from "@/lib/auth";
import { createClient } from "@supabase/supabase-js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const DB_SCHEMA = `
Database table: odata_tw___job_cost
Each row has a JSONB column called "data" with these fields:

- JobID (text, always use TRIM() — has trailing spaces)
- Description (text — job name)
- Task (text — task code like "CONTRACT", "LABOR")
- Branch (text — division like "ABC1", "ABC2", "QC1")
- StartDate, EndDate (text — Excel serial date numbers, days since 1899-12-30)
- ActualRevenue, BudgetedRevenue (numeric stored as text)
- ActualLabor, BudgetedLabor (numeric stored as text)
- ActualSubs, BudgetedSubs (numeric stored as text)
- ActualMaterials, BudgetedMaterials (numeric stored as text)
- ActualDisposal, BudgetedDisposal (numeric stored as text)
- ActualOther, BudgetedOther (numeric stored as text)

RULES:
- Always TRIM(data->>'JobID') and filter WHERE TRIM(data->>'JobID') != ''
- Cast numeric fields: COALESCE((NULLIF(data->>'FieldName',''))::numeric, 0)
- Each job has multiple task rows — always GROUP BY TRIM(data->>'JobID') when analyzing jobs
- Total cost = ActualLabor + ActualSubs + ActualMaterials + ActualDisposal + ActualOther
- Profit = ActualRevenue - Total cost
- Margin = Profit / ActualRevenue * 100 (when ActualRevenue > 0)
- Date conversion: DATE '1899-12-30' + (value::integer * INTERVAL '1 day')
- Limit results to 100 rows max
- Return ONLY the SQL query, no markdown, no backticks, no explanation
`;

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const user = await getUser(request);
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: object) => {
        controller.enqueue(encoder.encode("data: " + JSON.stringify(obj) + "\n\n"));
      };

      try {
        const { message, history, conversationHistory } = await request.json();
        const hist = history || conversationHistory || [];
        if (!message?.trim()) {
          send({ type: "error", message: "Message is required" });
          controller.close();
          return;
        }

        const today = new Date().toLocaleDateString("en-US", {
          weekday: "long", year: "numeric", month: "long", day: "numeric"
        });

        // Step 1: Generate SQL with Haiku (fast)
        send({ type: "status", message: "Analyzing your question..." });

        const sqlResponse = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          system: `You are a SQL expert. Generate a PostgreSQL SELECT query to answer the user's question about job cost data.
Today's date is ${today}.
${DB_SCHEMA}`,
          messages: [{ role: "user", content: message }],
        });

        const sql = sqlResponse.content[0].type === "text" ? sqlResponse.content[0].text.trim() : "";

        if (!sql || (!sql.toLowerCase().startsWith("select") && !sql.toLowerCase().startsWith("with"))) {
          send({ type: "error", message: "Could not generate a valid SQL query for that question.", sql });
          controller.close();
          return;
        }

        // Step 2: Execute SQL
        send({ type: "status", message: "Running database query..." });

        const { data: queryResult, error: queryError } = await supabaseAdmin.rpc("execute_query", {
          query_text: sql,
        });

        if (queryError) {
          send({ type: "error", message: `Database query failed: ${queryError.message}`, sql });
          controller.close();
          return;
        }

        // Step 3: Stream the answer with Sonnet
        send({ type: "status", message: "Generating answer..." });

        const resultPreview = JSON.stringify(queryResult).slice(0, 8000);

        const answerStream = anthropic.messages.stream({
          model: "claude-sonnet-4-6",
          max_tokens: 2048,
          system: `You are a helpful business analyst for Allen Bontrager Carpentry. Answer questions about job profitability concisely and clearly.
Today's date is ${today}.
Format currency as $X,XXX. Format percentages as XX.X%. Use bullet points for lists.`,
          messages: [
            ...hist.map((m: { role: string; content: string }) => ({
              role: m.role as "user" | "assistant",
              content: m.content,
            })),
            { role: "user", content: message },
            {
              role: "assistant",
              content: `I queried the database and got these results: ${resultPreview}`,
            },
            {
              role: "user",
              content: "Based on those database results, please answer my original question.",
            },
          ],
        });

        for await (const chunk of answerStream) {
          if (
            chunk.type === "content_block_delta" &&
            chunk.delta.type === "text_delta"
          ) {
            send({ type: "text", text: chunk.delta.text });
          }
        }

        send({ type: "done", sql });
        controller.close();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Unknown error";
        send({ type: "error", message });
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
