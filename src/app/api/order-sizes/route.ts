import { NextResponse } from "next/server";
import { db } from "@/db";
import { orderItemSizes, orderItems, products } from "@/db/schema";
import { eq } from "drizzle-orm";
import { guard, OWNER, STAFF } from "@/lib/authz";
import { variantLabel } from "@/lib/format";
import { completedForVariant } from "@/lib/production-route";

/**
 * The exact garment VARIANTS on an order item.
 *
 * This began as a size breakdown (S, M, L, XL, 4-5, 6-7 …). A variant is now
 * item + optional size + optional colour + required quantity, so a school order can
 * say "10 navy blazers in size 8" and "6 black blazers in size 8" as two distinct
 * things - which is what production is actually allocated against.
 *
 * `completed` is returned two ways and the difference matters:
 *   completedFromProduction - derived from the production ledger: the quantity
 *     approved at the LAST stage of each batch producing this variant. This is the
 *     truthful figure and it is what the order page shows.
 *   completed - the stored column, which was free text with no event behind it.
 *     It is still returned, and still saved when posted, because silently zeroing
 *     a figure someone recorded would be exactly the kind of quiet overwrite this
 *     system now refuses. Where production exists, the derived figure wins.
 */
export async function GET(req: Request) {
  const __g = await guard(req, STAFF);
  if (__g) return __g;
  try {
    const { searchParams } = new URL(req.url);
    const itemId = searchParams.get("itemId");
    if (!itemId)
      return NextResponse.json({ error: "itemId is required" }, { status: 400 });

    const [item] = await db
      .select()
      .from(orderItems)
      .where(eq(orderItems.id, Number(itemId)));
    if (!item) return NextResponse.json({ error: "Order item not found" }, { status: 404 });

    const product = item.productId
      ? await db.select().from(products).where(eq(products.id, item.productId))
      : [];
    const rows = await db
      .select()
      .from(orderItemSizes)
      .where(eq(orderItemSizes.orderItemId, item.id));
    // Derived, per variant, from the ledger - not typed in.
    const derived = await Promise.all(rows.map((row) => completedForVariant(row.id)));

    return NextResponse.json({
      item: {
        id: item.id,
        productName: product[0]?.name ?? "-",
        quantity: item.quantity,
      },
      sizes: rows.map((r, index) => ({
        id: r.id,
        size: r.size,
        color: r.color,
        quantity: r.quantity,
        // The truthful figure when the variant has been produced.
        completed: derived[index] > 0 ? Math.min(derived[index], r.quantity) : r.completed,
        completedFromProduction: derived[index],
        completedRecorded: r.completed,
        variant: variantLabel(r.size, r.color),
      })),
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" },
      { status: 500 }
    );
  }
}

/** POST - replace the size breakdown for an item: { itemId, sizes: [{size, quantity, completed}] } */
export async function POST(req: Request) {
  const __g = await guard(req, OWNER);
  if (__g) return __g;
  try {
    const b = await req.json();
    const itemId = Number(b.itemId);
    if (!itemId || !Array.isArray(b.sizes))
      return NextResponse.json(
        { error: "itemId and a sizes list are required" },
        { status: 400 }
      );
    // Replace-all, atomically: a failure half-way through used to be able to
    // leave an item with its size breakdown deleted and only partly rewritten.
    // Reject a list that would produce two rows for the same exact garment. The
    // database enforces this too, but refusing here means the caller is told which
    // duplicate to fix instead of receiving a constraint error.
    const seen = new Set<string>();
    for (const entry of b.sizes) {
      const size = String(entry.size ?? "").trim().toUpperCase();
      const color = String(entry.color ?? "").trim();
      if (!size && !color) continue;
      const key = `${size}|${color.toLowerCase()}`;
      if (seen.has(key))
        return NextResponse.json({
          error: `${variantLabel(size, color)} is listed twice. Each exact garment needs one line with its total quantity.`,
        }, { status: 400 });
      seen.add(key);
    }
    const [item] = await db.select().from(orderItems).where(eq(orderItems.id, itemId)).limit(1);
    const totalListed = b.sizes.reduce((sum: number, entry: any) => {
      const size = String(entry?.size ?? "").trim();
      const color = String(entry?.color ?? "").trim();
      return size || color ? sum + (Number(entry?.quantity) || 0) : sum;
    }, 0);
    if (item?.quantity && totalListed > item.quantity)
      return NextResponse.json({
        error: `These variants total ${totalListed} garments but only ${item.quantity} were ordered.`,
      }, { status: 400 });

    await db.transaction(async (tx) => {
      await tx.delete(orderItemSizes).where(eq(orderItemSizes.orderItemId, itemId));
      for (const s of b.sizes) {
        const size = String(s.size ?? "").trim().toUpperCase();
        const color = String(s.color ?? "").trim();
        // A variant needs a size OR a colour. Requiring a size, as this once did,
        // is what made "10 navy blazers, no size run" impossible to record.
        if (!size && !color) continue;
        await tx.insert(orderItemSizes).values({
          orderItemId: itemId,
          size: size || null,
          color: color || null,
          quantity: Number(s.quantity) || 0,
          completed: Math.min(Number(s.completed) || 0, Number(s.quantity) || 0),
        });
      }
    });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" },
      { status: 500 }
    );
  }
}

/**
 * PUT was REMOVED.
 *
 * It accepted `{ id, completed }` and wrote a production quantity straight into
 * `order_item_sizes.completed` with no event behind it, no actor, no timestamp
 * and no reason - the same class of hole Task 2 closed on
 * `production_operations`. No screen ever called it: the Sizes tab reads with GET
 * and replaces the whole breakdown with POST, so this was a writable path into a
 * quantity that nothing in the product used.
 *
 * Leaving it exported would leave an unaudited quantity write reachable by anyone
 * holding an Owner session. `order_item_sizes.completed` becomes a figure derived
 * from the production ledger when sizes evolve into garment variants; until then
 * the whole-set POST above is the only way it changes.
 */
