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

  const { id } = params;

  const { data: source, error: srcErr } = await supabaseAdmin
    .from("odata_sources")
    .select("*")
    .eq("id", id)
    .single();

  if (srcErr || !source) {
    return NextResponse.json({ error: "Source not found" }, { status: 404 });
  }

  // Encode spaces in the OData URL and ensure trailing slash for service document
  const rawUrl = source.odata_base_url.replace(/ /g, "%20");
  const odataUrl = rawUrl.endsWith("/") ? rawUrl : rawUrl + "/";

  // Try multiple auth strategies in order
  const strategies: Array<{ name: string; headers: Record<string, string> }> = [];

  // Strategy 1: Basic Auth (most reliable for Acumatica OData)
  if (source.username && source.password) {
    const basicCreds = Buffer.from(`${source.username}:${source.password}`).toString("base64");
    strategies.push({
      name: "basic",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${basicCreds}`,
      },
    });
  }

  // Strategy 2: Cookie-based (login first, then use session cookie)
  if (source.auth_base_url) {
    let sessionCookie = "";
    try {
      const loginResp = await fetch(`${source.auth_base_url}/entity/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: source.username,
          password: source.password,
          company: source.company,
        }),
      });

      if (loginResp.ok) {
        const rawCookies: string[] =
          typeof (loginResp.headers as any).getSetCookie === "function"
            ? (loginResp.headers as any).getSetCookie()
            : (loginResp.headers.get("set-cookie") || "").split(/,(?=[^ ])/);

        sessionCookie = rawCookies
          .map((c: string) => c.split(";")[0].trim())
          .filter(Boolean)
          .join("; ");
      }
    } catch {
      // ignore login errors for this strategy
    }

    if (sessionCookie) {
      strategies.push({
        name: "cookie",
        headers: { Accept: "application/json", Cookie: sessionCookie },
      });

      // Strategy 3: Cookie + Windows auth header
      strategies.push({
        name: "cookie+auth",
        headers: {
          Accept: "application/json",
          Cookie: sessionCookie,
          "X-Requested-With": "XMLHttpRequest",
        },
      });
    }
  }

  const debugResults: Record<string, number> = {};
  let lastSessionCookie = "";

  for (const strategy of strategies) {
    try {
      const serviceResp = await fetch(odataUrl, { headers: strategy.headers });
      debugResults[strategy.name] = serviceResp.status;

      if (serviceResp.ok) {
        // Logout if we used cookie auth
        if (strategy.name.startsWith("cookie") && strategy.headers.Cookie && source.auth_base_url) {
          lastSessionCookie = strategy.headers.Cookie;
          fetch(`${source.auth_base_url}/entity/auth/logout`, {
            method: "POST",
            headers: { Cookie: lastSessionCookie },
          }).catch(() => {});
        }

        const serviceDoc = await serviceResp.json();
        const entities: string[] = [];
        if (Array.isArray(serviceDoc.value)) {
          for (const item of serviceDoc.value) {
            if (item.kind === "EntitySet" || item.name) {
              entities.push(item.name);
            }
          }
        }
        return NextResponse.json({ entities: entities.sort() });
      }
    } catch (e: unknown) {
      debugResults[strategy.name + "_err"] = -1;
    }
  }

  // All strategies failed
  // Attempt logout if we created a session
  if (lastSessionCookie && source.auth_base_url) {
    fetch(`${source.auth_base_url}/entity/auth/logout`, {
      method: "POST",
      headers: { Cookie: lastSessionCookie },
    }).catch(() => {});
  }

  return NextResponse.json(
    { error: "All auth strategies failed", debug: debugResults, odataUrl },
    { status: 502 }
  );
}
