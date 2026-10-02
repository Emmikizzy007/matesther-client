/**
 * PWA, branding and mobile-shell regression tests (Task 5).
 *
 * Two different kinds of assertion live here, and they are labelled as such:
 *
 *   BEHAVIOURAL - the real route handler or the real component runs, and the
 *   bytes/markup it produces are checked. The branding tests drive
 *   `src/app/api/branding/logo/route.ts` itself, with the real `sharp` and the
 *   real Drizzle layer, exactly as `tests/whatsapp-sharing.test.ts` does.
 *
 *   SOURCE CONTRACT - a handful of Task 5 fixes are pure CSS class strings and
 *   one manifest field. No unit test can observe `env(safe-area-inset-bottom)`
 *   or a 44px tap target without a real browser, which this suite deliberately
 *   does not require. Those few checks read the shipped source and assert the
 *   class is still there, so the fix cannot silently regress. They are the only
 *   assertions in the suite that inspect source text rather than behaviour.
 *
 * The point of the branding half is PROJECT_CONTEXT.md section 33: the logo must
 * be the Owner's own uploaded file, used exactly as provided, never recreated.
 * Test 9 is the one that enforces that - it uploads a real PNG and asserts the
 * bytes served back are byte-for-byte identical.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import manifest from "@/app/manifest";
import * as branding from "@/app/api/branding/logo/route";
import { InstallPrompt } from "@/components/InstallPrompt";
import { HOST, ORIGIN, createOwner, createStaff, createWorker } from "./support/harness";

/* ---------- helpers ---------- */

function request(method: string, path: string, cookie?: string, body?: BodyInit): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    // `cookie` from the harness is already a full `matesther_session=...` value.
    headers: { host: HOST, origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    body,
  });
}

async function body(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

function formWith(file: File): FormData {
  const form = new FormData();
  form.append("logo", file);
  return form;
}

/**
 * A real PNG of the given size.
 *
 * It carries an explicit 300 dpi density so that it is NOT a fixed point of
 * `sharp(x).png().toBuffer()` (measured: 13,188 bytes in, 12,665 bytes out). A
 * plain sharp-generated PNG re-encodes to byte-identical output, which would
 * make the byte-exactness test below pass even if the route silently re-encoded
 * the Owner's logo. (adaptiveFiltering:false was measured and does NOT change
 * the bytes; level-0 compression does, but an 873x641 RGBA image uncompressed is
 * ~2.24 MB and would trip the route's 2 MB upload limit.)
 */
async function png(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 10, g: 53, b: 32, alpha: 1 } },
  })
    .withMetadata({ density: 300 })
    .png()
    .toBuffer();
}

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

/* ---------- A. installability contract (real manifest module) ---------- */

test("the app declares itself installable as a standalone Matesther app", () => {
  const m = manifest();
  assert.equal(m.display, "standalone");
  assert.equal(m.start_url, "/login");
  assert.equal(m.scope, "/");
  assert.match(String(m.name), /Matesther/);
  assert.equal(m.theme_color, "#0a3520");
  assert.equal(m.background_color, "#071f13");
});

test("the installed-app icons come from the official branding endpoint", () => {
  const m = manifest();
  const sizes = (m.icons ?? []).map((i) => i.sizes).sort();
  assert.deepEqual(sizes, ["192x192", "512x512"]);
  // A hard-coded or generated image file would let a fabricated logo ship.
  for (const icon of m.icons ?? []) {
    assert.match(icon.src, /^\/api\/branding\/logo\?size=(192|512)$/);
    assert.equal(icon.type, "image/png");
  }
});

/* ---------- B. the official logo endpoint ---------- */

