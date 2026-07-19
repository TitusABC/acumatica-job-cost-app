import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret");
  if (secret !== "acumatica-sync-secret-2024") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const ACUMATICA_BASE = "https://allenbontragercarpentry.acumatica.com";
  const log: string[] = [];
  try {
    const loginResp = await fetch(`${ACUMATICA_BASE}/entity/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "TFPA", password: "Bruiser@2001", company: "Test Tenant - Training" }),
    });
    log.push(`Login status: ${loginResp.status}`);
    const allSetCookies: string[] = (loginResp.headers as any).getSetCookie?.() ??
      (loginResp.headers.get("set-cookie") ? [loginResp.headers.get("set-cookie")!] : []);
    log.push(`Cookie count: ${allSetCookies.length}`);
    allSetCookies.forEach((c, i) => log.push(`Cookie[${i}]: ${c.substring(0, 80)}`));
    const sessionCookie = allSetCookies.map((c) => c.split(";")[0]).join("; ");
    log.push(`Combined cookie: ${sessionCookie.substring(0, 100)}`);
    const projResp = await fetch(
      `${ACUMATICA_BASE}/entity/Default/23.200.001/Project?$top=3`,
      { headers: { Cookie: sessionCookie, Accept: "application/json" } }
    );
    log.push(`Project status: ${projResp.status}`);
    const projText = await projResp.text();
    log.push(`Project body: ${projText.substring(0, 300)}`);
    return NextResponse.json({ log });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log.push(`Error: ${msg}`);
    return NextResponse.json({ log, error: msg });
  }
}
