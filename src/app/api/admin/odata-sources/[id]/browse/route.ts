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

      if (!loginResp.ok) {
        const errText = await loginResp.text();
        return NextResponse.json(
          { error: `Auth failed: ${loginResp.status} ${errText.substring(0, 200)}` },
          { status: 502 }
        );
      }

      // Extract ALL session cookies from response headers
      // getSetCookie() returns each Set-Cookie header as a separate entry (Node 19+)
      // Fall back to splitting the combined get() value for older runtimes
      const rawCookies: string[] =
        typeof (loginResp.headers as any).getSetCookie === "function"
          ? (loginResp.headers as any).getSetCookie()
          : (loginResp.headers.get("set-cookie") || "").split(/,(?=[^ ])/);

      sessionCookie = rawCookies
        .map((c: string) => c.split(";")[0].trim())
        .filter(Boolean)
        .join("; ");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ error: `Auth error: ${msg}` }, { status: 502 });
    }
  }

  // Fetch OData service document, always logout when done
  try {
    const fetchHeaders: Record<string, string> = {
      Accept: "application/json",
    };
    if (sessionCookie) {
      fetchHeaders["Cookie"] = sessionCookie;
    }

    // Encode spaces in the OData URL (e.g. "Test Tenant - Training" -> "Test%20Tenant%20-%20Training")
    const odataUrl = source.odata_base_url.replace(/ /g, "%20");
    const serviceResp = await fetch(odataUrl, { headers: fetchHeaders });

    if (!serviceResp.ok) {
      const errBody = await serviceResp.text().catch(() => "");
      return NextResponse.json(
        { error: `OData service doc failed: ${serviceResp.status} ${errBody.substring(0, 200)}` },
        { status: 502 }
      );
    }

    const serviceDoc = await serviceResp.json();

    // Parse entity names from OData service document
    // Standard OData: { value: [{ name, url, kind }] }
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

    return NextResponse.json({ entities: entities.sort() });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Fetch error: ${msg}` }, { status: 502 });
  } finally {
    // Always log out to free the concurrent session slot in Acumatica
    if (sessionCookie && source.auth_base_url) {
      await logoutAcumatica(source.auth_base_url, sessionCookie);
    }
  }
}