test("with no custom logo the endpoint serves the committed official mark, unmodified", async () => {
  // The official logo ships in the repository at public/matesther-logo.png.
  // While the Owner has not uploaded their own file, the endpoint must serve
  // exactly those committed bytes - not a placeholder, not a redraw.
  const bundled = readFileSync(join(process.cwd(), "public", "matesther-logo.png"));
  const res = await branding.GET(request("GET", "/api/branding/logo"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  const served = await body(res);
  assert.equal(served.length, bundled.length, "served fallback differs in size");
  assert.ok(served.equals(bundled), "the served fallback is not the exact committed file");

  // The PWA / favicon icon sizes must also work from the bundle, before any upload.
  const icon = await branding.GET(request("GET", "/api/branding/logo?size=192"));
  assert.equal(icon.status, 200);
  const meta = await sharp(await body(icon)).metadata();
  assert.equal(meta.width, 192);
  assert.equal(meta.height, 192);
});

test("an icon size the app does not produce is rejected", async () => {
  // The route answers 404 before it validates `size` when no logo exists yet, so
  // this needs a logo in place to reach the size check at all.
  const owner = await createOwner();
  await branding.POST(
    request("POST", "/api/branding/logo", owner.cookie, formWith(new File([new Uint8Array(await png(800, 600))], "m.png", { type: "image/png" })))
  );
  for (const bad of ["137", "0", "-192", "abc", "1920"]) {
    const res = await branding.GET(request("GET", `/api/branding/logo?size=${bad}`));
    assert.equal(res.status, 400, `size=${bad} should be rejected`);
  }
  // The four sizes the manifest and layout actually request must still work.
  for (const good of [48, 180, 192, 512]) {
    const res = await branding.GET(request("GET", `/api/branding/logo?size=${good}`));
    assert.equal(res.status, 200, `size=${good} should be served`);
  }
});

test("uploading the company logo is Owner-only", async () => {
  const owner = await createOwner();
  const manager = await createStaff(owner.cookie, {
    name: "PM Branding Probe",
    role: "PRODUCTION_MANAGER",
  });
  const worker = await createWorker(owner.cookie, { name: "Worker Branding Probe", specialty: "Tailor" });
  const workerLogin = await createStaff(owner.cookie, {
    name: "Worker Branding Probe",
    role: "WORKER",
    workerId: worker.id,
  });

  for (const account of [manager, workerLogin]) {
    const file = new File([new Uint8Array(await png(800, 600))], "logo.png", { type: "image/png" });
    const res = await branding.POST(request("POST", "/api/branding/logo", account.cookie, formWith(file)));
    assert.equal(res.status, 403, `${account.email} must not be able to replace the company logo`);
  }

  const anonymous = await branding.POST(
    request("POST", "/api/branding/logo", undefined, formWith(new File([new Uint8Array(await png(800, 600))], "l.png", { type: "image/png" })))
  );
  assert.equal(anonymous.status, 401);
});

test("an SVG is refused - the logo must be the original raster artwork", async () => {
  const owner = await createOwner();
  const svg = new File(
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>MATESTHER</text></svg>')],
    "approximation.svg",
    { type: "image/svg+xml" }
  );
  const res = await branding.POST(request("POST", "/api/branding/logo", owner.cookie, formWith(svg)));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not an SVG/);
});

test("an image too small for a phone home-screen icon is refused", async () => {
  const owner = await createOwner();
  const small = new File([new Uint8Array(await png(120, 120))], "tiny.png", { type: "image/png" });
  const res = await branding.POST(request("POST", "/api/branding/logo", owner.cookie, formWith(small)));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /512/);
});

test("an oversized upload is refused", async () => {
  const owner = await createOwner();
  const tooBig = new File([new Uint8Array(Buffer.alloc(2 * 1024 * 1024 + 1, 7))], "huge.png", { type: "image/png" });
  const res = await branding.POST(request("POST", "/api/branding/logo", owner.cookie, formWith(tooBig)));
  assert.equal(res.status, 400);
});

