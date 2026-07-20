import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getUserFromCookies } from "@/lib/auth";

async function authenticateSource(source: {
  auth_base_url?: string;
  username?: string;
  password?: string;
  company?: string;
}): Promise<string> {
  if (!source.auth_base_url) return "";

  const loginResp = await fetch(`${source.auth_base_url}/entity/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: source.username,
      password: source.password,
      company: source.company,
    }),
  });

  if (!loginResp.ok) {
    throw new Error(`Auth failed: ${loginResp.status}`);
  }

  const setCookie = loginResp.headers.get("set-cookie") || "";
  return setCookie
    .split(",")
    .map((c) => c.trim().split(";")[0])
    .filter(Boolean)
    .join("; ");
}

async function fetchAllRows(
  baseUrl: string,
  entityName: string,
  sessionCookie: string
): Promise<Record<string, unknown>[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (sessionCookie) headers["Cookie"] = sessionCookie;

  const allRows: Record<string, unknown>[] = [];
  let skip = 0;
  const top = 500;

  while (true) {
    const url = `${baseUrl}/${encodeURIComponent(entityName)}?$top=${top}&$skip=${skip}`;
    const resp = await fetch(url, { headers });

    if (!resp.ok) {
      throw new Error(`Fetch ${entityName} failed: ${resp.status}`);
    }

    const data = await resp.json();
    const rows: Record<string, unknown>[] = Array.isArray(data.value)
      ? data.value
      : Array.isArray(data)
      ? data
      : [];

    allRows.push(...rows);

    if (rows.length < top) break;
    skip += top;
  }

  return allRows;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const cronSecret = process.env.CRON_SECRET;
  const reqSecret = req.headers.get("x-cron-secret");
  const isCron = cronSecret && reqSecret === cronSecret;

  if (!isCron) {
    const user = await getUserFromCookies(req);
    if (!user || user.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const { id } = params;

  const { data: source, error: srcErr } = await supabaseAdmin
    .from("odata_sources")
    .select("*")
    .eq("id", id)
    .single();

  if (srcErr || !source) {
    return NextResponse.json({ error: "Source not found" }, { status: 404 });
  }

  const { data: entities, error: entErr } = await supabaseAdmin
    .from("odata_entities")
    .select("*")
    .eq("source_id", id);

  if (entErr) {
    return NextResponse.json({ error: entErr.message }, { status: 500 });
  }

  if (!entities || entities.length === 0) {
    return NextResponse.json({ message: "No entities selected for this source", synced: [] });
  }

  let sessionCookie = "";
  try {
    sessionCookie = await authenticateSource(source);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Authentication failed: ${msg}` }, { status: 502 });
  }

  const results: { entity: string; rows: number; error?: string }[] = [];

  for (const entity of entities) {
    const tableName = `odata_${entity.table_name}`;

    try {
      // Create table if not exists via run_sql function
      const createSQL = `
        CREATE TABLE IF NOT EXISTS ${tableName} (
          id SERIAL PRIMARY KEY,
          data JSONB NOT NULL,
          synced_at TIMESTAMPTZ DEFAULT NOW()
        )
      `;

      await supabaseAdmin.rpc("run_sql", { query: createSQL });

      // Fetch all rows
      const rows = await fetchAllRows(
        source.odata_base_url,
        entity.entity_name,
        sessionCookie
      );

      // Clear existing rows
      await supabaseAdmin.rpc("run_sql", {
        query: `DELETE FROM ${tableName}`,
      });

      // Insert new rows in batches of 100
      const batchSize = 100;
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        const insertSQL = `
          INSERT INTO ${tableName} (data, synced_at)
          VALUES ${batch
            .map((_, j) => `(${j + 1 + 1}::jsonb, NOW())`)
            .join(",")}
        `;
        // Use supabase insert for batch
        await supabaseAdmin.from(tableName).insert(
          batch.map((row) => ({ data: row, synced_at: new Date().toISOString() }))
        );
      }

      // Update entity metadata
      await supabaseAdmin
        .from("odata_entities")
        .update({
          last_synced_at: new Date().toISOString(),
          last_row_count: rows.length,
          last_error: null,
        })
        .eq("id", entity.id);

      results.push({ entity: entity.entity_name, rows: rows.length });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);

      await supabaseAdmin
        .from("odata_entities")
        .update({ last_error: msg })
        .eq("id", entity.id);

      results.push({ entity: entity.entity_name, rows: 0, error: msg });
    }
  }

  const total = results.reduce((s, r) => s + r.rows, 0);
  const message = `Synced ${results.length} entities, ${total} total rows`;

  return NextResponse.json({ message, synced: results });
}
