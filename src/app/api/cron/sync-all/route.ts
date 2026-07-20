import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const reqSecret = req.headers.get("x-cron-secret");

  if (!cronSecret || reqSecret !== cronSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: sources, error } = await supabaseAdmin
    .from("odata_sources")
    .select("id, name");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!sources || sources.length === 0) {
    return NextResponse.json({ message: "No sources to sync", results: [] });
  }

  const baseUrl = process.env.NEXTAUTH_URL || process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000";

  const results: { source: string; status: string; message?: string }[] = [];

  for (const source of sources) {
    try {
      const resp = await fetch(`${baseUrl}/api/admin/odata-sources/${source.id}/sync`, {
        method: "POST",
        headers: { "x-cron-secret": cronSecret },
      });

      const data = await resp.json();
      results.push({
        source: source.name,
        status: resp.ok ? "success" : "error",
        message: data.message || data.error,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ source: source.name, status: "error", message: msg });
    }
  }

  return NextResponse.json({
    message: `Cron sync complete: ${results.length} sources processed`,
    results,
  });
}
