import { NextResponse } from "next/server";
import { db } from "@/db";
import { orderItemSizes, orderItems, products } from "@/db/schema";
import { eq } from "drizzle-orm";
import { guard, OWNER, STAFF } from "@/lib/authz";

/**
 * Size breakdown per order item (S, M, L, XL, 4-5, 6-7 …)
 * so Matesther can track which sizes are finished and hand sizes to tailors.
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

    return NextResponse.json({
      item: {
        id: item.id,
        productName: product[0]?.name ?? "-",
        quantity: item.quantity,
      },
      sizes: rows.map((r) => ({
        id: r.id,
        size: r.size,
        quantity: r.quantity,
        completed: r.completed,
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
    await db.transaction(async (tx) => {
      await tx.delete(orderItemSizes).where(eq(orderItemSizes.orderItemId, itemId));
      for (const s of b.sizes) {
        if (!s.size) continue;
        await tx.insert(orderItemSizes).values({
          orderItemId: itemId,
          size: String(s.size).toUpperCase(),
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
