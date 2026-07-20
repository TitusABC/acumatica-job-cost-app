import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getUser } from "@/lib/auth";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string; entityId: string } }
) {
  const user = await getUser(req);
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { entityId } = params;

  const { data: entity, error } = await supabaseAdmin
    .from("odata_entities")
    .select("id, transform_config, table_name, entity_name, display_name")
    .eq("id", entityId)
    .single();

  if (error || !entity) {
    return NextResponse.json({ error: error?.message || "Not found" }, { status: 404 });
  }

  let columns: string[] = [];
  try {
    const { data: sampleRows } = await supabaseAdmin
      .from(entity.table_name)
      .select("data")
      .limit(1);
    if (sampleRows?.[0]?.data && typeof sampleRows[0].data === "object") {
      columns = Object.keys(sampleRows[0].data as Record<string, unknown>);
    }
  } catch {
    // ignore - columns stay empty
  }

  return NextResponse.json({ entity, columns });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; entityId: string } }
) {
  const user = await getUser(req);
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { entityId } = params;
  const body = await req.json();
  const { transform_config } = body;

  if (!transform_config) {
    return NextResponse.json({ error: "transform_config is required" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("odata_entities")
    .update({ transform_config })
    .eq("id", entityId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ entity: data });
}
