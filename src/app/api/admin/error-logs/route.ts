import { NextRequest } from "next/server";
import { getUser } from "@/lib/auth";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(request: NextRequest) {
  const user = await getUser(request);
  if (!user || user.role !== "admin") {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabaseAdmin
    .from("chat_error_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ logs: data });
}

export async function DELETE(request: NextRequest) {
  const user = await getUser(request);
  if (!user || user.role !== "admin") {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Delete all rows — use a condition that matches everything
  const { error } = await supabaseAdmin
    .from("chat_error_logs")
    .delete()
    .gte("created_at", "1970-01-01");

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ success: true });
}
