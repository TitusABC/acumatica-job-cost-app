import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getUserFromCookies } from "@/lib/auth";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getUserFromCookies(req);
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

      // Extract session cookie from response headers
      const setCookie = loginResp.headers.get("set-cookie") || "";
      sessionCookie = setCookie
        .split(",")
        .map((c) => c.trim().split(";")[0])
        .filter(Boolean)
        .join("; ");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ error: `Auth error: ${msg}` }, { status: 502 });
    }
  }

  // Fetch OData service document
  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (sessionCookie) {
      headers["Cookie"] = sessionCookie;
    }

    const serviceResp = await fetch(`${source.odata_base_url}/`, { headers });

    if (!serviceResp.ok) {
      return NextResponse.json(
        { error: `OData service doc failed: ${serviceResp.status}` },
        { status: 502 }
      );
    }

    const serviceDoc = await serviceResp.json();

    // Parse entity names from OData service document
    // Standard OData: { value: [{ name, url, kind }] }
    const entities: string[] = [];
    if (Array.isArray(serviceDoc.value)) {
      for (const item of serviceDoc.value) {
        if (item.name && item.kind === "EntitySet") {
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
  }
}
