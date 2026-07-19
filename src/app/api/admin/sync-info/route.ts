import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getUserFromCookies } from "@/lib/auth";

export async function GET() {
  const user = await getUserFromCookies();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabaseAdmin
    .from("sync_log")
    .select("synced_at, row_count, status")
    .order("synced_at", { ascending: false })
    .limit(1)
    .single();

  if (error || !data) {
    return NextResponse.json({ syncInfo: null });
  }

  return NextResponse.json({ syncInfo: data });
}
