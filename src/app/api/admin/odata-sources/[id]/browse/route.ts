import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getUser } from "@/lib/auth";

async function logoutAcumatica(authBaseUrl: string, sessionCookie: string) {
  try {
    await fetch(`${authBaseUrl}/entity/auth/logout`, {
      method: "POST",
      headers: { Cookie: sessionCookie },
    });
  } catch {
    // ignore logout errors
  }
}

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

  let sessionCookie = "";
  const debugInfo: Record<string, unknown> = {};

  // Authenticate if auth_base_url is provided
  if (source.auth_base_url) {
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

      debugInfo.loginStatus = loginResp.status;

      if (!loginResp.ok) {
        const errText = await loginResp.text();
        return NextResponse.json(
          { error: `Auth failed: ${loginResp.status} ${errText.substring(0, 200)}` },
          { status: 502 }
        );
      }

      // Collect all Set-Cookie headers
      const rawCookies: string[] =
        typeof (loginResp.headers as any).getSetCookie === "function"
          ? (loginResp.headers as any).getSetCookie()
          : (loginResp.headers.get("set-cookie") || "").split(/,(?=[^ ])/);

      debugInfo.rawCookieCount = rawCookies.length;
      debugInfo.rawCookieKeys = rawCookies.map((c: string) => c.split("=")[0].trim());

      sessionCookie = rawCookies
        .map((c: string) => c.split(";")[0].trim())
        .filter(Boolean)
        .join("; ");

      debugInfo.sessionCookieLength = sessionCookie.length;
      debugInfo.sessionCookiePreview = sessionCookie.substring(0, 80);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ error: `Auth error: ${msg}` }, { status: 502 });
    }
  }

  // Fetch OData service document
  try {
    const fetchHeaders: Record<string, string> = {
      Accept: "application/json",
    };
    if (sessionCookie) {
      fetchHeaders["Cookie"] = sessionCookie;
    }

    const odataUrl = source.odata_base_url.replace(/ /g, "%20");
    debugInfo.odataUrl = odataUrl;

    const serviceResp = await fetch(odataUrl, {
      headers: fetchHeaders,
      redirect: "manual",
    });

    debugInfo.odataStatus = serviceResp.status;
    debugInfo.odataLocation = serviceResp.headers.get("location");

    if (!serviceResp.ok && serviceResp.status !== 301 && serviceResp.status !== 302) {
      const errBody = await serviceResp.text().catch(() => "");
      return NextResponse.json(
        { error: `OData service doc failed: ${serviceResp.status}`, debug: debugInfo, body: errBody.substring(0, 300) },
        { status: 502 }
      );
    }

    // If redirect, follow manually with cookie
    let finalResp = serviceResp;
    if (serviceResp.status === 301 || serviceResp.status === 302) {
      const loc = serviceResp.headers.get("location") || "";
      finalResp = await fetch(loc, { headers: fetchHeaders });
      debugInfo.redirectStatus = finalResp.status;
    }

    if (!finalResp.ok) {
      const errBody = await finalResp.text().catch(() => "");
      return NextResponse.json(
        { error: `OData failed after redirect: ${finalResp.status}`, debug: debugInfo, body: errBody.substring(0, 300) },
        { status: 502 }
      );
    }

    const serviceDoc = await finalResp.json();

    const entities: string[] = [];
    if (Array.isArray(serviceDoc.value)) {
      for (const item of serviceDoc.value) {
        if (item.kind === "EntitySet") {
          entities.push(item.name);
        } else if (item.name) {
          entities.push(item.name);
        }
      }
    }

    return NextResponse.json({ entities: entities.sort(), debug: debugInfo });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Fetch error: ${msg}`, debug: debugInfo }, { status: 502 });
  } finally {
    if (sessionCookie && source.auth_base_url) {
      await logoutAcumatica(source.auth_base_url, sessionCookie);
    }
  }
}
