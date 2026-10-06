import { NextResponse } from "next/server";
import { guard, getSessionUser, OWNER } from "@/lib/authz";
import { db } from "@/db";
import { materialUsage, materials, orders, orderItemSizes, workers } from "@/db/schema";
import { isReadyMadeMaterial } from "@/lib/format";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

/**
 * Material issued to, used by, returned from and wasted on a job.
 *
 * This is the SAME material system Matesther already runs - `materials`,
 * `material_purchases` and this table. Nothing here is a second inventory: a usage row
 * still names one material on one order, still carries its unit and total cost, and still
 * moves `materials.current_stock`. What is added is the rest of the truth about a job's
 * material, which the single `quantity_used` figure could not hold:
 *
 *   issued    what left the store for this job
 *   used      what went into the garments
 *   returned  what came back to the store unused
 *   wasted    what was spoiled, cut off or ruined and will not come back
 *
 * with the worker who took it, the exact variant it was for, when, and why.
 *
 * WHAT COSTS MONEY
 *   Used and wasted material are both consumed - neither comes back - so both are costed.
 *   Returned material is not, and it goes back into stock. Every record written before
 *   these fields existed has no wasted quantity, so its cost is unchanged: this does not
 *   restate a single historical figure.
 */

/** Enrich only the rows being returned, never the whole catalogue. */
async function enrich(rows: typeof materialUsage.$inferSelect[]) {
  if (!rows.length) return [];
  const materialIds = [...new Set(rows.map((row) => row.materialId).filter((v): v is number => !!v))];
  const orderIds = [...new Set(rows.map((row) => row.orderId).filter((v): v is number => !!v))];
  const workerIds = [...new Set(rows.map((row) => row.workerId).filter((v): v is number => !!v))];
  const variantIds = [...new Set(rows.map((row) => row.orderVariantId).filter((v): v is number => !!v))];
  const [materialRows, orderRows, workerRows, variantRows] = await Promise.all([
    materialIds.length
      ? db.select({ id: materials.id, name: materials.name, unit: materials.unit, category: materials.category })
          .from(materials).where(inArray(materials.id, materialIds))
      : [],
    orderIds.length
      ? db.select({ id: orders.id, orderNumber: orders.orderNumber }).from(orders).where(inArray(orders.id, orderIds))
      : [],
    workerIds.length
      ? db.select({ id: workers.id, name: workers.name }).from(workers).where(inArray(workers.id, workerIds))
      : [],
    variantIds.length
      ? db.select({ id: orderItemSizes.id, size: orderItemSizes.size, color: orderItemSizes.color })
          .from(orderItemSizes).where(inArray(orderItemSizes.id, variantIds))
      : [],
  ]);
  const materialById = new Map(materialRows.map((row) => [row.id, row]));
  const orderById = new Map(orderRows.map((row) => [row.id, row]));
  const workerById = new Map(workerRows.map((row) => [row.id, row]));
  const variantById = new Map(variantRows.map((row) => [row.id, row]));

  return rows.map((row) => {
    const material = materialById.get(row.materialId);
    const variant = row.orderVariantId ? variantById.get(row.orderVariantId) : undefined;
    const issued = row.quantityIssued ?? row.quantityUsed ?? 0;
    const used = row.quantityUsed ?? 0;
    const returned = row.quantityReturned ?? 0;
    const wasted = row.quantityWasted ?? 0;
    return {
      ...row,
      materialName: material?.name ?? "-",
      unit: material?.unit ?? "",
      category: material?.category ?? null,
      orderNumber: row.orderId ? orderById.get(row.orderId)?.orderNumber ?? "-" : "-",
      workerName: row.workerId ? workerById.get(row.workerId)?.name ?? null : null,
      variant: variant ? [variant.size, variant.color].filter(Boolean).join(" / ") || null : null,
      // Issued defaults to what was used, so a record written before this field existed
      // still reads correctly instead of claiming nothing was handed out.
      quantityIssued: issued,
      quantityReturned: returned,
      quantityWasted: wasted,
      outstanding: Math.max(0, issued - used - returned - wasted),
      wastedCost: (row.unitCost ?? 0) * wasted,
    };
  });
}

