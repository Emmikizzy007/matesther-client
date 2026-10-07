import { NextResponse } from "next/server";
import { db } from "@/db";
import { productionBatches, productionRouteStages, productionRoutes, products } from "@/db/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { guard, getSessionUser, OWNER, STAFF } from "@/lib/authz";
import { PRODUCTION_METHODS, STAGES } from "@/lib/format";
import { isAutomaticRoute, listRoutes, normaliseStages, unknownMethods, unknownStages, type RouteStage } from "@/lib/production-route";

export const dynamic = "force-dynamic";

/**
 * PRODUCTION ROUTES.
 *
 * A route is the ordered list of stages ONE garment actually passes through. It is
 * a subset of Matesther's existing stages - it may include all eight, skip stages,
 * start later or end earlier - and it never invents a stage, so roles, labels,
 * inspection, separation of duties and payroll all keep working.
 *
 * EDITING A ROUTE NEVER REWRITES HISTORY. A batch's route is frozen as its own
 * `production_operations` rows in `route_position` order, so changing a product's
 * route next month affects only batches created after the change. That is why this
 * route allows stages to be replaced freely.
 */

/**
 * GET /api/routes?productId=&activeOnly=1 - routes with their stages, for the editor.
 *
 * `productId` absent  -> every route this organisation owns.
 * `productId=` (empty) -> organization-level routes only (no product).
 * `productId=7`       -> product 7's routes.
 *
 * The organisation filter is pushed into `listRoutes` rather than applied to the
 * result, so another company's routes are never read at all - previously every
 * route in the database was selected and then filtered in JavaScript, which both
 * leaked the read and grew with the whole table.
 */
