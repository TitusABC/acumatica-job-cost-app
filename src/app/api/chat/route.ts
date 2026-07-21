import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { DB_SCHEMA } from "@/lib/schema";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

export async function POST(request: NextRequest) {
  try {
    const user = await getUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { message } = await request.json();
    if (!message?.trim()) {
      return NextResponse.json({ error: "Message is required" }, { status: 400 });
    }

    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    // Step 1: Generate SQL query
    const sqlSystemPrompt = `You are a SQL expert. Generate a single PostgreSQL query to answer the user's question about job cost data.

Today's date is ${today}.

${DB_SCHEMA}

Rules:
- Return ONLY the SQL query, no explanation, no markdown, no backticks, no code fences
- Always aggregate by job (GROUP BY TRIM(data->>'JobID')) unless the question is specifically about tasks
- Always use TRIM() on JobID
- Cast numeric fields: (NULLIF(data->>'FieldName',''))::numeric
- Limit results to 100 rows max
- For date conversions: DATE '1899-12-30' + (value::integer * INTERVAL '1 day')
- If the question asks for totals/averages across all jobs, return a single summary row
- If the question asks to rank or list jobs, ORDER BY the relevant metric DESC`;

    let sqlQuery: string;
    let queryResult: unknown;
    let lastError: string | null = null;

    // Try up to 3 times (initial + 2 retries on error)
    for (let attempt = 0; attempt < 3; attempt++) {
      const userContent =
        attempt === 0
          ? message
          : `The previous SQL query failed with error: ${lastError}

Please fix the SQL and try again. Return ONLY the corrected SQL query.

Original question: ${message}`;

      const sqlResponse = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: sqlSystemPrompt,
        messages: [{ role: "user", content: userContent }],
      });

      sqlQuery = (sqlResponse.content[0] as { text: string }).text.trim();

      // Strip any accidental markdown fences
      sqlQuery = sqlQuery.replace(/^```sql\n?/i, "").replace(/```$/i, "").trim();

      // Execute via Supabase RPC
      const { data, error } = await supabaseAdmin.rpc("execute_query", {
        query_text: sqlQuery,
      });

      if (error) {
        lastError = error.message;
        continue;
      }

      queryResult = data;
      lastError = null;
      break;
    }

    if (lastError) {
      return NextResponse.json(
        {
          error: "Failed to generate a valid SQL query after 3 attempts",
          details: lastError,
        },
        { status: 500 }
      );
    }

    // Step 3: Interpret results
    const answerResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: `You are a helpful business analyst for a construction company. Answer the user's question based on the database query results provided.
Today's date is ${today}.
Format dollar amounts as currency (e.g. $1,234,567). Format percentages to 1 decimal place.
Be concise and direct. Lead with the key number or answer, then add brief context if useful.`,
      messages: [
        { role: "user", content: message },
        {
          role: "assistant",
          content: `I queried the database and got these results: ${JSON.stringify(queryResult)}`,
        },
        {
          role: "user",
          content: "Based on those results, please answer my question.",
        },
      ],
    });

    const answer = (answerResponse.content[0] as { text: string }).text;

    return NextResponse.json({
      answer,
      sql: sqlQuery!,
      rowCount: Array.isArray(queryResult) ? queryResult.length : null,
    });
  } catch (error) {
    console.error("Chat API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
