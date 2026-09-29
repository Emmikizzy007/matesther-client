import { NextResponse } from "next/server";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Browser requests that modify ERP data must originate from this app.
 * SameSite cookies help, but checking Origin / Fetch Metadata closes a second
 * cross-site request-forgery path. Non-browser clients without these headers
 * still need a valid authenticated session and their role permissions.
 */
export function rejectCrossSiteMutation(req: Request): NextResponse | null {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return null;
  if (req.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: "Cross-site changes are not allowed." }, { status: 403 });
  }
  const origin = req.headers.get("origin");
  if (!origin) return null;
  try {
    const source = new URL(origin);
    const actualHost = new URL(req.url).host;
    const requestHost = req.headers.get("host");
    if (![actualHost, requestHost].includes(source.host)) {
      return NextResponse.json({ error: "This request did not come from Matesther." }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  return null;
}
