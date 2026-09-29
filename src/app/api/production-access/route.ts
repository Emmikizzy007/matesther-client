import { NextResponse } from "next/server";
import { guard, getSessionUser, productionAccess, STAFF } from "@/lib/authz";

export const dynamic = "force-dynamic";

/** UI capability hints only. Authorization is enforced again on every write. */
export async function GET(req: Request) {
  const denied = await guard(req, STAFF);
  if (denied) return denied;
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  try {
    const access = await productionAccess(user);
    return NextResponse.json({
      ...access,
      canInspectOwnWork: false,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("Production access lookup failed", error);
    return NextResponse.json({ error: "Could not verify your production access." }, { status: 503 });
  }
}
