import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, workers } from "@/db/schema";
import { guard, OWNER } from "@/lib/authz";
import { hashPassword } from "@/lib/password";

const ROLES = ["OWNER", "PRODUCTION_MANAGER", "WORKER"];
const STATUSES = ["ACTIVE", "INACTIVE"];
type User = typeof users.$inferSelect;
const nameKey = (name: string) => name.toLowerCase().replace(/\b(mr|mrs|ms|miss|alhaji|dr)\.?\s+/g, "").replace(/\s+/g, " ").trim();

function safe(user: User, workerName?: string | null) {
  const { passwordHash, ...rest } = user;
  return { ...rest, hasPassword: !!passwordHash, workerName: workerName ?? null };
}
function databaseError(error: unknown) {
  const value = error as { code?: string; cause?: { code?: string } };
  return value?.cause?.code ?? value?.code;
}

async function managerWorkerId(value: unknown, accountId?: number): Promise<{ id: number | null; error?: string }> {
  if (value === null || value === undefined || value === "") return { id: null };
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) return { id: null, error: "Choose a valid worker profile." };
  const [worker] = await db.select({ id: workers.id, organizationId: workers.organizationId, status: workers.status, name: workers.name })
    .from(workers).where(eq(workers.id, id)).limit(1);
  if (!worker || worker.organizationId !== 1 || worker.status !== "ACTIVE")
    return { id: null, error: "Choose an active Matesther worker profile." };
  const [linked] = await db.select({ id: users.id }).from(users).where(eq(users.workerId, id)).limit(1);
  if (linked && linked.id !== accountId)
    return { id: null, error: `${worker.name} already has a staff login. Manage that account and change its role instead of creating a second login.` };
  return { id };
}

export async function GET(req: Request) {
  const denied = await guard(req, OWNER);
  if (denied) return denied;
  try {
    const [accounts, profiles] = await Promise.all([
      db.select().from(users),
      db.select({ id: workers.id, name: workers.name, organizationId: workers.organizationId, status: workers.status }).from(workers),
    ]);
    return NextResponse.json(accounts.map((account) => {
      const worker = account.workerId
        ? profiles.find((person) => person.id === account.workerId)
        : profiles.filter((person) => person.organizationId === account.organizationId && person.status === "ACTIVE" && nameKey(person.name) === nameKey(account.name))
          .length === 1 ? profiles.find((person) => person.organizationId === account.organizationId && person.status === "ACTIVE" && nameKey(person.name) === nameKey(account.name)) : null;
      return safe(account, worker?.name);
    }), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("Staff list failed", error);
    return NextResponse.json({ error: "Could not load staff accounts." }, { status: 500 });
  }
}

/** Worker sign-ins may be created before the matching record under Workers. */
export async function POST(req: Request) {
  const denied = await guard(req, OWNER);
  if (denied) return denied;
  try {
    const body = await req.json();
    const name = String(body.name ?? "").trim();
    const email = String(body.email ?? "").trim().toLowerCase();
    const role = String(body.role ?? "");
    const password = String(body.password ?? "");
    if (!name || !/^\S+@\S+\.\S+$/.test(email))
      return NextResponse.json({ error: "A full name and valid email are required." }, { status: 400 });
    if (password.length < 6)
      return NextResponse.json({ error: "Password must have at least 6 characters." }, { status: 400 });
    if (!ROLES.includes(role))
      return NextResponse.json({ error: "Choose a valid staff role." }, { status: 400 });
    const linked = role === "PRODUCTION_MANAGER" ? await managerWorkerId(body.workerId) : { id: null, error: undefined };
    if (linked.error) return NextResponse.json({ error: linked.error }, { status: 409 });
    const [created] = await db.insert(users).values({
      organizationId: 1, name, email, role, workerId: linked.id,
      passwordHash: hashPassword(password),
      phone: String(body.phone ?? "").trim() || null,
      status: "ACTIVE",
    }).returning();
    return NextResponse.json(safe(created), { status: 201 });
  } catch (error) {
    if (databaseError(error) === "23505")
      return NextResponse.json({ error: "That email already has a staff account." }, { status: 409 });
    console.error("Staff creation failed", error);
    return NextResponse.json({ error: "Could not create the staff account." }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  const denied = await guard(req, OWNER);
  if (denied) return denied;
  try {
    const body = await req.json();
    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id <= 0)
      return NextResponse.json({ error: "Valid account ID required." }, { status: 400 });
    const [current] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!current) return NextResponse.json({ error: "Staff account not found." }, { status: 404 });
    const role = body.role === undefined ? current.role : String(body.role);
    const status = body.status === undefined ? current.status : String(body.status);
    if (!ROLES.includes(role) || !STATUSES.includes(status))
      return NextResponse.json({ error: "Choose a valid role and status." }, { status: 400 });
    if (current.role === "OWNER" && current.status === "ACTIVE" && (role !== "OWNER" || status !== "ACTIVE")) {
      const owners = await db.select({ status: users.status }).from(users).where(eq(users.role, "OWNER"));
      if (owners.filter((account) => account.status === "ACTIVE").length <= 1)
        return NextResponse.json({ error: "Keep at least one active Owner account." }, { status: 409 });
    }
    const password = body.password ? String(body.password) : "";
    if (password && password.length < 6)
      return NextResponse.json({ error: "New password must have at least 6 characters." }, { status: 400 });
    const name = body.name === undefined ? current.name : String(body.name).trim();
    if (!name) return NextResponse.json({ error: "Staff name is required." }, { status: 400 });
    const linked = role === "PRODUCTION_MANAGER"
      ? await managerWorkerId(body.workerId === undefined ? current.workerId : body.workerId, id)
      : { id: role === "WORKER" ? current.workerId : null, error: undefined };
    if (linked.error) return NextResponse.json({ error: linked.error }, { status: 409 });
    const [updated] = await db.update(users).set({
      name, role, status, workerId: linked.id,
      phone: body.phone === undefined ? current.phone : String(body.phone).trim() || null,
      ...(password ? { passwordHash: hashPassword(password) } : {}),
    }).where(eq(users.id, id)).returning();
    return NextResponse.json(safe(updated));
  } catch (error) {
    console.error("Staff update failed", error);
    return NextResponse.json({ error: "Could not update the staff account." }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const denied = await guard(req, OWNER);
  if (denied) return denied;
  try {
    const id = Number(new URL(req.url).searchParams.get("id"));
    if (!Number.isSafeInteger(id) || id <= 0)
      return NextResponse.json({ error: "Valid account ID required." }, { status: 400 });
    const [account] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!account) return NextResponse.json({ error: "Staff account not found." }, { status: 404 });
    if (account.role === "OWNER" && account.status === "ACTIVE") {
      const owners = await db.select({ status: users.status }).from(users).where(eq(users.role, "OWNER"));
      if (owners.filter((owner) => owner.status === "ACTIVE").length <= 1)
        return NextResponse.json({ error: "Cannot delete the last active Owner." }, { status: 409 });
    }
    await db.delete(users).where(eq(users.id, id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Staff deletion failed", error);
    return NextResponse.json({ error: "Could not delete the staff account." }, { status: 500 });
  }
}
