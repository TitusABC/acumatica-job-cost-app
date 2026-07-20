import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getUser } from "@/lib/auth";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getUser(req);
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: source_id } = params;
  const body = await req.json();
  const { entity_name, display_name, selected } = body;

  if (!entity_name) {
    return NextResponse.json({ error: "entity_name is required" }, { status: 400 });
  }

  if (!selected) {
    // Remove entity selection
    const { error } = await supabaseAdmin
      .from("odata_entities")
      .delete()
      .eq("source_id", source_id)
      .eq("entity_name", entity_name);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ success: true, action: "removed" });
  }

  // Upsert entity
  const table_name = entity_name.toLowerCase().replace(/[^a-z0-9]/g, "_");

  const { data, error } = await supabaseAdmin
    .from("odata_entities")
    .upsert(
      {
        source_id,
        entity_name,
        display_name: display_name || entity_name,
        table_name,
      },
      { onConflict: "source_id,entity_name" }
    )
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ entity: data, action: "added" });
}
