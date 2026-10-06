import { eq } from "drizzle-orm";
import { db } from "@/db";
import { workerRoles, workers } from "@/db/schema";
import { WORKER_ROLES, hasRole, sameRole } from "@/lib/format";

/**
 * One person, many roles.
 *
 * A person's effective roles are the rows in worker_roles PLUS their legacy
 * workers.specialty. Treating specialty as an always-present role is what lets
 * every worker recorded before multi-role existed keep working with no data
 * backfill and no change to their assignments.
 */

/** Accepts the db handle or a transaction handle. */
type Db = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Trim, title-match against the allowed list, and drop duplicates. */
export function normaliseRoles(input: unknown, fallback?: string): string[] {
  const values = Array.isArray(input) ? input : typeof input === "string" ? [input] : [];
  const cleaned: string[] = [];
  for (const raw of values) {
    const value = String(raw ?? "").trim();
    if (!value) continue;
    const known = WORKER_ROLES.find((role) => sameRole(role, value));
    const role = known ?? value;
    if (!cleaned.some((existing) => sameRole(existing, role))) cleaned.push(role);
  }
  if (!cleaned.length && fallback && fallback.trim()) cleaned.push(fallback.trim());
  return cleaned;
}

/** True when every requested role is one Matesther recognises. */
export function unknownRoles(roles: string[]): string[] {
  return roles.filter((role) => !WORKER_ROLES.some((known) => sameRole(known, role)));
}

/** Merge stored role rows with the legacy specialty, primary role first. */
export function effectiveRoles(
  specialty: string | null | undefined,
  stored: { role: string; isPrimary: boolean }[]
): string[] {
  const ordered = [...stored].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  const roles = normaliseRoles(ordered.map((row) => row.role), specialty ?? undefined);
  // The legacy specialty always counts, so single-role workers never lose it.
  if (specialty && !roles.some((role) => sameRole(role, specialty))) roles.push(specialty.trim());
  return roles;
}

/**
 * A caller-supplied per-request memo. One PUT /api/operations can ask whether the
 * same person holds two different roles, which used to resolve their role list
 * twice (4 queries). Pass one Map through a handler to resolve it once.
 * Deliberately NOT module-level: roles can change, so a cache must never outlive
 * the request that created it.
 */
export type RoleCache = Map<number, Promise<string[]>>;

/** Effective roles for one person. */
export async function rolesForWorker(workerId: number, cache?: RoleCache): Promise<string[]> {
  const cached = cache?.get(workerId);
  if (cached) return cached;
  const pending = loadRolesForWorker(workerId);
  cache?.set(workerId, pending);
  return pending;
}

async function loadRolesForWorker(workerId: number): Promise<string[]> {
  const [rows, stored] = await Promise.all([
    db.select({ specialty: workers.specialty }).from(workers).where(eq(workers.id, workerId)).limit(1),
    db
      .select({ role: workerRoles.role, isPrimary: workerRoles.isPrimary })
      .from(workerRoles)
      .where(eq(workerRoles.workerId, workerId)),
  ]);
  const person = rows[0];
  if (!person) return [];
  return effectiveRoles(person.specialty, stored);
}

/** Effective roles for many people in one query, for list endpoints. */
export async function rolesByWorker(): Promise<Map<number, string[]>> {
  const [people, stored] = await Promise.all([
    db.select({ id: workers.id, specialty: workers.specialty }).from(workers),
    db
      .select({ workerId: workerRoles.workerId, role: workerRoles.role, isPrimary: workerRoles.isPrimary })
      .from(workerRoles),
  ]);
  const byWorker = new Map<number, { role: string; isPrimary: boolean }[]>();
  for (const row of stored) {
    const list = byWorker.get(row.workerId) ?? [];
    list.push({ role: row.role, isPrimary: row.isPrimary });
    byWorker.set(row.workerId, list);
  }
  return new Map(
    people.map((person) => [person.id, effectiveRoles(person.specialty, byWorker.get(person.id) ?? [])])
  );
}

/**
 * Does this person hold `role`? Used by every assignment permission check.
 *
 * Deliberately resolves through the same effective-roles rule as everything
 * else, so a check can never disagree with what the worker list shows.
 */
export async function workerHoldsRole(
  person: { id: number; specialty: string | null } | undefined | null,
  role: string,
  cache?: RoleCache
): Promise<boolean> {
  if (!person) return false;
  if (sameRole(person.specialty, role)) return true;
  return rolesInclude(await rolesForWorker(person.id, cache), role);
}

/** Convenience wrapper around the shared comparator. */
export function rolesInclude(roles: string[], role: string): boolean {
  return hasRole(roles, role);
}

/**
 * Replace a person's stored roles. The first entry becomes primary.
 *
 * Only ever touches worker_roles. The workers row itself is never deleted or
 * recreated, so dropping a role can never drop the person or their history.
 */
export async function replaceWorkerRoles(handle: Db, workerId: number, roles: string[]): Promise<void> {
  const cleaned = normaliseRoles(roles);
  if (!cleaned.length) throw new Error("Choose at least one role for this person.");
  await handle.delete(workerRoles).where(eq(workerRoles.workerId, workerId));
  await handle.insert(workerRoles).values(
    cleaned.map((role, index) => ({ workerId, role, isPrimary: index === 0 }))
  );
}