/**
 * GET /api/material-usage?orderId=&materialId=&limit=&offset=
 *
 * Filtered and paged in SQL. This used to read every usage row, every material and every
 * order in the database and filter them in JavaScript, which grows without limit.
 */
export async function GET(req: Request) {
  // Owner-only, exactly as before: who is allowed to see material cost has not changed.
  const denied = await guard(req, OWNER);
  if (denied) return denied;
  try {
    const { searchParams } = new URL(req.url);
    const orderId = Number(searchParams.get("orderId") ?? "") || null;
    const materialId = Number(searchParams.get("materialId") ?? "") || null;
    const rawLimit = searchParams.get("limit") ? Number(searchParams.get("limit")) : NaN;
    const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : 500;
    const rawOffset = searchParams.get("offset") ? Number(searchParams.get("offset")) : 0;
    const offset = Number.isSafeInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;

    const where = and(
      orderId ? eq(materialUsage.orderId, orderId) : undefined,
      materialId ? eq(materialUsage.materialId, materialId) : undefined
    );
    const [totalRow] = await db.select({ total: sql<number>`count(*)` }).from(materialUsage).where(where);
    const rows = await db
      .select()
      .from(materialUsage)
      .where(where)
      .orderBy(desc(materialUsage.usedAt), desc(materialUsage.id))
      .limit(limit)
      .offset(offset);
    return NextResponse.json(await enrich(rows), {
      headers: { "Cache-Control": "private, no-store", "X-Total-Count": String(Number(totalRow?.total ?? 0)) },
    });
  } catch (e: any) {
    console.error("Material usage load failed", e);
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}

/**
 * Keep the notes trail inside the 2000-character guard this route has always applied.
 *
 * Trimming drops from the OLDEST end, because the entry somebody is about to read is the
 * newest one. In practice this never triggers: returned and wasted can only ever increase,
 * and together with used they can never exceed what was issued, so a single record can only
 * accumulate as many entries as there were units to account for.
 */
function trimTrail(parts: string[]): string | null {
  const kept = parts.filter((part) => part && part.trim() !== "");
  if (!kept.length) return null;
  let trail = kept;
  while (trail.length > 1 && trail.join(" | ").length > 2000) trail = trail.slice(1);
  return trail.join(" | ").slice(-2000);
}

/** A whole, non-negative quantity, or null when the field was not supplied. */
function readQuantity(body: any, field: string): number | null {
  const raw = body[field];
  if (raw === undefined || raw === "" || raw === null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0)
    throw Object.assign(new Error(`${field} must be zero or more.`), { status: 400 });
  return value;
}

export async function POST(req: Request) {
  const denied = await guard(req, OWNER);
  if (denied) return denied;
  try {
    const b = await req.json();
    if (!b.materialId) return NextResponse.json({ error: "Material is required" }, { status: 400 });
    if (!b.orderId) return NextResponse.json({ error: "Link usage to an order" }, { status: 400 });
    if (!b.quantityUsed || Number(b.quantityUsed) <= 0)
      return NextResponse.json({ error: "Quantity used must be greater than zero" }, { status: 400 });
    const [mat] = await db.select().from(materials).where(eq(materials.id, Number(b.materialId)));
    if (!mat) return NextResponse.json({ error: "Material not found" }, { status: 404 });
    const [order] = await db.select().from(orders).where(eq(orders.id, Number(b.orderId)));
    if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });

    const qty = Number(b.quantityUsed);
    let issued: number | null;
    let returned: number | null;
    let wasted: number | null;
    try {
      issued = readQuantity(b, "quantityIssued");
      returned = readQuantity(b, "quantityReturned");
      wasted = readQuantity(b, "quantityWasted");
    } catch (error: any) {
      return NextResponse.json({ error: error?.message ?? "Quantities must be zero or more." }, { status: 400 });
    }

    // What left the store has to account for everything that happened to it.
    const held = issued ?? qty + (returned ?? 0) + (wasted ?? 0);
    if (issued !== null && qty + (returned ?? 0) + (wasted ?? 0) > issued)
      return NextResponse.json({
        error: `${qty} used, ${returned ?? 0} returned and ${wasted ?? 0} wasted is more than the ${issued} issued. Record what was actually handed out.`,
      }, { status: 400 });
    if ((returned ?? 0) > 0 || (wasted ?? 0) > 0) {
      if (!String(b.notes ?? "").trim())
        return NextResponse.json(
          { error: "Material returned or wasted needs a written reason, so the figure can be audited." },
          { status: 400 }
        );
    }

    const variantId = b.orderVariantId ? Number(b.orderVariantId) : null;
    if (variantId !== null) {
      if (!Number.isSafeInteger(variantId))
        return NextResponse.json({ error: "Choose a valid variant." }, { status: 400 });
      const [variant] = await db.select().from(orderItemSizes).where(eq(orderItemSizes.id, variantId)).limit(1);
      if (!variant) return NextResponse.json({ error: "That variant could not be found." }, { status: 404 });
    }
    const workerId = b.workerId ? Number(b.workerId) : null;
    if (workerId !== null) {
      const [person] = await db.select().from(workers).where(eq(workers.id, workerId)).limit(1);
      if (!person) return NextResponse.json({ error: "That worker could not be found." }, { status: 404 });
    }

    const unitCost = b.unitCost !== undefined && b.unitCost !== "" ? Number(b.unitCost) : mat.unitCost ?? 0;
    // Used and wasted are both consumed, so both are costed. Returned is not, and it
    // goes back into stock. A record with no wasted quantity costs exactly what the same
    // record cost before this field existed, so no historical figure is restated.
    const consumed = qty + (wasted ?? 0);

    // Stock leaves for what was issued and comes back for what was returned. Where no
    // issued figure was given this is exactly the behaviour that was there before: the
    // consumed quantity leaves the store.
    const netOut = issued !== null ? Math.max(0, issued - (returned ?? 0)) : consumed;

    /**
     * A ready-made garment has no raw-material stock account at all - `POST
     * /api/material-purchases` keeps finished goods off the fabric shelf - so there is
     * nothing to count and nothing to move, in either direction. Its cost is still recorded
     * here and still classified as `readyMade` by `order-cost`, never as a raw material.
     */
    const keepsStock = !isReadyMadeMaterial(mat.category);

    /**
     * The shelf is counted BEFORE anything is written, so an issue that cannot be met is
     * refused whole. Nothing is partially issued and nothing is silently clamped to what
     * happens to be left: a short shelf is either a purchase that has not been recorded or a
     * stock figure that is wrong, and quietly issuing less would hide whichever it is - and
     * would understate the cost of the job, since the record is what the order is charged
     * from. Raw-material stock therefore never goes negative.
     */
    if (keepsStock) {
      const onShelf = mat.currentStock ?? 0;
      if (netOut > onShelf) {
        const unit = mat.unit ? ` ${mat.unit}` : "";
        return NextResponse.json({
          error: `Only ${onShelf}${unit} of ${mat.name} is in the store, which is not enough to issue ${netOut}${unit}. Record the purchase first, or issue what is actually available - stock cannot go negative.`,
        }, { status: 400 });
      }
    }

    const [row] = await db
      .insert(materialUsage)
      .values({
        orderId: Number(b.orderId),
        productionOperationId: b.productionOperationId ? Number(b.productionOperationId) : null,
        orderVariantId: variantId,
        workerId,
        materialId: Number(b.materialId),
        quantityUsed: qty,
        quantityIssued: issued,
        quantityReturned: returned ?? 0,
        quantityWasted: wasted ?? 0,
        unitCost,
        totalCost: consumed * unitCost,
        notes: b.notes ? String(b.notes).slice(0, 2000) : null,
      })
      .returning();

    if (keepsStock) {
      await db
        .update(materials)
        .set({ currentStock: (mat.currentStock ?? 0) - netOut })
        .where(eq(materials.id, mat.id));
    }
    return NextResponse.json((await enrich([row]))[0] ?? row, { status: 201 });
  } catch (e: any) {
    console.error("Material usage record failed", e);
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}

