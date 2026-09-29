# Update the existing Matesther client site without losing any records

Keep the current prototype Netlify site and its Supabase database untouched. Apply this only to the Supabase project used by your **client** Netlify site. There is **one safe SQL file**, not a replacement schema. Netlify deploys code, but it does not automatically update Supabase tables.

1. In Supabase, confirm the project name/reference belongs to the client Netlify `DATABASE_URL`. Make a database backup or confirm your restore plan before changing tables.
2. Open that project's **SQL Editor**, paste all of `deploy/upgrade-current-client.sql`, and Run. This upgrade is additive and repeatable. It creates any missing document/branding tables and adds nullable size, colour, archive date and per-job pay fields. It preserves existing users, workers, production history, receipts, orders and payments. It snapshots older piecework rates.
3. Check the verification query at the bottom of the SQL output. Compare staff, worker, order and production counts with what you expect. There should be no TRUNCATE or DROP.
4. Download this updated application code from Arena and push it to the **client** GitHub repository, not the prototype repository. Do not upload `.env`, `node_modules` or `.next`. Netlify rebuilds automatically from that repository.
5. In the client Netlify site's Deploys tab, wait until the new deploy says Published. Reload the client app. On your Owner dashboard, click Inspection Queue; you can inspect and approve exactly as the Project Manager can. The PM still cannot see company finances.
6. On an order, click **Start Production**. Pick garment, one size, colour, batch quantity, a Cutter and their agreed per-piece price, and optionally a Tailor and their separate per-piece price. Make another batch for another size or colour. For later stages use Active Production to assign a worker and agreed rate.
7. On **Users**, you can create a Worker login without first adding the production record. When ready, create that person under **Workers** with the same full name. Their jobs and earnings will appear. Existing Worker logins do not need to be deleted. A unique exact name match is required; the app never shows somebody else's jobs.
8. On **Workers**, unused people can be deleted. Anyone with a job or payment history is archived instead. Click **Show archived** to review or restore them. History is never deleted just to clean the active list.
9. The letterheaded payment receipts and delivery sheets remain available under Orders > Payments and Packing & Delivery. If the original Matesther logo is not yet uploaded, the Owner can upload it in Settings > Original company logo.

## One login for a cutter who also supervises production

Use **one existing email and password**. An inspector who also cuts uniforms needs one Project Manager account linked to their existing Cutter record, not a second Worker login.

1. As Owner, open **Workers** and confirm the person has an active Cutter profile. Optionally tick **Also inspects production work**.
2. Open **Users > Manage** on their current account. If they already sign in as Worker, change its role to **Project Manager**, select their Cutter profile under **Also works in the factory**, and save. If they already sign in as Project Manager, just select their Cutter profile and save. Their current email/password and cutter work history remain.
3. After signing back in, their sidebar has Production Dashboard, Assign Production, Inspection Queue, My Jobs, My Journal, My Earnings and My Profile. Their personal earnings show **only their own work**; company revenue, expenses, balances and reports stay Owner-only.
4. On **Assign Production**, select a school order, garment, size and colour, then agree the Cutter and Tailor rates for that batch. Use **Active Production** to assign a worker and rate to later stages. An Owner may do all of these tasks too.
5. In **Inspection Queue**, jobs are separated by school/order. Open one school and one job to record Approved, Rework and Rejected quantities. The signed-in inspector is recorded automatically. Add a reason for rework or rejection.

This particular release adds no new database fields beyond those already described in `deploy/upgrade-current-client.sql`. If that file has already been applied to the **client** Supabase project, push the updated code to the client GitHub repository and wait for Netlify to publish. If it has **not** been applied, make a backup and run it in the correct client Supabase project **before** deploying this code. It is designed to be repeatable and preserves business records.

**Never run `deploy/full-setup.sql` or `deploy/schema-only.sql` on an existing client project.** Those files are for brand-new empty databases; `full-setup.sql` contains a destructive demo-data reset.
