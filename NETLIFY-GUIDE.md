# Matesther: keep the prototype, launch a separate client app

This is a step-by-step guide for a **new client site**. Your existing prototype stays on its existing Netlify site and Supabase project. **Do not replace that site's GitHub repository, DATABASE_URL, or database.** Never run the full-setup/demo SQL on the client database; it contains sample data and a destructive reset.

## Before starting: understand what you're creating

| Prototype (keep it) | Client app (create separately) |
|---|---|
| Existing Netlify site and its existing `.netlify.app` URL | New Netlify site and a different `.netlify.app` URL |
| Existing Supabase project with sample records | NEW Supabase project, starting with zero orders and zero users |
| Existing GitHub repository | NEW private GitHub repository, e.g. `matesther-client` |
| Prototype sign-in from that database | Owner account and NEW password created during first-time setup |
| Optional: `demo.yourdomain.com` | `app.yourdomain.com` (your purchased domain) |

A domain is an address, **not** a separate database or server. Phone users install the client site at `app.yourdomain.com` as a PWA; there is no separate phone-app backend. Netlify provides HTTPS for the Netlify URL and, after DNS setup, for your domain.

## 1. Make a fresh copy of the client code

1. From this updated Arena code project, use **Download** and unzip it on your computer. Keep your old prototype repository untouched.
2. Save the original logo image from your chat message onto your computer (right-click the image → Save image as). **Do not save my former SVG; it has been removed from the client code.** You'll upload the original PNG via Settings after signing in.
3. On github.com, create a **new private repository** named `matesther-client`. Upload the contents of the unzipped project, including `src`, `public`, `deploy`, `package.json`, `package-lock.json`, `netlify.toml`, etc. The `src` folder must be at the root of that repository. You may use the GitHub web uploader or Git on your computer.
4. Do **not** upload `.env`, `.next` or `node_modules`. The project's `.gitignore` excludes them if you use Git. On the GitHub website, check that `.env` does not appear in the repository. `.env` may be hidden on your computer; it contains only the old sandbox's address and is not needed on Netlify.

**Important:** Changing this new GitHub repository should trigger a rebuild of only the NEW Netlify site. Do not push these client changes to the prototype repository.

## 2. Make a NEW Supabase project for client records

1. On supabase.com, keep your old prototype project. Choose **New project** and name the new one `Matesther Client`. Save the database password in a password manager.
2. Open **SQL Editor → New query** in **Matesther Client**, not the prototype project. Paste the full contents of `deploy/schema-only.sql` from the NEW GitHub repository and click **Run**. If Supabase displays a warning, read it and confirm you are in the **empty new project** before proceeding. The file explicitly enables RLS on Matesther tables and revokes access from Supabase's `anon` and `authenticated` API roles; the ERP's private Postgres connection still works. Never expose `DATABASE_URL` or a Supabase service key in browser code.
3. Verify in this NEW project's SQL Editor that its `organizations` and `users` tables exist and are **empty**. That's expected: the Owner account will be created on the website.
4. In the NEW Supabase project, click **Connect** and copy its **shared transaction pooler** connection string (normally port **6543**) for serverless hosting. Shared session pooler is normally **5432**. Do not change the port yourself; use the exact connection string provided by YOUR project. There is no need to add `pgbouncer=true`.
5. Replace the password placeholder in the copied string with your actual database password. If the password contains `@`, `:`, `#`, `/` or other URL-special characters, URL-encode those characters before pasting. Use `sslmode=require` to require encryption (append `?sslmode=require` if there are no existing query parameters, otherwise `&sslmode=require`). Keep the entire result secret.

**Do not run `deploy/full-setup.sql` on the client database.** It seeds demo people and orders. Do not run either file in the old prototype database while doing this setup.

## 3. Make a separate NEW Netlify site