test("the logo that comes back is byte-for-byte the file the Owner uploaded", async () => {
  const owner = await createOwner();
  // Deliberately not square and not a round size, so any silent resize shows up.
  const original = await png(873, 641);

  // Self-check: if this ever becomes a re-encode fixed point again the test below
  // would be vacuous, so fail loudly instead of passing for the wrong reason.
  const reencoded = await sharp(original).png().toBuffer();
  assert.ok(
    !reencoded.equals(original),
    "the fixture PNG re-encodes to identical bytes, so this test could not detect tampering"
  );

  const upload = await branding.POST(
    request("POST", "/api/branding/logo", owner.cookie, formWith(new File([new Uint8Array(original)], "matesther-official.png", { type: "image/png" })))
  );
  assert.equal(upload.status, 200);

  const served = await branding.GET(request("GET", "/api/branding/logo"));
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.equal(served.headers.get("x-content-type-options"), "nosniff");

  const bytes = await body(served);
  assert.equal(bytes.length, original.length, "stored logo changed size");
  assert.ok(bytes.equals(original), "the served logo is not the exact uploaded file");
});

test("an OS icon request is a square PNG of the requested size", async () => {
  const owner = await createOwner();
  await branding.POST(
    request("POST", "/api/branding/logo", owner.cookie, formWith(new File([new Uint8Array(await png(873, 641))], "m.png", { type: "image/png" })))
  );
  for (const size of [48, 180, 192, 512]) {
    const res = await branding.GET(request("GET", `/api/branding/logo?size=${size}`));
    assert.equal(res.status, 200, `size ${size}`);
    assert.equal(res.headers.get("content-type"), "image/png");
    const meta = await sharp(await body(res)).metadata();
    assert.equal(meta.width, size);
    assert.equal(meta.height, size);
  }
});

/* ---------- C. install affordance ---------- */

test("no install button is offered until the browser itself offers one", () => {
  // Without `beforeinstallprompt` there is nothing to hand the user. Rendering a
  // button anyway would be a fake affordance that cannot install anything.
  const markup = renderToStaticMarkup(createElement(InstallPrompt));
  assert.equal(markup, "");
  assert.ok(!markup.includes("Install"));
});

/* ---------- D. mobile shell source contracts ---------- */

test("the app shell reserves the iOS home-indicator safe area", () => {
  const layout = source("src/app/(app)/layout.tsx");
  assert.match(layout, /pb-\[max\(1rem,env\(safe-area-inset-bottom\)\)\]/);
  const sidebar = source("src/components/Sidebar.tsx");
  // The drawer/desktop footer holds the user name and Sign out.
  assert.match(sidebar, /pb-\[max\(1rem,env\(safe-area-inset-bottom\)\)\]/);
  // statusBarStyle is black-translucent, so the header needs the top inset too.
  assert.match(sidebar, /pt-\[max\(0\.75rem,env\(safe-area-inset-top\)\)\]/);
});

test("the mobile menu toggle keeps a 44px tap target", () => {
  const sidebar = source("src/components/Sidebar.tsx");
  const toggle = sidebar.match(/onClick=\{\(\) => setOpen\(!open\)\}\s*\n\s*className="([^"]+)"/);
  assert.ok(toggle, "could not find the mobile menu toggle");
  assert.match(toggle[1], /h-11/);
  assert.match(toggle[1], /w-11/);
  assert.ok(!/p-1["\s]/.test(toggle[1]), "toggle is back to an under-sized tap target");
});

test("the login form keeps 16px inputs so iOS Safari does not zoom on focus", () => {
  const login = source("src/app/login/page.tsx");
  const inputClass = login.match(/const inputClass = "([^"]+)"/);
  assert.ok(inputClass, "could not find the login input class");
  assert.match(inputClass[1], /(^|\s)text-base(\s|$)/);
  assert.match(inputClass[1], /sm:text-sm/);
  assert.match(inputClass[1], /min-h-11/);
});

test("the standalone viewport keeps viewportFit:cover, which the safe-area padding relies on", () => {
  const layout = source("src/app/layout.tsx");
  assert.match(layout, /viewportFit: "cover"/);
  assert.match(layout, /themeColor: "#0a3520"/);
});
