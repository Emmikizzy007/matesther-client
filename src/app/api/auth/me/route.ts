import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";

/** GET /api/auth/me - current session user (used to restore sessions on reload) */
export async function GET(req: Request) {
  const u = await getSessionUser(req);
  if (!u) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  return NextResponse.json({ name: u.name, email: u.email, role: u.role });
}