1. In Netlify choose **Add new project/site → Import an existing project → GitHub**. Select the **new `matesther-client` repository**, not the prototype repository.
2. Netlify should auto-detect **Next.js** and use the settings from `netlify.toml` (build command `npm run build`, publish directory `.next`, Node 20). Do not choose a static-only deploy or drag only the `.next` folder to Netlify: this app needs server functions for the database and logins.
3. In the **NEW site's** Project configuration → Environment variables, set TWO values:
   - `DATABASE_URL` - the entire NEW Supabase connection string from step 2 (with your password, and SSL mode).
   - `MATESTHER_SETUP_KEY` - choose your own long, random private setup key (ideally 32+ characters). Save it in your password manager; it is *not* the Owner password. You'll enter it only once on the first-Owner setup screen. Do not add this key to GitHub or to the prototype Netlify site.
4. Deploy the NEW site. If you added either variable after the first build, trigger **Deploys → Trigger deploy → Deploy site** so the new build uses those values.
5. Open the NEW `.netlify.app` URL, not the old prototype URL. The login page should say **“Set up the client site.”** Enter Esther Adejugba (or the real owner's name), her email `estheradejugba@gmail.com`, **a NEW strong password that you choose**, and the private `MATESTHER_SETUP_KEY` you saved. Click **Create Owner account**; you'll be signed in. The old prototype password `owner123` will **not** be the client password.
6. If the page instead shows **“Sign in”**, your new database already has at least one user or this site is pointed at the old database. Check the new site's `DATABASE_URL` against the NEW Supabase project's Connect string before making changes. Do not reset an existing database to fix this; you may be looking at the prototype!
7. Go to **Settings → Business Profile** to confirm the contact details. Then **Settings → Original company logo → Upload original logo**; choose the PNG saved in step 1. The file is stored in the NEW Supabase project unchanged. Reload the website to update the sidebar and favicon. The phone icons are size-adjusted copies of that exact file, never redrawn artwork.
8. Add real school customers, products, workers and orders. Create Project Manager and Worker sign-in accounts under **Users**. When making a Worker account, its name must match their record under **Workers** so the worker sees their own jobs.

## 4. Buy/connect a domain (without losing the prototype)

1. Buy a domain from a registrar of your choice, e.g. `yourdomain.com`. You do **not** need to host the app or database at the registrar.
2. On the **NEW client Netlify site**, open **Domain management → Add a domain → Add a domain you already own** and add `app.yourdomain.com`.
3. Follow Netlify's **Pending DNS verification** instructions for your site. If your registrar manages DNS, create a **CNAME** record with host `app` pointing to the exact new site's `something.netlify.app` name **without** `https://`. Do not point it to the prototype site or to Supabase.
4. Wait for DNS and the HTTPS certificate to show active (minutes to as much as 24–48 hours). Netlify provisions HTTPS; you don't need to buy a separate certificate.
5. Keep the existing prototype on its original `.netlify.app` URL, or optionally attach `demo.yourdomain.com` to that OLD Netlify site as a separate CNAME. Use two different subdomains for two different Netlify sites. The prototype's Supabase data remains separate.
6. Confirm the NEW domain loads `/login` and `/api/health` shows an OK result before giving staff the URL. Install the phone app **from the final `https://app.yourdomain.com` address**, not from a temporary preview. Browser installations are tied to the domain where they were installed; users who installed the Netlify URL may need to reinstall from the custom domain.

## 5. Install on phones (PWA)

- **Android / Chrome or Edge:** visit your HTTPS app domain → browser menu → **Install app / Add to Home screen**. It opens in its own window with the uploaded logo as icon. Upload the logo *before* staff install for the correct icon.
- **iPhone / Safari:** visit the same domain in Safari → Share button → **Add to Home Screen** → Add. If you update the icon later, remove the old shortcut and install it again.
- A PWA is an installable website, not a Play Store / App Store download. **Production data needs internet access**; the app shows an offline message instead of caching private records on shared devices.

## Update an already-live client site with the letterheaded documents

If your client Netlify site and its Supabase project already contain real orders:

1. Make a backup or verify your usual backup first. Keep the prototype Supabase project untouched.
2. Open **the client site's Supabase project**, SQL Editor, and run **`deploy/upgrade-documents.sql`**. This creates only the new `delivery_lines` table and protects it with RLS. It does not wipe orders, payments, workers or deliveries. Do **not** run `schema-only.sql` or `full-setup.sql` against a populated project.
3. Push the updated app code to the **client GitHub repository** so the client Netlify site rebuilds. Check its deploy status is Published.
4. On the client site, go to Orders, open an order, then Payments and Packing & Delivery. Existing payment receipts now use the letterhead. Old deliveries with no per-garment breakdown print an honest summary. New deliveries save their garment and size rows and get a printable school delivery sheet.
5. Save the original Matesther logo image from your message as PNG/JPG/WebP. Owner signs in, goes to **Settings > Original company logo**, and uploads the original file. The customer sheets display the same saved logo. The system does not reconstruct the image from the letterhead photo.
6. Each document has **Print / Save as PDF**, **Share details**, and **Email details**. The browser email button drafts text, not a PDF attachment. To email the complete letterheaded sheet, save as PDF first, then attach the PDF manually. Do not email the private owner-only document URL to schools.

Both sheets include Matesther's printed motto: "perfecting the right stitches with efficiency, quality materials and timely delivery...". They use the business contact details saved in Settings, not the older address printed on the reference letterhead.

## 6. Two separate sign-ins; test before presenting

- **Prototype:** visit the OLD Netlify URL. Use an account that exists in the OLD database. If unchanged, the demo owner was `estheradejugba@gmail.com` with its demo password; do not reuse that password for clients.
- **Client site:** visit the NEW Netlify URL or `app.yourdomain.com`. Use the Owner email and **the new password chosen in step 3**. No one-tap demo buttons exist on the client site.
- The two sites will never share orders, passwords, receipts, workers or uploaded logos unless you deliberately point them at the same `DATABASE_URL` (don't).

## Troubleshooting checklist

- **“Couldn't reach the database”** on `/login`: schema-only SQL wasn't run in the NEW Supabase project, or `DATABASE_URL` belongs to the wrong project; check the project ref in the pooler username `postgres.<project-ref>`.
- **“First-time setup is locked”**: add `MATESTHER_SETUP_KEY` to the NEW Netlify site, redeploy and refresh.
- **“Sign in” appears instead of “Set up”**: users already exist in the connected project. Verify the URL and both projects before changing anything.
- **Build green, login fails**: check the *new* project's `users` table and the NEW Netlify site's environment variables; check Netlify Functions logs for server errors. Never post database passwords or setup keys in a public chat.
- **Logo missing**: first sign in as Owner on the NEW site, upload the original file in Settings, then refresh. Do not use the removed SVG as a replacement.
- **Installed app doesn't show the right icon**: upload the original PNG first, then remove/reinstall the phone shortcut from the final domain.
- **Updates not showing**: push to the new GitHub repo and check that the NEW Netlify site's latest deploy says Published. Do not run schema-only SQL again against an existing populated database.

## Reliability and costs (important)

The Netlify URL is persistent, unlike an Arena temporary preview, but **hosting is not automatically guaranteed always-on**: Supabase Free projects can pause for inactivity. For real Matesther finances and staff operations, check Supabase's paid plan, backups, usage limits and a restore procedure before relying on it day-to-day. Protect the Owner password and the Netlify/Supabase accounts with two-factor authentication. Keep regular database backups. Don't share `DATABASE_URL` or `MATESTHER_SETUP_KEY`.

Official docs: [Netlify Next.js](https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/), [Netlify external DNS](https://docs.netlify.com/manage/domains/configure-domains/configure-external-dns/), [Supabase connection strings](https://supabase.com/docs/guides/database/connecting-to-postgres), [Supabase project pausing](https://supabase.com/docs/guides/platform/free-project-pausing).
