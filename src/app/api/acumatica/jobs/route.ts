import { NextResponse } from "next/server";
import { getUserFromCookies } from "@/lib/auth";
import { getJobsWithCache } from "@/lib/acumatica";

export async function GET() {
  const user = await getUserFromCookies();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { data, isDemo } = await getJobsWithCache();
    return NextResponse.json({ jobs: data, isDemo, count: data.length });
  } catch (err) {
    console.error("Jobs API error:", err);
    return NextResponse.json({ error: "Failed to fetch job data" }, { status: 500 });
  }
}