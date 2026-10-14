import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { userDashboardCards } from "@/db/schema";
import { guard, getSessionUser, OWNER } from "@/lib/authz";
import { PayrollError, requiredOrganization } from "@/lib/payroll-deductions";
import { payrollFailure, PRIVATE_RESPONSE } from "@/lib/payroll-deduction-http";

/**
 * Which information cards appear on the Worker Payments dashboard.
 *
 * Pure per-user display preference — it grants no permission and hides no
 * financial record (every figure stays available in the tables and reports).
 * Unknown card keys are ignored so an older app cannot poison the setting.
 */
export const DASHBOARD_CARDS = [
  { key: "net-preview", label: "Net Preview / Posted" },
  { key: "all-deductions", label: "All Deductions" },
  { key: "already-paid", label: "Already Paid" },
  { key: "still-owed", label: "Still Owed" },
  { key: "piecework-share", label: "Piecework Share" },
  { key: "support-paid-helpers", label: "Support Paid to Helpers" },
  { key: "deducted-tailors", label: "Deducted from Tailors" },
  { key: "cooperative-savings", label: "Cooperative Savings" },
] as const;

export async function GET(req: Request) {
  const denied = await guard(req, OWNER); if (denied) return denied;
  try {
    const actor = (await getSessionUser(req))!;
    requiredOrganization(actor);
    const rows = await db.select().from(userDashboardCards).where(eq(userDashboardCards.userId, actor.id));
    const saved = new Map(rows.map((row) => [row.cardKey, row.visible]));
    return NextResponse.json({
      cards: DASHBOARD_CARDS.map((card) => ({
        ...card,
        visible: saved.has(card.key) ? saved.get(card.key)! : true,
        saved: saved.has(card.key),
      })),
    }, { headers: PRIVATE_RESPONSE });
  } catch (error) { return payrollFailure(error); }
}

export async function PUT(req: Request) {
  const denied = await guard(req, OWNER); if (denied) return denied;
  try {
    const actor = (await getSessionUser(req))!;
    requiredOrganization(actor);
    const body = await req.json();
    if (!Array.isArray(body?.cards) || body.cards.length > DASHBOARD_CARDS.length)
      throw new PayrollError("Send the dashboard card visibility list.");
    const known = new Set<string>(DASHBOARD_CARDS.map((card) => card.key));
    const updates = body.cards.map((entry: any) => {
      const key = String(entry?.key ?? "");
      if (!known.has(key)) throw new PayrollError(`Unknown dashboard card "${key}".`);
      return { key, visible: entry?.visible !== false };
    });
    await db.transaction(async (tx) => {
      for (const update of updates) {
        const existing = await tx.select({ id: userDashboardCards.id }).from(userDashboardCards)
          .where(and(eq(userDashboardCards.userId, actor.id), eq(userDashboardCards.cardKey, update.key))).limit(1);
        if (existing.length)
          await tx.update(userDashboardCards).set({ visible: update.visible, updatedAt: new Date() })
            .where(eq(userDashboardCards.id, existing[0].id));
        else
          await tx.insert(userDashboardCards).values({ userId: actor.id, cardKey: update.key, visible: update.visible });
      }
    });
    const rows = await db.select().from(userDashboardCards)
      .where(and(eq(userDashboardCards.userId, actor.id), inArray(userDashboardCards.cardKey, updates.map((u: { key: string }) => u.key))));
    const saved = new Map(rows.map((row) => [row.cardKey, row.visible]));
    return NextResponse.json({
      cards: DASHBOARD_CARDS.map((card) => ({
        ...card,
        visible: saved.has(card.key) ? saved.get(card.key)! : true,
        saved: saved.has(card.key),
      })),
    }, { headers: PRIVATE_RESPONSE });
  } catch (error) { return payrollFailure(error); }
}
