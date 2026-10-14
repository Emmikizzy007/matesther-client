import { db } from "@/db";
import { workers, workerRoles } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { PayrollError, safeId, shortText } from "@/lib/payroll-deductions";
import { staffCategories } from "@/lib/format";
import { effectiveRoles } from "@/lib/worker-roles";

/** Resolve a selection ON THE SERVER. Every affected worker is checked again
 * inside the write transaction; no frontend-sent eligibility/consent is trusted. */
export async function chooseWorkers(organizationId: number, selection: any) {
  const type = selection?.type ?? "IDS";
  if (!["IDS", "ALL", "DEPARTMENT", "EMPLOYMENT_CATEGORY"].includes(type))
    throw new PayrollError("Choose individual workers, all active workers, a department, or an employment category.");
  let ids: number[] | undefined;
  if (type === "IDS") {
    if (!Array.isArray(selection?.workerIds) || !selection.workerIds.length || selection.workerIds.length > 200)
      throw new PayrollError("Select between 1 and 200 distinct workers per request.");
    const chosenIds: number[] = selection.workerIds.map((id: unknown) => safeId(id, "worker"));
    if (new Set(chosenIds).size !== chosenIds.length) throw new PayrollError("The same worker was selected twice.");
    ids = chosenIds;
  }
  const department = type === "DEPARTMENT" ? shortText(selection.department, "Department", 1, 120) : null;
  const people = await db.select({ id: workers.id, name: workers.name, specialty: workers.specialty, department: workers.department })
    .from(workers).where(and(
      eq(workers.organizationId, organizationId), eq(workers.status, "ACTIVE"),
      ids === undefined ? undefined : inArray(workers.id, ids),
      department === null ? undefined : eq(workers.department, department),
    )).orderBy(workers.id).limit(type === "EMPLOYMENT_CATEGORY" ? 1001 : 201);
  if (type !== "EMPLOYMENT_CATEGORY" && people.length > 200)
    throw new PayrollError("More than 200 workers match. Narrow the group or run smaller batches.");
  if (people.length > 1000) throw new PayrollError("Narrow the group before selecting an employment category.");
  if (ids && people.length !== ids.length) throw new PayrollError("Some selected workers are inactive or outside your organisation.", 404);
  let selected = people;
  if (type === "EMPLOYMENT_CATEGORY") {
    const category = shortText(selection.category, "Employment category", 1, 100);
    if (!["Production Worker", "Support Worker", "Salaried / Non-Production Staff"].includes(category))
      throw new PayrollError("Choose a supported employment category.");
    const stored = people.length ? await db.select({ workerId: workerRoles.workerId, role: workerRoles.role, isPrimary: workerRoles.isPrimary })
      .from(workerRoles).where(inArray(workerRoles.workerId, people.map((w) => w.id))) : [];
    selected = people.filter((p) => staffCategories(effectiveRoles(p.specialty, stored.filter((r) => r.workerId === p.id))).includes(category));
  }
  if (!selected.length) throw new PayrollError("No eligible active worker matches this selection.");
  if (selected.length > 200) throw new PayrollError("More than 200 workers match. Narrow the group or run smaller batches.");
  return selected;
}
