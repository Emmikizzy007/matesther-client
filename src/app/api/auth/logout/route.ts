import { NextResponse } from "next/server";
import { revokeSession } from "@/lib/session";

export async function POST(req: Request) {
  const response = NextResponse.json({ ok: true });
  try {
    return await revokeSession(req, response);
  } catch (error) {
    console.error("Sign-out failed", error);
    return NextResponse.json({ error: "Sign-out failed. Please try again." }, { status: 500 });
  }
}
