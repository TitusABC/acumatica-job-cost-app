import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getUserFromCookies } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const user = await getUserFromCookies(req);
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: sources, error: srcErr } = await supabaseAdmin
    .from("odata_sources")
    .select("*")
    .order("created_at", { ascending: true });

  if (srcErr) {
    return NextResponse.json({ error: srcErr.message }, { status: 500 });
  }

  const { data: entities, error: entErr } = await supabaseAdmin
    .from("odata_entities")
    .select("*")
    .order("entity_name", { ascending: true });

  if (entErr) {
    return NextResponse.json({ error: entErr.message }, { status: 500 });
  }

  const sourcesWithEntities = (sources || []).map(s => ({
    ...s,
    entities: (entities || []).filter(e => e.source_id === s.id),
  }));

  return NextResponse.json({ sources: sourcesWithEntities });
}

export async function POST(req: NextRequest) {
  const user = await getUserFromCookies(req);
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { name, odata_base_url, auth_base_url, username, password, company } = body;

  if (!name || !odata_base_url) {
    return NextResponse.json({ error: "name and odata_base_url are required" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("odata_sources")
    .insert({ name, odata_base_url, auth_base_url, username, password, company })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ source: data });
}
