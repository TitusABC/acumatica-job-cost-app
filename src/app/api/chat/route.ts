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
- StartDate, EndDate (text — ISO timestamp strings like "2026-07-07T00:00:00", may be empty strings)
- ActualRevenue, BudgetedRevenue (numeric stored as text)
- ActualLabor, BudgetedLabor (numeric stored as text)
- ActualSubs, BudgetedSubs (numeric stored as text)
- ActualMaterials, BudgetedMaterials (numeric stored as text)
- ActualDisposal, BudgetedDisposal (numeric stored as text)
- ActualOther, BudgetedOther (numeric stored as text)

CRITICAL RULES:
1. Always TRIM(data->>'JobID') and filter WHERE TRIM(data->>'JobID') != ''
2. Cast numeric fields: COALESCE((NULLIF(data->>'FieldName',''))::numeric, 0)
3. Each job has multiple task rows — always GROUP BY TRIM(data->>'JobID') when analyzing jobs
4. Total cost = ActualLabor + ActualSubs + ActualMaterials + ActualDisposal + ActualOther
5. Profit = ActualRevenue - Total cost
6. Margin = Profit / ActualRevenue * 100 (when ActualRevenue > 0)
7. DATE FIELDS: Always guard with NULLIF before casting — NEVER cast directly.
   CORRECT: (NULLIF(data->>'EndDate',''))::timestamp
   WRONG: (data->>'EndDate')::timestamp  -- crashes on empty strings
   WRONG: (data->>'EndDate')::integer    -- dates are NOT Excel serial numbers
8. Safe date filter example (jobs ending last month):
   WHERE TRIM(data->>'JobID') != ''
     AND NULLIF(data->>'EndDate','') IS NOT NULL
     AND (NULLIF(data->>'EndDate',''))::timestamp >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
     AND (NULLIF(data->>'EndDate',''))::timestamp < DATE_TRUNC('month', CURRENT_DATE)
9. Limit results to 100 rows max
10. Return ONLY the SQL query, no markdown, no backticks, no explanation
`;

function cleanSql(raw: string): string {
  return raw.trim().replace(/;+\s*$/, "");
}

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

      let userQuestion = "";

      try {
        const { message, history, conversationHistory } = await request.json();
        userQuestion = message || "";
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

        let sql = cleanSql(
          sqlResponse.content[0].type === "text" ? sqlResponse.content[0].text : ""
        );

        // Step 2: Execute SQL — up to 3 attempts with Haiku fixing on failure
        send({ type: "status", message: "Running database query..." });

        let queryResult = null;
        let lastError = "";
        let succeeded = false;

        for (let attempt = 0; attempt < 3; attempt++) {
          // Validate SQL shape
          if (!sql || (!sql.toLowerCase().startsWith("select") && !sql.toLowerCase().startsWith("with"))) {
            lastError = "Generated query is not a valid SELECT statement.";
            if (attempt < 2) {
              send({ type: "status", message: `Refining query (attempt ${attempt + 2} of 3)...` });
              const fixResponse = await anthropic.messages.create({
                model: "claude-haiku-4-5-20251001",
                max_tokens: 1024,
                system: `You are a SQL expert. Fix the given SQL query and return ONLY the corrected SQL, no markdown, no backticks, no explanation.
${DB_SCHEMA}`,
                messages: [{
                  role: "user",
                  content: `The following SQL query failed with this error: ${lastError}\n\nHere was the query:\n${sql || "(empty)"}\n\nPlease fix it and return only the corrected SQL query.`,
                }],
              });
              sql = cleanSql(fixResponse.content[0].type === "text" ? fixResponse.content[0].text : "");
              continue;
            }
            break;
          }

          const { data, error } = await supabaseAdmin.rpc("execute_query", {
            query_text: sql,
          });

          if (!error) {
            queryResult = data;
            succeeded = true;
            break;
          }

          lastError = error.message;

          if (attempt < 2) {
            send({ type: "status", message: `Refining query (attempt ${attempt + 2} of 3)...` });
            const fixResponse = await anthropic.messages.create({
              model: "claude-haiku-4-5-20251001",
              max_tokens: 1024,
              system: `You are a SQL expert. Fix the given SQL query and return ONLY the corrected SQL, no markdown, no backticks, no explanation.
${DB_SCHEMA}`,
              messages: [{
                role: "user",
                content: `The following SQL query failed with this error: ${lastError}\n\nHere was the query:\n${sql}\n\nPlease fix it and return only the corrected SQL query.`,
              }],
            });
            sql = cleanSql(fixResponse.content[0].type === "text" ? fixResponse.content[0].text : "");
          }
        }

        if (!succeeded) {
          await supabaseAdmin.from("chat_error_logs").insert({
            user_question: message,
            generated_sql: sql,
            error_message: lastError,
            error_type: lastError.includes("execute_query") ? "function_not_found" : "query_execution",
          });
          send({ type: "error", message: "Sorry, I wasn't able to answer that question. An error was logged for review." });
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
        const errMsg = err instanceof Error ? err.message : "Unknown error";
        try {
          await supabaseAdmin.from("chat_error_logs").insert({
            user_question: userQuestion,
            generated_sql: null,
            error_message: errMsg,
            error_type: "unexpected",
          });
        } catch { /* ignore logging errors */ }
        send({ type: "error", message: "Sorry, I wasn't able to answer that question. An error was logged for review." });
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