export async function GET(req: Request) {
  const denied = await guard(req, STAFF);
  if (denied) return denied;
  try {
    const session = await getSessionUser(req);
    const query = new URL(req.url).searchParams;
    const rawProductId = query.get("productId");
    // A malformed productId is refused rather than quietly widened to "every route".
    if (rawProductId !== null && rawProductId.trim() !== "" && !/^\d+$/.test(rawProductId.trim()))
      return NextResponse.json({ error: "Choose a valid garment." }, { status: 400 });
    const productId = rawProductId === null
      ? undefined
      : rawProductId.trim() === ""
        ? null
        : Number(rawProductId.trim());
    const routes = await listRoutes({
      productId,
      organizationId: session?.organizationId ?? null,
      activeOnly: query.get("activeOnly") === "1",
    });
    const productIds = [...new Set(routes.map((route) => route.productId).filter((v): v is number => !!v))];
    const garments = productIds.length
      ? await db.select({ id: products.id, name: products.name }).from(products).where(inArray(products.id, productIds))
      : [];
    const garmentById = new Map(garments.map((row) => [row.id, row.name]));
    return NextResponse.json(
      routes.map((route) => ({
        ...route,
        productName: route.productId ? garmentById.get(route.productId) ?? null : null,
        // What a NEW batch would follow if it used this route.
        applicableStages: route.stages.map((stage) => stage.stage),
        /**
         * Whether a new batch of this garment would actually FOLLOW this route.
         *
         * A route can be saved against a product and still not be the one used -
         * it may be retired, another of the product's routes may be flagged as its
         * default, or two unflagged routes may leave nothing to choose between.
         * Saying so on the row is what stops the screen showing a product route
         * that production silently ignores, which is how this bug was first seen.
         */
        usedForNewBatches: isAutomaticRoute(route, routes),
      })),
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (error) {
    console.error("Route list failed", error);
    return NextResponse.json({ error: "Could not load production routes." }, { status: 500 });
  }
}

/**
 * POST /api/routes - define a route.
 * { name, productId?, stages: [{ stage, method?, roleRequired? }], isDefault?, notes? }
 */
export async function POST(req: Request) {
  const denied = await guard(req, OWNER);
  if (denied) return denied;
  try {
    const body = await req.json();
    const session = await getSessionUser(req);
    if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

    const name = String(body.name ?? "").trim();
    if (!name) return NextResponse.json({ error: "Give this route a name, for example \"Polo - no cutting\"." }, { status: 400 });
    if (name.length > 120) return NextResponse.json({ error: "Keep the route name under 120 characters." }, { status: 400 });

    const normalised = normaliseStages(body.stages);
    if ("error" in normalised) return NextResponse.json({ error: normalised.error }, { status: 400 });
    const stages = normalised.stages;

    const badStages = unknownStages(stages.map((stage) => stage.stage));
    if (badStages.length)
      return NextResponse.json({ error: `${badStages.join(", ")} is not one of Matesther's stages: ${STAGES.join(", ")}.` }, { status: 400 });
    const badMethods = unknownMethods(stages.map((stage) => stage.method));
    if (badMethods.length)
      return NextResponse.json({ error: `${badMethods.join(", ")} is not a production method. Choose from ${PRODUCTION_METHODS.join(", ")}.` }, { status: 400 });

    const productId = body.productId ? Number(body.productId) : null;
    if (productId) {
      const [garment] = await db.select({ id: products.id, organizationId: products.organizationId })
        .from(products).where(eq(products.id, productId)).limit(1);
      if (!garment || (garment.organizationId && garment.organizationId !== session.organizationId))
        return NextResponse.json({ error: "Choose one of Matesther's own garments." }, { status: 400 });
    }
    const isDefault = body.isDefault === true || body.isDefault === "true";

    const created = await db.transaction(async (tx) => {
      // One default per scope: a product's own default, or the organization's
      // generic default. Without this, "which route does a new batch follow"
      // would depend on row order.
      if (isDefault) {
        await tx
          .update(productionRoutes)
          .set({ isDefault: false })
          .where(
            productId
              ? and(eq(productionRoutes.productId, productId), eq(productionRoutes.isActive, true))
              : and(eq(productionRoutes.isDefault, true), isNull(productionRoutes.productId))
          );
      }
      const [route] = await tx.insert(productionRoutes).values({
        organizationId: session.organizationId,
        productId,
        name,
        isDefault,
        isActive: true,
        notes: body.notes ? String(body.notes).slice(0, 2000) : null,
      }).returning();
      await tx.insert(productionRouteStages).values(
        stages.map((stage) => ({
          routeId: route.id,
          position: stage.position,
          stage: stage.stage,
          method: stage.method,
          roleRequired: stage.roleRequired,
          notes: null,
        }))
      );
      return route;
    });
    const [withStages] = (await listRoutes({ organizationId: session.organizationId }))
      .filter((route) => route.id === created.id);
    return NextResponse.json(withStages ?? created, { status: 201 });
  } catch (error) {
    console.error("Route creation failed", error);
    return NextResponse.json({ error: "Could not save this production route." }, { status: 500 });
  }
}

/**
 * PUT /api/routes - rename, re-order, re-method, re-assign, or retire a route.
 * { id, name?, notes?, isActive?, isDefault?, productId?, stages? }
 *
 * Retiring (`isActive: false`) is the safe way to stop using a route: batches
 * already in production keep the stages they were created with, because their
 * route lives on their own operations, not here.
 *
 * `productId` IS EDITABLE, which it was not. A route created without a product
 * could never be assigned to one afterwards, and a route assigned to the wrong
 * garment could never be moved - the field arrived in the request body and was
 * silently dropped. Moving a route rewrites no history for the same reason
 * editing its stages does not: existing batches carry their own frozen positions.
 */
export async function PUT(req: Request) {
  const denied = await guard(req, OWNER);
  if (denied) return denied;
  try {
    const body = await req.json();
    const session = await getSessionUser(req);
    if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id < 1)
      return NextResponse.json({ error: "Choose a production route." }, { status: 400 });
    // Scoped to the caller's organisation in the query, so another company's route
    // is not found rather than found and then edited.
    const [route] = await db
      .select()
      .from(productionRoutes)
      .where(and(
        eq(productionRoutes.id, id),
        session.organizationId === null ? undefined : eq(productionRoutes.organizationId, session.organizationId)
      ))
      .limit(1);
    if (!route) return NextResponse.json({ error: "Route not found." }, { status: 404 });

    let stages: RouteStage[] | null = null;
    if (body.stages !== undefined) {
      const normalised = normaliseStages(body.stages);
      if ("error" in normalised) return NextResponse.json({ error: normalised.error }, { status: 400 });
      const badMethods = unknownMethods(normalised.stages.map((stage) => stage.method));
      if (badMethods.length)
        return NextResponse.json({ error: `${badMethods.join(", ")} is not a production method.` }, { status: 400 });
      stages = normalised.stages;
    }

    /* ---- which garment this route belongs to ---- */
    // `undefined` keeps what is stored; `null` detaches it to organization level.
    const nextProductId = body.productId === undefined
      ? route.productId
      : body.productId === null || body.productId === ""
        ? null
        : Number(body.productId);
    if (nextProductId !== null && (!Number.isSafeInteger(nextProductId) || nextProductId < 1))
      return NextResponse.json({ error: "Choose a valid garment." }, { status: 400 });
    if (nextProductId !== null) {
      const [garment] = await db.select({ id: products.id, organizationId: products.organizationId })
        .from(products).where(eq(products.id, nextProductId)).limit(1);
      if (!garment || (garment.organizationId && garment.organizationId !== session.organizationId))
        return NextResponse.json({ error: "Choose one of Matesther's own garments." }, { status: 400 });
    }

    const isDefault = body.isDefault === undefined ? route.isDefault : body.isDefault === true || body.isDefault === "true";
    const isActive = body.isActive === undefined ? route.isActive : body.isActive === true || body.isActive === "true";

    const updated = await db.transaction(async (tx) => {
      // One default per scope. The scope is the route's NEW product, because moving
      // a route between garments moves which set of siblings it competes with.
      if (isDefault) {
        await tx
          .update(productionRoutes)
          .set({ isDefault: false })
          .where(
            nextProductId !== null
              ? and(eq(productionRoutes.productId, nextProductId), eq(productionRoutes.isActive, true))
              : and(eq(productionRoutes.isDefault, true), isNull(productionRoutes.productId))
          );
      }
      if (stages) {
        // Replacing the definition is safe precisely because batches do not read
        // it after creation - each one carries its own frozen positions.
        await tx.delete(productionRouteStages).where(eq(productionRouteStages.routeId, route.id));
        await tx.insert(productionRouteStages).values(
          stages.map((stage) => ({
            routeId: route.id, position: stage.position, stage: stage.stage,
            method: stage.method, roleRequired: stage.roleRequired, notes: null,
          }))
        );
      }
      const [row] = await tx.update(productionRoutes).set({
        name: body.name === undefined ? route.name : String(body.name).trim().slice(0, 120) || route.name,
        notes: body.notes === undefined ? route.notes : body.notes ? String(body.notes).slice(0, 2000) : null,
        productId: nextProductId,
        isDefault,
        isActive,
      }).where(eq(productionRoutes.id, route.id)).returning();
      return row;
    });
    const [withStages] = (await listRoutes({ organizationId: session.organizationId }))
      .filter((entry) => entry.id === updated.id);
    return NextResponse.json(withStages ?? updated);
  } catch (error) {
    console.error("Route update failed", error);
    return NextResponse.json({ error: "Could not update this production route." }, { status: 500 });
  }
}

/**
 * DELETE /api/routes?id= - refuse while batches still point at it.
 *
 * A batch only references its route for provenance, so deleting one would not
 * break production - but it would erase the record of which route a live batch was
 * built from. Retire it instead; deletion is allowed once nothing references it.
 */
export async function DELETE(req: Request) {
  const denied = await guard(req, OWNER);
  if (denied) return denied;
  try {
    const session = await getSessionUser(req);
    if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
    const id = Number(new URL(req.url).searchParams.get("id"));
    if (!Number.isSafeInteger(id) || id < 1)
      return NextResponse.json({ error: "Choose a production route." }, { status: 400 });
    // Scoped to the caller's organisation, exactly as PUT is: another company's
    // route is not found rather than found and then deleted.
    const [route] = await db
      .select()
      .from(productionRoutes)
      .where(and(
        eq(productionRoutes.id, id),
        session.organizationId === null ? undefined : eq(productionRoutes.organizationId, session.organizationId)
      ))
      .limit(1);
    if (!route) return NextResponse.json({ error: "Route not found." }, { status: 404 });
    const [referenced] = await db
      .select({ id: productionBatches.id })
      .from(productionBatches)
      .where(eq(productionBatches.routeId, id))
      .limit(1);
    if (referenced)
      return NextResponse.json({
        error: "Batches were already produced from this route. Retire it instead (set it inactive) so the record of what those batches followed is kept.",
      }, { status: 400 });
    await db.transaction(async (tx) => {
      await tx.delete(productionRouteStages).where(eq(productionRouteStages.routeId, id));
      await tx.delete(productionRoutes).where(eq(productionRoutes.id, id));
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Route removal failed", error);
    return NextResponse.json({ error: "Could not remove this production route." }, { status: 500 });
  }
}
