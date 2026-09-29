import { NextResponse } from "next/server";
import { revokeSession } from "@/lib/session";
import { rejectCrossSiteMutation } from "@/lib/request-security";

export async function POST(req: Request) {
  const crossSite = rejectCrossSiteMutation(req);
  if (crossSite) return crossSite;
  const response = NextResponse.json({ ok: true });
  try {
    return await revokeSession(req, response);
  } catch (error) {
    console.error("Sign-out failed", error);
    return NextResponse.json({ error: "Sign-out failed. Please try again." }, { status: 500 });
  }
}
