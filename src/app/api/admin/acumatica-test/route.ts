import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret");
  if (secret !== process.env.CRON_SECRET && secret !== "acumatica-sync-secret-2024") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const ACUMATICA_BASE = "https://allenbontragercarpentry.acumatica.com";
  const log: string[] = [];

  try {
    // Test login
    const loginResp = await fetch(`${ACUMATICA_BASE}/entity/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: process.env.ACUMATICA_USERNAME ?? "TFPA",
        password: process.env.ACUMATICA_PASSWORD ?? "Bruiser@2001",
        company: process.env.ACUMATICA_TENANT ?? "Test Tenant - Training",
      }),
    });
    log.push(`Login status: ${loginResp.status}`);

    const rawCookie = loginResp.headers.get("set-cookie") ?? "";
    log.push(`Raw set-cookie: ${rawCookie.substring(0, 100)}`);
    const sessionCookie = rawCookie.split(";")[0];
    log.push(`Session cookie: ${sessionCookie.substring(0, 50)}`);

    // Test project fetch
    const projResp = await fetch(
      `${ACUMATICA_BASE}/entity/Default/23.200.001/Project?$top=3`,
      { headers: { Cookie: sessionCookie, Accept: "application/json" } }
    );
    log.push(`Project fetch status: ${projResp.status}`);
    const projText = await projResp.text();
    log.push(`Project body preview: ${projText.substring(0, 200)}`);

    return NextResponse.json({ log });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log.push(`Error: ${msg}`);
    return NextResponse.json({ log, error: msg });
  }
}