/**
 * PUT /api/material-usage  { id, quantityUsed?, quantityReturned?, quantityWasted?, notes }
 *
 * Recording what came back or was ruined AFTER the material was issued, which is how it
 * actually happens: twelve yards go out, ten end up in the garments, two come back uncut.
 *
 * What may and may not move:
 *   - returned and wasted can be ADDED to, never reduced. Once material is back in the
 *     store or written off, that is a fact about the store, and correcting it means a new
 *     record with a reason beside it rather than an edit that leaves no trace;
 *   - used may fall, but only as far as the record still accounts for what was issued -
 *     used + returned + wasted can never exceed issued, so lowering `used` without
 *     recording where the material went simply leaves it outstanding against the job;
 *   - and any return or write-off needs a written reason OF ITS OWN, in the request. The
 *     reason the material was issued for is not a reason for bringing some of it back.
 *
 * A return or write-off is appended to `notes` as a dated, attributed line rather than
 * replacing what is there, so the record answers who / when / why for the return as well as
 * for the issue. See the comment on the trail below for why it is not a ledger event.
 */
export async function PUT(req: Request) {
  const denied = await guard(req, OWNER);
  if (denied) return denied;
  try {
    const b = await req.json();
    const id = Number(b.id);
    if (!Number.isSafeInteger(id) || id < 1)
      return NextResponse.json({ error: "Choose the material record." }, { status: 400 });
    const [usage] = await db.select().from(materialUsage).where(eq(materialUsage.id, id)).limit(1);
    if (!usage) return NextResponse.json({ error: "Material record not found." }, { status: 404 });

    let used: number | null;
    let returned: number | null;
    let wasted: number | null;
    try {
      used = readQuantity(b, "quantityUsed");
      returned = readQuantity(b, "quantityReturned");
      wasted = readQuantity(b, "quantityWasted");
    } catch (error: any) {
      return NextResponse.json({ error: error?.message ?? "Quantities must be zero or more." }, { status: 400 });
    }
    if (used === null && returned === null && wasted === null)
      return NextResponse.json({ error: "Record a quantity used, returned or wasted." }, { status: 400 });

    const nextUsed = used ?? usage.quantityUsed ?? 0;
    const nextReturned = returned ?? usage.quantityReturned ?? 0;
    const nextWasted = wasted ?? usage.quantityWasted ?? 0;
    if (returned !== null && returned < (usage.quantityReturned ?? 0))
      return NextResponse.json({
        error: `Already recorded ${usage.quantityReturned ?? 0} returned to the store, which cannot be un-returned (${returned}). Add a new record with a reason instead.`,
      }, { status: 400 });
    if (wasted !== null && wasted < (usage.quantityWasted ?? 0))
      return NextResponse.json({
        error: `Already recorded ${usage.quantityWasted ?? 0} wasted, which cannot be un-written-off (${wasted}). Add a new record with a reason instead.`,
      }, { status: 400 });

    /**
     * What this record says went out of the store.
     *
     * A record that was issued with an explicit figure uses it. One that predates issue
     * tracking has none, and for those the definition is the one POST already uses for the
     * same request shape (`held = issued ?? used + returned + wasted`): everything the record
     * accounts for. Falling back to `quantityUsed` alone instead - as this did - made the
     * ceiling SHRINK as material came back, because a return lowers `used`. Eight yards out
     * and two returned left a ceiling of six, so a third yard genuinely coming back was
     * refused as "more than the 6 issued" when eight had been issued. Summing what the record
     * accounts for is invariant under a correct return, so the ceiling stays put.
     */
    const issued =
      usage.quantityIssued ??
      (usage.quantityUsed ?? 0) + (usage.quantityReturned ?? 0) + (usage.quantityWasted ?? 0);
    if (nextUsed + nextReturned + nextWasted > issued)
      return NextResponse.json({
        error: `${nextUsed} used, ${nextReturned} returned and ${nextWasted} wasted is more than the ${issued} issued on this record.`,
      }, { status: 400 });

    const returnedDelta = nextReturned - (usage.quantityReturned ?? 0);
    const wastedDelta = nextWasted - (usage.quantityWasted ?? 0);

    /**
     * An edit may put material BACK on the shelf; it may never take more out of it.
     *
     * `POST` is the only path that draws stock down, and the only one that can count the
     * shelf before doing so. Here the issued figure is already fixed (this route never
     * rewrites it) and a recorded return can never be un-recorded, so the net-out this record
     * implies - issued minus returned, the same expression `POST` uses - can only ever fall.
     * That is asserted rather than assumed: were a future edit path ever to let it grow, the
     * request is refused and the material has to be issued properly, through `POST`, where the
     * shelf is counted. This is what makes "stock cannot go negative" true of both routes
     * rather than of one.
     */
    const netOutBefore = issued - (usage.quantityReturned ?? 0);
    const netOutAfter = issued - nextReturned;
    if (netOutAfter > netOutBefore)
      return NextResponse.json({
        error: `This edit would take ${netOutAfter - netOutBefore} more out of the store than the record accounts for. Issue it as a new record instead - an edit cannot draw down stock that was never counted against the shelf.`,
      }, { status: 400 });
    /**
     * The reason must be THIS return's own.
     *
     * This used to read `b.notes ?? usage.notes`, so a return could be recorded with no
     * reason at all as long as the record already had one from when the material was
     * issued - which is a reason for a different event. POST has always required the
     * reason in the request; the two paths now agree, and agree with what this route's own
     * comment claims ("any return or write-off needs a written reason").
     */
    const reason = String(b.notes ?? "").trim();
    if ((returnedDelta > 0 || wastedDelta > 0) && !reason)
      return NextResponse.json(
        { error: "Material returned or wasted needs a written reason, so the figure can be audited." },
        { status: 400 }
      );

    /**
     * The audit trail for a return or a write-off, appended rather than overwritten.
     *
     * `material_usage` has no `updated_at` and no `recorded_by`, and `usedAt` stays at the
     * moment the material was ISSUED - so a return recorded three weeks later left no trace
     * of when it happened or who recorded it, and writing the return's reason overwrote the
     * reason the material was issued for. Who / when / why was therefore incomplete for the
     * return itself, which is the event that puts stock back on the shelf.
     *
     * The production movement ledger is the obvious home for this and was designed with a
     * MATERIAL_ISSUED event in mind, but it cannot hold one: it requires an operation, a
     * batch and a stage, all NOT NULL, while material is issued against an ORDER and
     * usually has no stage at all. Using it would mean a migration to widen three columns -
     * a redesign of the ledger for one field on one table. So the trail goes in the notes
     * column, which is already the designated reason field, and no schema changes.
     */
    const session = await getSessionUser(req);
    const recorded = new Date().toISOString().slice(0, 10);
    const actor = session?.name ?? "Unknown";
    const happened: string[] = [];
    if (returnedDelta > 0) happened.push(`${returnedDelta} returned to store`);
    if (wastedDelta > 0) happened.push(`${wastedDelta} written off`);
    const entry = happened.length ? `[${recorded}] ${happened.join(" and ")} by ${actor}: ${reason}` : null;
    // A new return or write-off APPENDS. Any other edit replaces the free-text note exactly
    // as it always did, so nothing that only corrects `used` behaves differently.
    const nextNotes = entry
      ? trimTrail([usage.notes ?? "", entry])
      : (b.notes === undefined ? usage.notes : String(b.notes).slice(0, 2000) || null);

    const unitCost = usage.unitCost ?? 0;
    const [row] = await db
      .update(materialUsage)
      .set({
        quantityUsed: nextUsed,
        quantityReturned: nextReturned,
        quantityWasted: nextWasted,
        // Used and wasted are both consumed, so both join the cost of the job. Material
        // that came back to the store does not.
        totalCost: (nextUsed + nextWasted) * unitCost,
        notes: nextNotes,
      })
      .where(eq(materialUsage.id, id))
      .returning();

    // What comes back to the store goes back into stock. What is newly written off was
    // already out of stock when it was issued, so it moves nothing. A ready-made garment
    // never left a shelf in the first place (its issue above moved no stock, and a purchase of
    // one never adds any), so returning one must not put finished goods on the fabric shelf
    // either - the exemption has to hold in both directions or stock appears out of nothing.
    if (returnedDelta !== 0 && usage.materialId) {
      const [mat] = await db.select().from(materials).where(eq(materials.id, usage.materialId)).limit(1);
      if (mat && !isReadyMadeMaterial(mat.category)) {
        await db.update(materials).set({
          currentStock: sql`coalesce(${materials.currentStock}, 0) + ${returnedDelta}`,
        }).where(eq(materials.id, usage.materialId));
      }
    }
    return NextResponse.json((await enrich([row]))[0] ?? row);
  } catch (e: any) {
    console.error("Material usage update failed", e);
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}

