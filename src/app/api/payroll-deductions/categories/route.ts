import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { payrollDeductionCategories } from "@/db/schema";
import { guard, getSessionUser, OWNER } from "@/lib/authz";
import { auditPayroll, BUILTIN_DEDUCTIONS, PayrollError, requiredOrganization, safeId, shortText } from "@/lib/payroll-deductions";
import { payrollFailure, PRIVATE_RESPONSE } from "@/lib/payroll-deduction-http";

function nameOf(value: unknown) {
  const name = shortText(value, "Custom category name", 3, 100);
  const slug = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
  if (slug.length < 3 || /\b(tax|paye|cooperative|damage|absence|unpaid leave)\b/i.test(name) ||
    BUILTIN_DEDUCTIONS.some((builtin) => builtin.name.toLowerCase() === name.toLowerCase() || builtin.code.toLowerCase() === slug.replaceAll("-", "_")))
    throw new PayrollError("Choose a distinct company category name. Statutory tax, savings, damaged garments and attendance must use their protected built-in workflows.");
  return { name, slug };
}

export async function GET(req: Request) {
  const denied = await guard(req, OWNER); if (denied) return denied;
  try {
    const actor = (await getSessionUser(req))!;
    const organizationId = requiredOrganization(actor);
    const custom = await db.select().from(payrollDeductionCategories)
      .where(eq(payrollDeductionCategories.organizationId, organizationId))
      .orderBy(desc(payrollDeductionCategories.active), payrollDeductionCategories.name).limit(250);
    return NextResponse.json({ builtins: BUILTIN_DEDUCTIONS, custom }, { headers: PRIVATE_RESPONSE });
  } catch (error) { return payrollFailure(error); }
}

export async function POST(req: Request) {
  const denied = await guard(req, OWNER); if (denied) return denied;
  try {
    const actor = (await getSessionUser(req))!;
    const organizationId = requiredOrganization(actor);
    const body = await req.json();
    const { name, slug } = nameOf(body.name);
    const row = await db.transaction(async (tx) => {
      const [created] = await tx.insert(payrollDeductionCategories).values({
        organizationId, name, slug, active: true, createdById: actor.id, createdByName: actor.name,
      }).returning();
      await auditPayroll(tx, actor, "CATEGORY", created.id, "CREATE", `Created custom category ${name}.`, undefined, created);
      return created;
    });
    return NextResponse.json(row, { status: 201, headers: PRIVATE_RESPONSE });
  } catch (error) { return payrollFailure(error); }
}

/** Names can be renamed, but proposal/posted category names are snapshotted;
 * retiring a category hides it from NEW proposals, never silently stops an
 * approved agreement. Cancel those agreements individually if necessary. */
export async function PUT(req: Request) {
  const denied = await guard(req, OWNER); if (denied) return denied;
  try {
    const actor = (await getSessionUser(req))!;
    const organizationId = requiredOrganization(actor);
    const body = await req.json();
    const id = safeId(body.id, "custom category");
    const reason = shortText(body.reason, "Change reason", 8, 500);
    if (body.name === undefined && typeof body.active !== "boolean")
      throw new PayrollError("Provide a new name or active status.");
    const label = body.name === undefined ? null : nameOf(body.name);
    const row = await db.transaction(async (tx) => {
      const [before] = await tx.select().from(payrollDeductionCategories).where(and(
        eq(payrollDeductionCategories.id, id), eq(payrollDeductionCategories.organizationId, organizationId),
      )).for("update").limit(1);
      if (!before) throw new PayrollError("Category not found.", 404);
      const [updated] = await tx.update(payrollDeductionCategories).set({
        ...(label ?? {}), ...(typeof body.active === "boolean" ? { active: body.active } : {}), updatedAt: new Date(),
      }).where(eq(payrollDeductionCategories.id, id)).returning();
      await auditPayroll(tx, actor, "CATEGORY", id, "UPDATE", reason, before, updated);
      return updated;
    });
    return NextResponse.json(row, { headers: PRIVATE_RESPONSE });
  } catch (error) { return payrollFailure(error); }
}
