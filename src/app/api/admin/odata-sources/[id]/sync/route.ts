import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getUser } from "@/lib/auth";

async function fetchAllRows(
  baseUrl: string,
  entityName: string,
  basicAuth: string
): Promise<Record<string, unknown>[]> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Basic ${basicAuth}`,
  };

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

async function syncEntity(
  tableName: string,
  rows: Record<string, unknown>[]
): Promise<void> {
  // Create table if not exists
  await supabaseAdmin.rpc("run_sql", {
    query: `CREATE TABLE IF NOT EXISTS ${tableName} (id SERIAL PRIMARY KEY, data JSONB NOT NULL, synced_at TIMESTAMPTZ DEFAULT NOW())`,
  });

  // Clear existing rows
  await supabaseAdmin.rpc("run_sql", { query: `DELETE FROM ${tableName}` });

  if (rows.length === 0) return;

  // Insert all rows via json_array_elements to avoid param limits
  const jsonArray = JSON.stringify(rows);
  await supabaseAdmin.rpc("run_sql", {
    query: `INSERT INTO ${tableName} (data, synced_at) SELECT value, NOW() FROM json_array_elements('${jsonArray.replace(/'/g, "''")}'::json)`,
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const cronSecret = process.env.CRON_SECRET;
  const reqSecret = req.headers.get("x-cron-secret");
  const isCron = cronSecret && reqSecret === cronSecret;

  if (!isCron) {
    const user = await getUser(req);
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

  if (!source.username || !source.password) {
    return NextResponse.json(
      { error: "Source is missing username or password for Basic Auth" },
      { status: 400 }
    );
  }

  const basicAuth = Buffer.from(`${source.username}:${source.password}`).toString("base64");

  const { data: entities, error: entErr } = await supabaseAdmin
    .from("odata_entities")
    .select("*")
    .eq("source_id", id);

  if (entErr) {
    return NextResponse.json({ error: entErr.message }, { status: 500 });
  }

  if (!entities || entities.length === 0) {
    return NextResponse.json({ message: "No entities selected", synced: [] });
  }

  const results: { entity: string; rows: number; error?: string }[] = [];

  for (const entity of entities) {
    const tableName = `odata_${entity.table_name}`;
    try {
      const rows = await fetchAllRows(source.odata_base_url, entity.entity_name, basicAuth);
      await syncEntity(tableName, rows);

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
  return NextResponse.json({
    message: `Synced ${results.length} entities, ${total} total rows`,
    synced: results,
  });
}
