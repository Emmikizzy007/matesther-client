# MATESTHER ERP --- PROJECT CONTEXT

> **Purpose:** This file is the handoff/context document for any new AI
> coding agent working on the MATESTHER Uniform Manufacturing ERP.
>
> **Important:** This document records the project's requirements,
> decisions, development history, and what the previous Arena session
> reported. It is **not proof of the current codebase state**. The
> repository/GitHub code is the source of truth for what currently
> exists. Before changing anything, inspect the actual repository.

------------------------------------------------------------------------

## 1. Project identity

**Product:** MATESTHER --- Uniform Manufacturing ERP\
**Subtitle/description:** Uniform Production & Business Management
System

This is a real ERP for a Nigerian school-uniform manufacturing business.
It must feel like software designed around Matesther's actual factory
workflow, not a generic ERP with the Matesther name placed on it.

The core business problem is visibility:

**Customer → Order → Materials → Production → Labour → Inspection →
Packing → Delivery → Payment → Profit**

The system should help Matesther know: - what was ordered; - what
materials were bought and used; - where garments are in production; -
which worker handled each stage; - how many pieces were received,
completed, rejected or sent for rework; - what each order has cost; -
what the customer has paid and still owes; - what workers are owed; -
what the order actually made or lost; - and what has been delivered.

------------------------------------------------------------------------

# 2. Non-negotiable principles for a new AI agent

1. **The existing MATESTHER ERP repository is the project being continued. Do not rebuild it from scratch.**
2. **The test repository must be an exact working copy/fork/branch of the existing MATESTHER ERP at the point where the previous session stopped. Never create an empty ERP and start over.**
3. Treat the actual repository as the technical source of truth when code already exists.
4. Treat this document as the product/business requirements and historical decisions.
5. Do not blindly trust historical claims such as "implemented" or "tested"; verify them.
6. Prefer small, reviewable implementation steps over one enormous rewrite.
7. Do not remove meaningful production, inspection, payment, payroll, or business history merely to make the UI cleaner.
8. Never bypass role/security restrictions merely because the UI hides a button.
9. Server-side authorization is required for sensitive operations.
10. Use Nigerian business examples, Naira (₦), school-uniform terminology, and Matesther-specific workflows.
11. Keep the application usable on phones. Many workers and production staff will use mobile devices.
12. Do not expose owner-only financial information to Project Managers or Workers.
13. Do not put credentials, passwords, setup keys, or secrets into this context file.
14. Commit meaningful completed features with clear Git messages so the development history remains understandable and recoverable.

------------------------------------------------------------------------

# 3. Technology / architecture warning

The original specification requested:

-   React / Next.js
-   TypeScript
-   Tailwind CSS
-   Supabase / PostgreSQL
-   authentication
-   responsive UI
-   Netlify deployment

However, later Arena build logs describe a codebase using:

-   Next.js
-   TypeScript
-   PostgreSQL
-   Drizzle ORM
-   local `psql`
-   Drizzle migrations / generated SQL
-   server-side session authentication
-   Netlify deployment files

There is therefore an important architecture discrepancy:

> **Do not assume Supabase is still the active database architecture.
> Inspect `package.json`, database client code, Drizzle
> schema/migrations, environment variables, deployment SQL, and API
> routes before making database changes.**

The history also contains references to different Arena previews/builds
("my Matesther ERP" versus "Option A"). Do not assume two previews are
the same codebase. Identify the repository currently connected to the
project.

------------------------------------------------------------------------

# 4. Business production workflow

The final intended workflow is **8 production stages**:

1.  **CUTTING**
2.  **SEWING**
3.  **MONOGRAMMING / EMBROIDERY**
4.  **BUTTONHOLE**
5.  **BUTTON TACKING**
6.  **IRONING**
7.  **PACKING**
8.  **DELIVERY**

Stable stage identifiers used in the project history:

-   `CUTTING`
-   `SEWING`
-   `MONOGRAMMING`
-   `BUTTONHOLE`
-   `BUTTON_TACKING`
-   `IRONING`
-   `PACKING`
-   `DELIVERY`

A stage should track, where applicable: - assigned worker; - quantity
received; - quantity completed; - quantity rejected; - quantity sent for
rework; - expected completion date; - submission date; - inspection
date; - actual completion; - status; - notes; - inspection history.

### Production rule

A stage should not simply become "completed" and move forward without
the required inspection/approval.

Example:

100 submitted: - 90 approved - 7 rework - 3 rejected

Only approved pieces should move forward.

Production history should be preserved rather than overwritten.

------------------------------------------------------------------------

# 5. Order structure

An order belongs to a customer and contains one or more order
items/products.

Order information includes: - customer; - order number; - order date; -
due date; - products/uniform types; - quantities; - selling
price/revenue; - amount paid; - balance; - production progress; -
costs; - profit/loss.

The order detail page is one of the most important screens.

It should show: - customer and order information; - products/items; -
quantities; - revenue; - paid; - balance; - 8-stage production
timeline; - workers; - received/completed/rejected/remaining
quantities; - material costs; - labour; - transport; - packaging; -
other expenses; - total cost; - estimated profit; - profit margin.

------------------------------------------------------------------------

# 6. Production batches and progress

Production can contain multiple batches for an order/item.

Historical bug that was fixed: - Adding a new order item originally
caused a foreign-key error because the order-edit logic tried to
delete/recreate `order_items` referenced by `production_batches`. - The
intended fix was to update existing items in place, preserve referenced
items, delete only safe unreferenced items, and insert new items.

Another historical bug: - A newly created/cancelled batch with zero work
caused a completed order to display 50% progress because the progress
calculation averaged the completed batch with a zero-progress cancelled
batch.

The intended behavior is: - allow a removable/cancellable batch where
safe; - never delete production history that has meaningful
completed/approved work; - zero-work cancelled/removed production should
not incorrectly reduce the order's progress; - production progress
should reflect actual production, not an abandoned empty batch.

The repository should be inspected to see the exact current
implementation before modifying this.

------------------------------------------------------------------------

# 7. Roles and permissions

## OWNER

Full access.

Can: - manage orders; - customers; - products; - materials; - material
purchases/usage; - workers; - production; - inspections; - expenses; -
payments; - payroll; - profitability; - reports; - users; - settings; -
all Project Manager functions.

Owner is unrestricted by the Project Manager's production restrictions.

------------------------------------------------------------------------

## PROJECT MANAGER

Can manage production and inspection-related work.

Can generally: - view production; - assign permitted production work; -
update production; - inspect/approve/reject/rework; - view workers and
assignments; - use production dashboards/history.

Must **not** see: - company revenue; - company profit; - profit
margin; - material purchase prices; - total company expenses; - customer
payment balances; - owner financial reports; - payroll/owner financial
information.

------------------------------------------------------------------------

## WORKER

Can see their own assigned work and relevant personal information.

Should not see: - other workers' jobs; - company revenue; - company
expenses; - company profit; - owner dashboard; - unrelated worker
information.

Workers should be able to see: - their assigned jobs; - school/customer
context needed for the job; - garment/product; - size where relevant; -
quantity; - agreed payment/rate; - deadline; - status; - their
journal; - their earnings.

------------------------------------------------------------------------

# 8. IMPORTANT NEW WORKER ROLE MODEL

The last unfinished request before the Arena session ended was to change
the worker-role model.

### Previous limitation

A worker had a single specialty, and the worker interface mainly showed
work based on that one specialty.

### Desired model

A person may perform **multiple roles/specialties**.

For example, one person may be:

-   Project Supervisor
-   Cutter
-   Tailor
-   Inspector
-   Ironer

or any combination of roles they are actually qualified to perform.

The system should therefore support **multiple assigned worker roles**,
not a single specialty.

### Desired behavior

If a worker has: - Cutter - Tailor - Project Supervisor

they should see jobs assigned to them across all three functions.

They should NOT only see their Cutter jobs.

The worker's profile should clearly show their roles/specialties.

The assignment system should allow the appropriate role to be selected
when assigning work.

Do not assume one person = one production role.

### Real Matesther example

A single person may legitimately be all of the following at the same time:

- Cutter
- Inspection Officer
- Tailor / Sewer

This is not an exception that requires duplicate worker records. It is a normal
use case for the multi-role staff model.

The same person record must carry all applicable roles, while each assignment
identifies the role/function under which the person is performing the work.

Having an Inspection Officer role does **not** allow a person to inspect or
approve their own submitted production work where separation-of-duty rules
prohibit self-inspection. They may inspect eligible work performed by other
workers.


### Important security interaction

A Project Manager who is also a Cutter is a special case.

The previous Arena session implemented the following security rule:

> A Project Manager linked to a Cutter profile must not assign Cutting
> work to themselves or another Cutter and must not inspect/approve
> their own production work.

Reason: separation of duties and prevention of self-dealing/theft.

The Owner remains unrestricted.

A cutter-supervisor can still: - perform their own permitted Cutter
work; - submit their own work; - perform other permitted production
functions; - assign stages they are authorized to manage, subject to the
role rules.

Another authorized supervisor/Owner should inspect their own submitted
work.

This must remain enforced **server-side**, not merely through hidden UI
buttons.

------------------------------------------------------------------------

# 9. Inspection system

Inspection is a quality gate.

The inspection queue should show: - school; - order; - garment; -
stage; - worker; - submitted quantity; - approved quantity; - rejected
quantity; - rework quantity; - inspector; - date/status.

Workers who are also inspectors/cutters should be representable.

The previous implementation added an `is_inspector` concept and an
"Inspectors on duty" area.

However, the newer multi-role model should ultimately supersede a simple
single-specialty assumption:

> A worker should be able to have an Inspector role in addition to
> Cutter, Tailor, Project Manager, etc.

The self-inspection restriction remains mandatory.

------------------------------------------------------------------------

# 10. Sizes feature

The original schema did not include garment sizes. This was later
identified as an important factory requirement.

Matesther can give garments to tailors by size rather than assigning an
entire uniform order at once.

The intended feature is an order-item size breakdown.

Example:

  Size     Ordered   Completed
  ------ --------- -----------
  S             20          20
  M             30          12
  L             25           0
  XL            15           5

The system should make it easy to identify unfinished sizes.

Common sizes discussed: - S - M - L - XL - XXL - 3XL - 4-5 - 6-7 -
custom sizes

The historical implementation proposed/added: - an `order_item_sizes`
concept; - size quantity ordered; - size quantity completed; - size
tracker on order detail; - a size-management interface; - API support.

The exact current implementation must be inspected before adding to it.

### Future/ideal behavior

Sizes should eventually integrate naturally with production assignments
so that a tailor can be assigned: - School A - Secondary Shirt - Size
M - 30 pieces

instead of only: - School A - Secondary Shirt - 100 pieces.

Do not perform a huge database redesign without first understanding the
existing size implementation.

------------------------------------------------------------------------

# 11. Materials and inventory

Materials include things such as: - fabric; - thread; - elastic; -
buttons; - packaging materials; - other supplies.

Material tracking should cover: - current stock; - unit; - unit cost; -
stock value; - reorder level; - low-stock status; - purchases; -
usage; - stock adjustments; - order linkage.

Important business concern: Matesther wants visibility into material
leakage/theft.

Material usage should therefore be linked to the order/production
context wherever possible.

Material costs should contribute to order profitability.

------------------------------------------------------------------------

# 12. STAFF, SALARIED EMPLOYEES, AND TAILOR SUPPORT WORKERS

> **STATUS: IMPLEMENTED.** See section 36 for what was built, where it lives,
> and which regression tests guard it. The requirements below are kept unchanged
> as the specification.

Matesther has people who receive payment from the company but do not all
perform the normal 8-stage garment-production workflow. The ERP must not
assume that every person who receives money is a production worker.

## 12.1 Non-production / salaried staff

Examples include:

- Security staff
- Sales girls / sales staff
- Directors
- IT department staff
- Administrative staff
- Office staff
- Management
- Other salaried employees who do not directly perform production-stage work

These people must be representable in the staff/employee and payroll system
without being forced to have a production specialty such as Tailor, Cutter,
Ironer, etc.

A staff/employee record may contain:

- name
- phone/contact information
- department
- job title
- employment status
- payment type
- monthly salary
- overtime where applicable
- other approved earnings where applicable
- deductions where applicable
- amount paid
- outstanding balance
- payment history
- employment date where appropriate
- notes

Examples:

- Security → Security department → Monthly Salary
- Sales Girl → Sales department → Monthly Salary
- Director → Management → Monthly Salary
- IT Staff → IT department → Monthly Salary

These staff members must appear in Owner payroll and monthly payment reports
even when they have no production assignments.

## 12.2 Production workers versus staff positions

The system should distinguish between:

**Production roles** — roles that participate in production and can receive
production assignments.

**Staff/employee positions** — positions such as Security, Sales, IT,
Director, Administration, Management, and other non-production positions.

Do not force one person into one category. A person may legitimately have
both a staff position and one or more production roles if Matesther actually
uses that arrangement.

Do not create duplicate person records merely because a person has more than
one type of responsibility.

## 12.3 Tailor support workers / auxiliary production workers

Matesther also has people who help individual tailors with supporting garment
operations such as:

- weaving
- taping
- other supporting garment work

The business workflow is:

1. A tailor receives the main garment work.
2. The tailor gives some garments to a support worker.
3. The support worker performs the assigned supporting operation.
4. The support worker returns/submits the completed work to the tailor.
5. The tailor inspects the returned work.
6. The tailor approves acceptable work.
7. Rejected work can be sent for correction/rework.
8. The complete history remains in the ERP.

The system must record:

- assigning/parent tailor
- support worker
- order
- school/customer
- garment/product
- size where applicable
- supporting operation
- quantity given
- date assigned
- quantity returned/submitted
- quantity approved
- quantity rejected
- quantity sent for rework
- submission/inspection dates
- approving tailor
- notes
- complete history

The support worker must never approve their own work.

The tailor who assigned the support work should be able to inspect and approve
the returned work.

Support work should be traceable without incorrectly replacing the main
tailor's production responsibility.

## 12.4 Support-worker payment

A support worker may be paid according to the work performed. The payment
model must be configurable rather than assumed.

Possible payment types include:

- piecework
- per operation
- per garment
- monthly salary
- other approved payment arrangements

When payment is based on production, payable earnings should be calculated
from approved work according to Matesther's configured payment/rate rules,
not merely from work that was submitted.

Rejected or unapproved work must not automatically become payable.

The Owner must be able to see support-worker earnings and payment history.

## 12.5 Labour and accounting distinction

The ERP should distinguish, where appropriate:

- production labour
- tailor support-worker labour
- salaried/non-production staff
- overtime
- other staff payments

Production-related labour costs should contribute to order profitability where
the business rules allocate them to production.

General salaries for security, sales, IT, directors, administration, etc. should
remain visible as company payroll/expense costs and should not automatically be
attached to a specific production stage or order unless explicitly allocated.

## 12.6 Staff/payroll security

Only authorized users should see payroll and salary information.

- Owner → full payroll visibility
- Project Manager → no owner-only salary/payroll information
- Worker → only their own relevant earnings/payment information

One employee must not be able to view another employee's private salary or
payroll information.

These restrictions must be enforced server-side.

## 12.7 Staff-management UI

The Owner's worker/staff management interface should clearly show whether a
person is:

- Production Worker
- Production Support Worker
- Salaried/Non-Production Staff
- or a legitimate combination

The interface should make it possible to manage:

- staff category
- department
- job title
- production roles
- payment type
- rate/salary
- active/inactive status

Do not create duplicate person systems if the existing architecture can
represent these distinctions cleanly.

## 12.8 Implementation rule

Before implementing this requirement:

1. Inspect the existing worker/person model.
2. Inspect worker-role/profile linking.
3. Inspect production assignments.
4. Inspect inspection/approval records.
5. Inspect payroll/payment tables and APIs.
6. Inspect how approved piecework currently generates earnings.
7. Extend the existing architecture where practical.
8. Avoid destructive schema redesigns.
9. Preserve existing production and payroll history.

------------------------------------------------------------------------

# 33. Workers and labour


Worker information can include: - name; - phone; - roles/specialties; -
payment type; - rate; - assigned work; - production history; - earnings.

Payment types discussed include: - piecework; - monthly salary; -
overtime.

Historical Arena work added a Worker Payments/payroll area for the
Owner: - monthly worker breakdown; - piecework based on approved
pieces; - monthly salary; - overtime; - unpaid/paid/balance; - Pay
action; - overtime records; - payment history/month navigation.

The Project Manager and Worker should not receive owner-only payroll
information.

------------------------------------------------------------------------

# 33. LAST UNFINISHED REQUEST --- MONTHLY PAYMENT SHEET

> **STATUS: IMPLEMENTED** as the Owner-only `/payment-sheet/[month]` page backed
> by `GET /api/payment-sheet`. See section 36.

The final user instruction before the Arena session stopped requested:

> Add a printable page layout for the payment list after the end of
> every month because the payment sheet is sent to the bank so the bank
> can know how much is being paid for that month and how much is
> expected to be paid to each staff member.

This request was **not confirmed as implemented** before the session
ended.

Desired feature:

### Monthly Staff Payment Sheet

Owner-only page/report.

Select a month, e.g.: - September 2026

Show: - staff name; - role(s); - payment type; - basic salary/piecework
amount; - overtime; - total amount due; - amount already paid; -
balance; - payment status.

The page should have a clean **printable layout**, suitable for: -
printing; - saving as PDF; - sending to the bank.

Prefer a formal document layout with: - Matesther logo; - company
name; - month/year; - payment summary; - staff payment table; - total
payroll amount; - preparation/approval area if useful.

Do not expose this page to Project Managers or Workers.

------------------------------------------------------------------------

# 33. Receipts

A customer payment receipt was requested.

Desired behavior: - after a payment is recorded, a receipt is
generated; - receipt has a unique receipt number; - receipt is
accessible from the payment/order history; - receipt can be printed; -
receipt can be saved as PDF; - receipt contains Matesther branding; -
receipt contains customer/order/payment information; - receipt should
show amount paid and relevant balance.

Historical implementation reportedly added: - receipt page; - automatic
receipt number format such as `MTH-REC-0001`; - print/PDF support; -
receipt links from Payments and Order Detail; - receipt API.

Security was later tightened so receipt data requires an authenticated
Owner session rather than being exposed through an easily guessable
public URL.

Do not weaken that security.

------------------------------------------------------------------------

# 33. WhatsApp sharing --- LAST UNFINISHED REQUEST

The final user request also asked:

> Add a WhatsApp-share option to every document created so far, from the
> receipt to delivery and now the payment page.

This was **not confirmed as implemented before the Arena session
stopped**.

> **STATUS: IMPLEMENTED.** Sharing now exists on the payment receipt,
> the delivery document and the monthly payment sheet. See section 37.

Desired documents/pages should have a WhatsApp sharing action where
appropriate:

-   payment receipt;
-   delivery document;
-   monthly payment sheet/payment document;
-   other customer-facing printable documents where sensible.

Important: - WhatsApp sharing should not expose private company
information accidentally. - For customer-facing documents, sharing
should use the intended document/receipt content. - For owner-only
payroll/payment sheets, sharing should remain owner-only. - On phones,
use the WhatsApp share/deep-link mechanism where appropriate. - Provide
a sensible fallback such as "Copy link" or "Share" if WhatsApp is
unavailable.

Inspect the existing document routes/components before implementing.
(Done: `DocumentActions` was the single shared action bar behind all
three printables, so sharing was added there once rather than three
times.)

------------------------------------------------------------------------

# 33. Delivery documents

Delivery is the final production stage.

The system should retain: - order/customer; - items; - quantities; -
delivery status; - delivery information; - relevant dates; - delivery
record/history.

Delivery documents should be printable and, where appropriate, shareable
through WhatsApp.

Do not expose internal profit/cost information on a customer-facing
delivery document.

------------------------------------------------------------------------

# 33. Mobile / PWA requirements

The user wants the ERP to feel like an app on phones.

The desired approach is a **Progressive Web App (PWA)** rather than
immediately creating a separate native Android/iOS application.

The historical implementation reportedly added: - `manifest`; - service
worker; - installable app behavior; - offline shell; - Android/iOS "Add
to Home Screen" capability; - mobile-friendly layouts.

Important security consideration from the previous implementation: - do
not cache private orders/financial pages on shared phones.

The user specifically wants every page to be more mobile friendly.

Mobile priorities: - no unnecessary horizontal scrolling; - readable
cards; - comfortable tap targets; - forms that fit phone screens; -
modals that fit the viewport; - mobile sidebar that scrolls
independently; - readable KPI cards; - production/assignment pages
grouped instead of giant tables; - charts should remain usable on narrow
screens; - documents should fit printable/mobile previews.

> **STATUS: VERIFIED AND COMPLETED.** Every item in that list was checked
> against the code during Task 5. Most were already satisfied; four real
> gaps were found and fixed. See section 38 for what was already in place
> and what changed.

------------------------------------------------------------------------

# 33. Worker Assignments and Stage Ledger UI

The previous Arena session reorganized these because the old layouts
were overwhelming.

The intended UI pattern is a reusable **school → order → job** grouping.

Worker Assignments should: - group by school; - group within school by
order; - show compact job cards; - allow useful stage filters; - avoid a
giant wide table; - work well on mobile.

Stage Ledger should: - use the same school/order grouping; - default to
active stages; - allow completed/all filters; - preserve inspection
history and counts; - avoid sideways scrolling where possible.

A reusable component called `SchoolOrderGroups` was reportedly created
for this.

Verify it exists before recreating it.

------------------------------------------------------------------------

# 33. Navigation / pages

Original major pages:

-   Dashboard
-   Orders
-   Customers
-   Products
-   Production
-   Workers
-   Materials
-   Expenses
-   Payments
-   Reports
-   Settings

Later navigation included:

## Owner

**Overview** - Dashboard

**Business** - Orders - Customers - Products

**Production** - Production - Workers - Production History

**Inventory** - Materials - Material Purchases - Material Usage

**Finance** - Expenses - Payments - Profitability - Financial Reports -
Worker Payments/payroll

**Reports** - Production Reports - Order Reports - Financial Reports

**Administration** - Users - Settings

## Project Manager

-   Production Dashboard
-   Active Production
-   Inspection Queue
-   Production History
-   Workers
-   Worker Assignments
-   relevant production/profile functionality

## Worker

-   Dashboard
-   My Jobs
-   My Journal
-   My Earnings
-   Profile

With the new multi-role model, the Worker area should be based on **all
roles assigned to that worker**, not a single specialty.

------------------------------------------------------------------------

# 33. Dashboard expectations

## Owner dashboard

Should provide a business overview including: - active orders; - orders
in production; - due soon; - completed; - delayed; - revenue; -
expenses; - estimated profit; - outstanding payments; - material
costs; - production pipeline; - recent orders; - deadlines; - production
tasks; - low stock; - recent expenses; - recent payments; - payroll due
where implemented; - business growth where implemented.

Historical work added a Business Growth chart and Year Valuation card.

Do not blindly trust historical figures in the conversation. They were
demo/sandbox values and may not represent current data.

------------------------------------------------------------------------

## Project Manager dashboard

Focus on production: - jobs due today; - awaiting inspection; -
rework; - production pipeline; - worker activity; - inspection queue.

Do not show financial KPIs.

------------------------------------------------------------------------

## Worker dashboard

Focus on the worker's own work: - today's jobs; - school; - garment; -
size; - quantity; - payment; - deadline; - status; - earnings; - recent
jobs.

For multi-role workers, show work assigned under every role they have.

------------------------------------------------------------------------

# 33. Security model

A major security upgrade was implemented in the previous Arena session.

Historical reported features: - server-side sessions; - signed 7-day
session tokens; - session table; - cookie-based authentication; -
`/api/auth/me`; - logout destroys server session; - first-owner setup; -
password hashing; - login rate limiting; - role-based API
authorization; - protected API routes; - removal of one-tap demo
login; - no demo-password hints on production login; - origin checks for
state-changing requests.

The previous security test reportedly verified:

-   unauthenticated protected API → 401;
-   Owner → allowed;
-   Project Manager → production allowed, finance forbidden;
-   Project Manager cannot force Owner dashboard via URL;
-   Worker sees only own operations;
-   Worker cannot edit another worker's operation;
-   Worker cannot inspect;
-   Project Manager cannot create workers;
-   cutter-supervisor cannot assign Cutting to another Cutter;
-   cutter-supervisor cannot approve own work.

Preserve these protections.

Before changing authentication/authorization, inspect: -
`src/lib/authz.ts` - `src/lib/session.ts` -
`src/lib/request-security.ts` - middleware/auth routes - protected API
routes - role/profile linking.

------------------------------------------------------------------------

# 33. Demo data / deployment

Historical deployment guidance distinguished:

### Demo/presentation database

Can contain sample data.

### Production database

Should use schema-only setup and then create the first real Owner
account.

Do not wipe or replace real business data.

Before applying migrations or seed scripts to a live environment: -
inspect current schema; - make a backup/snapshot if appropriate; -
understand which environment is demo vs production; - use the
repository's current deployment instructions.

------------------------------------------------------------------------

# 33. Logo requirement

The Matesther logo provided by the user is the official logo.

Requirement:

> Use the uploaded image as the Matesther company logo. Do not recreate,
> redesign, or modify the logo. Use the image exactly as provided.

It should be used wherever the Matesther brand is shown, including: -
application header/sidebar; - login screen; - receipts; - printable
documents; - app/PWA branding where technically appropriate; -
favicon/browser icon.

The previous Arena implementation reportedly could not directly extract
the uploaded binary and therefore created an SVG approximation. That is
**not equivalent to the user's final requirement**.

If the exact original image file is available in the repository/project,
use it directly.

If it is not available, do not silently claim that a recreated SVG is
the exact original. Ask for/provide a way to add the original image
asset.

> **STATUS: THE OFFICIAL LOGO IS PRESENT AND IN USE.**
> The logo is used everywhere this section asks for - sidebar,
> mobile header, login screen and the printed letterhead (via
> `Letterhead`), plus the favicon, Apple touch icon and the PWA manifest
> icons. All of them point at one endpoint, `GET /api/branding/logo`.
>
> **The application does not read the logo from `public/` at all.** The
> original bytes live in PostgreSQL (`organizations.logo_data`) and are
> uploaded by the Owner through **Settings -> Branding**. `POST
> /api/branding/logo` accepts only a real PNG/JPEG/WebP at least
> 512 x 512 and under 2 MB, and explicitly rejects an SVG, so an
> approximation cannot be substituted for the original.
>
> The official mark the user provided is committed at
> `public/matesther-logo.png` (on `main` at `fd1cd40`; the working branch
> is cut from an earlier `main` commit, so it was brought across with one
> additive checkout). `GET /api/branding/logo` now serves those bytes as
> the fallback whenever the Owner has not uploaded their own file, so every
> slot shows the real logo with no database write. An Owner upload through
> Settings still wins. Nothing has been redrawn, traced or approximated.
> The gold "M" appears only while the image is loading.

------------------------------------------------------------------------

# 33. Historical feature additions

The Arena conversation reported implementing or discussing:

-   8-stage production workflow;
-   production board;
-   inspection queue;
-   production history;
-   worker assignments;
-   worker journal;
-   worker earnings;
-   owner payroll/worker payments;
-   profitability;
-   financial reports;
-   business growth chart;
-   order editing;
-   batch deletion/progress correction;
-   receipts;
-   sizes;
-   inspector/cutter support;
-   PWA;
-   logo integration;
-   server-side authentication;
-   role-based authorization;
-   origin/security checks;
-   mobile UI improvements;
-   school/order grouping;
-   cutter-supervisor separation of duties.

These are historical claims. Verify each against the repository.

------------------------------------------------------------------------

# 33. Database concepts from the original specification

The original specification described these core tables:

-   organizations
-   users
-   customers
-   products
-   orders
-   order_items
-   workers
-   production_batches
-   production_operations
-   materials
-   material_purchases
-   material_usage
-   expenses
-   payments
-   quality_checks
-   rework_records
-   packing_records
-   deliveries

Later work added/modified concepts such as: - sessions; - inspections; -
order item sizes; - worker-role/profile linking; - payroll/payment
records; - overtime; - receipts; - inspector assignment.

The exact current schema must be read from the repository/migrations.

------------------------------------------------------------------------

# 33. Sample business context

Historical sample data included Nigerian schools such as: - Osun Model
College - Victory International School - Christ Comprehensive College -
Redeemer's High School

Example historical order: - `ORD-2026-001` - Osun Model College - 500
uniforms - ₦2.5M revenue - ₦1.5M paid - ₦1M balance

These are demo examples only and should not be assumed to represent
current real business data.

------------------------------------------------------------------------

# 33. Quality / testing expectations

Before declaring a change complete, test at minimum:

### Build

-   type generation;
-   TypeScript;
-   production build;
-   application startup.

### Authentication

-   unauthenticated protected API;
-   Owner;
-   Project Manager;
-   Worker.

### Authorization

-   Owner-only routes;
-   PM production routes;
-   worker own-data restrictions;
-   self-inspection restriction;
-   cutter-supervisor assignment restriction.

### Production

-   create order;
-   edit order;
-   add order item;
-   remove safe order item;
-   start production;
-   assign work;
-   submit work;
-   inspect;
-   approve;
-   reject;
-   rework;
-   production history.

### Materials

-   purchase;
-   usage;
-   stock;
-   order cost.

### Payments

-   record payment;
-   receipt;
-   payment history;
-   monthly payroll/payment report;
-   printable document.

### Documents

-   receipt print;
-   delivery print;
-   payment sheet print;
-   WhatsApp share/fallback.

### Mobile

Test narrow phone dimensions for: - login; - dashboard; - orders; -
order detail; - production; - inspection; - assignments; - materials; -
payments; - worker pages; - printable/shareable documents.

------------------------------------------------------------------------

# 33. The exact unfinished work from the previous Arena session

The session stopped immediately after the user requested these three
things:

## A. Multi-role workers --- DONE (section 36)

Allow a worker to be assigned multiple roles/specialties, such as: -
Project Supervisor - Cutter - Tailor - any other production role.

Their work area should show all jobs assigned to them across all roles.

## B. Monthly bank payment sheet --- DONE (section 36)

Add a printable monthly payment list showing how much is expected to be
paid to each staff member, suitable for sending to the bank.

## C. WhatsApp sharing --- DONE (section 37)

Add WhatsApp sharing to the documents created so far: - receipts; -
delivery documents; - payment page/payment document; - other appropriate
customer-facing documents.

These three requests are the **starting point for the next development
session**.

> **STATUS: ALL THREE NOW COMPLETE** (A and B in section 36, C in
> section 37). This list is historical; it is no longer the starting
> point for the next session.

------------------------------------------------------------------------

# 33. Recommended next-agent workflow

When a new AI agent starts:

### Step 1 --- Inspect repository

Do not change anything yet.

Identify: - framework/version; - package manager; - database/ORM; -
schema; - migrations; - authentication; - role model; - worker model; -
production APIs; - document/receipt routes; - payment/payroll routes; -
PWA files; - logo files; - current tests.

### Step 2 --- Map this context to the actual code

Create a short internal checklist:

-   What exists?
-   What exists partially?
-   What is missing?
-   What contradicts this historical document?
-   What is already implemented better than the old logs describe?

### Step 3 --- Handle the three unfinished requests

Implement multi-role workers first because it affects assignments and
worker visibility.

Then implement: - monthly printable bank payment sheet; - WhatsApp
sharing.

### Step 4 --- Preserve security

Run authorization tests after the multi-role changes.

### Step 5 --- Validate

Run: - typegen; - tsc; - build; - startup; - role/security regression
tests; - document generation tests.

### Step 6 --- Do not blindly modify production

If an existing repository is connected, preserve its existing functionality and work incrementally; if it is new/empty, create the project there.

------------------------------------------------------------------------

# 33. Safe development strategy

The purpose of the separate test repository is **safety**, not to create a
second ERP from scratch.

The correct relationship is:

**CURRENT MATESTHER ERP**
→ make an exact working copy/fork/branch at the current stopping point
→ **`matesther-erp-test`**
→ new AI coding session continues unfinished work there
→ test/review/commit
→ only proven changes are moved back to the real repository

### Required rules

1. Keep the current real MATESTHER ERP repository as the protected source
   project.
2. Create `matesther-erp-test` (or an equivalent test repository) **from the
   current existing MATESTHER ERP**, including its current codebase and
   relevant Git history.
3. Do not initialize the test repository as a blank project.
4. Do not ask the new AI agent to recreate the ERP.
5. Do not change frameworks, databases, architecture, or folder structure
   merely because this is a test repository.
6. The test repository should initially represent the same application state
   as the current real repository.
7. Give the new agent this `PROJECT_CONTEXT.md`.
8. Tell the new agent explicitly that it is taking over an existing project
   whose previous coding session stopped before the listed unfinished work.
9. Let the new agent inspect the copied repository and Git history, identify
   the exact stopping point, and continue from there.
10. Review the agent's changes and commits in the test repository before
    applying them to the real repository.
11. Test the completed changes, especially database migrations, permissions,
    multi-role workers, production/inspection separation of duties, payroll,
    documents, and WhatsApp sharing.
12. Do not copy untested database migrations or production data blindly into
    the real environment.
13. Never use the test repository as an excuse to discard or rewrite working
    MATESTHER features.

### The test repository is a safety copy, not a second product

The agent must understand:

> `matesther-erp-test` is a temporary/safe development copy of the existing
> MATESTHER ERP. It is not a new application and must not be rebuilt from
> zero.

------------------------------------------------------------------------

# 34. Suggested first message to the new AI coding agent

Use the following as the first message in the new coding/Agent session:

> You are taking over an **existing MATESTHER Uniform Manufacturing ERP**
> project from a previous coding session.
>
> **This is a continuation, not a rebuild.**
>
> The repository you are connected to is a **test copy/fork/branch of the
> existing MATESTHER ERP**. It was created from the current project so that
> you can safely continue development without risking the original.
>
> ## ABSOLUTE RULES
>
> - Do NOT create a new ERP from scratch.
> - Do NOT initialize a blank MATESTHER project.
> - Do NOT create a different architecture.
> - Do NOT replace the existing database/ORM/framework.
> - Do NOT create duplicate versions of features that already exist.
> - Do NOT throw away working code.
> - Do NOT redesign the whole application simply because you are starting a
>   new coding session.
> - Do NOT create another test project inside this test project.
>
> `matesther-erp-test` is only a **safe working copy of the existing ERP**.
> Your job is to continue the existing implementation from where the previous
> session stopped.
>
> ## FIRST: UNDERSTAND THE EXISTING PROJECT
>
> Read `PROJECT_CONTEXT.md` completely.
>
> Then inspect the actual repository and Git history before making changes.
>
> The repository is the technical source of truth for what currently exists.
> `PROJECT_CONTEXT.md` contains business requirements, historical decisions,
> and the previous session's unfinished work.
>
> Determine:
>
> 1. What the previous session already implemented.
> 2. What is partially implemented.
> 3. What remains unfinished.
> 4. What the last meaningful commits/changes were.
> 5. Which of the historical claims in `PROJECT_CONTEXT.md` are confirmed by
>    the current code.
> 6. The exact next implementation step.
>
> Inspect the existing:
>
> - framework and package manager
> - database and ORM
> - schema and migrations
> - authentication/session system
> - authorization/security utilities
> - user/staff/worker models
> - worker-role relationships
> - production assignments
> - inspection system
> - payroll/payment system
> - receipts and delivery documents
> - WhatsApp/document sharing implementation, if any
> - PWA/mobile implementation
> - logo/branding assets
> - tests
> - deployment configuration
>
> **Do not make destructive changes while figuring this out.**
>
> ## CONTINUE THE EXISTING WORK
>
> The previous session stopped around three unfinished areas:
>
> ### 1. Multi-role staff/workers
>
> A single person can legitimately have multiple roles.
>
> Real Matesther examples include:
>
> - Cutter + Inspection Officer + Tailor/Sewer
> - Cutter + Project Supervisor
> - Tailor + Inspector
> - any other legitimate combination
>
> Do NOT create duplicate worker/person records just because a person has
> multiple roles.
>
> One person record should have multiple assigned roles/specialties, and
> production assignments should identify the relevant function/role.
>
> A multi-role worker's My Jobs/dashboard must show all eligible jobs assigned
> to them across their roles.
>
> **Critical security rule:** having an Inspection Officer role does not allow
> a worker to inspect/approve their own submitted work where separation of
> duties prohibits self-inspection.
>
> Preserve the existing cutter-supervisor rules and enforce them server-side.
>
> ### 2. Monthly bank payment sheet
>
> Implement the unfinished Owner-only monthly payment sheet.
>
> It should support:
>
> - selected month/year
> - staff name
> - role(s)
> - department where applicable
> - payment type
> - basic salary/piecework
> - overtime
> - total amount due
> - amount already paid
> - balance
> - payment status
> - total payroll
>
> It must have a clean printable layout suitable for printing, saving as PDF,
> and sending to the bank.
>
> Do not expose private payroll information to Project Managers or Workers.
>
> ### 3. WhatsApp sharing
>
> Continue the unfinished WhatsApp-sharing work for appropriate documents,
> including:
>
> - customer payment receipts
> - delivery documents
> - payment documents/pages where appropriate
> - other suitable customer-facing documents
>
> Never expose private payroll/company financial information through an
> insecure public link.
>
> Use an appropriate WhatsApp share/deep-link mechanism where possible and
> provide a safe fallback such as Share or Copy Link where appropriate.
>
> ## STAFF AND PAYROLL REQUIREMENTS
>
> Remember that not everyone who is paid by Matesther is a production worker.
>
> The existing system must support:
>
> - production workers
> - production support workers
> - salaried/non-production staff
> - multi-role workers
> - overtime
> - piece-rate earnings
> - other configured payment arrangements
>
> Non-production salaried employees such as security, sales, directors,
> IT/admin/office staff, and management must not be forced to have production
> specialties.
>
> Production support workers may perform operations such as weaving/taping
> for a tailor. Their work must go through assignment → submission →
> inspection → approval/rejection/rework, and they must not approve their own
> work.
>
> Production-based earnings must be based on approved work, not merely
> submitted work.
>
> ## DEVELOPMENT METHOD
>
> Work incrementally:
>
> 1. Inspect existing implementation.
> 2. Identify the next unfinished feature.
> 3. Implement it in the existing architecture.
> 4. Test it.
> 5. Check authorization/security.
> 6. Check database/migration safety.
> 7. Run type checks/build/tests as applicable.
> 8. Commit meaningful completed work to Git.
> 9. Continue to the next unfinished feature.
>
> Preserve existing production history and business data.
>
> Do not make destructive schema changes without understanding existing
> migrations and data.
>
> Do not stop at an explanation of what should be built. Actually implement
> the next required feature.
>
> ## FINAL INTENT
>
> You are **taking over the old MATESTHER ERP development session**.
>
> The correct mental model is:
>
> **existing MATESTHER ERP → exact test copy → inspect current state → continue
> unfinished work → test → commit → review → later move proven changes back**
>
> **CONTINUE THE PROJECT. DO NOT RECREATE THE PROJECT.**

------------------------------------------------------------------------

# 35. Immediate action after setting up the test repository

The human/developer should:

1. Create the test repository as an exact copy/fork/branch of the current
   MATESTHER ERP.
2. Verify that the existing application runs before giving it to the new
   coding agent.
3. Add this `PROJECT_CONTEXT.md` to the test repository.
4. Start the new coding session in that test repository.
5. Paste the prompt in Section 34.
6. Let the agent inspect the current state and continue from the previous
   stopping point.
7. Review each meaningful Git commit before moving proven changes to the
   original MATESTHER repository.

**Do not start from an empty repository. Do not ask the agent to rebuild
MATESTHER.**

------------------------------------------------------------------------

# 36. IMPLEMENTED: support work, salaried staff and the monthly payment sheet

Built on top of the existing architecture. Nothing was rebuilt, no table was
dropped, and no existing column changed meaning.

## 36.1 What exists now

**Tailor support work** - `support_assignments` and `support_inspections`
(`drizzle/0005_support_work_and_payroll.sql`).

- A tailor hands weaving, taping or other supporting work to a helper through
  **Production > Support Work** (`/api/support-work`).
- The parent `production_operations` row stays the tailor's. The support row
  links to it for traceability and never replaces it, so support work does not
  inflate the parent stage.
- The helper submits completed pieces; the tailor who handed it out inspects
  and approves. Each pass is a new `support_inspections` row, so rework and
  rejection history is preserved rather than overwritten.
- **A support worker can never approve their own work.** The check is on
  identity, not on login role, so it also holds for a supervisor whose own
  worker record did the work.
- Payable earnings reuse `@/lib/job-pay`: approved pieces x the rate agreed for
  that work, snapshotted on the inspection. Submitted, reworked or rejected work
  is never payable.

**Salaried / non-production staff** - no new table.

- `workers.department` and `workers.job_title` were added, and the role
  vocabulary gained the staff positions Security, Sales, IT, Administration,
  Management, Director and Office Staff, plus `Support Worker`.
- `workers.specialty` is unchanged and may hold a staff position, so a security
  guard is no longer forced to be a "Tailor". A person who is both a Tailor and
  in Sales is one record holding both roles - never two people.
- Their category (Production Worker / Support Worker / Salaried staff) is
  **derived** from their roles, never stored, so it cannot drift.

**Payroll** - `src/lib/payroll.ts`, `/api/payroll`.

- Each row now separates: salary, production piecework, support piecework,
  overtime, other approved payments, total due, paid, balance, and a payment
  status (`UNPAID` / `PARTIAL` / `PAID` / `NOTHING_DUE`).
- "Other approved payments" reuse `worker_overtime` with
  `category = 'OTHER'` rather than adding a parallel table.
- `worker_payments` gained `support_amount`, `other_amount`, `reference` and a
  unique `idempotency_key`. The unique index is what makes a double payment
  impossible; rows with no key stay `NULL` so legitimate part payments are
  unaffected. Payments are still only ever inserted - never updated or deleted.
- The headline `totals` object keeps its original `{due, paid, balance}` shape.
  The new detail is returned alongside it as `breakdown`.

**Monthly bank payment sheet** - `/payment-sheet/[month]` + `GET
/api/payment-sheet`.

- Owner-only. Project Managers and Workers are refused by the API, and the page
  is useless without it.
- Letterheaded printable layout reusing the existing `Letterhead` and
  `DocumentActions` components: staff name, roles, position, pay type, salary,
  piecework, support piecework, overtime, other, total due, paid, balance,
  status, bank reference, column totals, and a prepared/approved signature area.

## 36.2 Security

- `GET /api/payroll`, `POST /api/payroll` and `GET /api/payment-sheet` are
  `OWNER`-only, enforced server-side.
- A Worker sees only their own support work and their own earnings; the support
  endpoints filter by the linked worker profile.
- Separation of duty is enforced on the server for support inspections, exactly
  as it already was for stage inspections.

## 36.3 Regression coverage

`tests/support-payroll.test.ts` (18 tests) covers approved-only support pay, the
self-approval ban, assignment and history preservation, salaried staff, the
payroll breakdown and status, Owner-only access, and duplicate-payment
prevention. Every control is **mutation-tested**: removing each guard was shown
to fail exactly the intended test and nothing else. See `tests/README.md`.

Total suite: **85 tests, all passing.**

## 36.4 Deployment

Run `deploy/upgrade-support-payroll.sql` in the client project's SQL Editor,
check its verification query, and only then deploy the code. SQL first, code
second. It is additive and repeatable, and is schema-identical to
`drizzle/0005_support_work_and_payroll.sql`. See `deploy/UPDATE-INSTRUCTIONS.md`.

## 36.5 Known limitations

- Support work is deliberately **not** allocated to order profitability. Section
  12.5 asks for that distinction; the amounts are recorded and reported in
  payroll, but the profitability report was left untouched.
- ~~WhatsApp deep-link sharing is still not implemented.~~ **Superseded by
  section 37** --- the sheet now has a WhatsApp action, but as the
  Owner-only payroll document it never embeds a phone number.
- `deploy/schema-only.sql` and `deploy/full-setup.sql` were **not** updated for
  these tables. They remain for brand-new empty databases only, and
  `full-setup.sql` still contains a destructive demo-data reset.

------------------------------------------------------------------------

# 37. IMPLEMENTED: WhatsApp sharing on customer-facing documents

Built on top of the existing document components. No table changed, no
migration was created, no API route was added and no existing action was
removed.

## 37.1 What exists now

The receipt, delivery and monthly-payment-sheet pages all already rendered
one shared action bar, `src/components/documents/DocumentActions.tsx`.
Sharing was added **there, once**, so all three documents inherited it ---
nothing was duplicated and no document got its own bespoke share UI.

A new pure helper module, `src/lib/whatsapp.ts`, does the only new
computation:

- `whatsappNumber(raw)` normalises a Nigerian number to `234XXXXXXXXXX`
  and **returns `null` for anything it will not resolve confidently**
  (blank, too short, or a foreign number it would have to guess at).
- `whatsappMessage(parts)` joins the supplied document text and trims it
  to 1200 characters.
- `whatsappHref(message, number)` returns `https://wa.me/<number>?text=...`
  when a number is known, and `https://wa.me/?text=...` when it is not.

The action is a plain anchor (`<a href>`, `target="_blank"`,
`rel="noreferrer noopener"`), not a script-driven handler. That is
deliberate: on a phone the operating system hands the `wa.me` URL to the
installed WhatsApp app, on a desktop browser it opens WhatsApp Web, and
with JavaScript disabled the button still works.

**Fallback when WhatsApp is unavailable.** A `wa.me` link with no phone
number opens WhatsApp's own contact picker rather than failing, so an
unusable or absent customer number degrades to "choose a contact" instead
of opening a chat with the wrong person. The pre-existing `Share`
(Web Share API / clipboard) and `Email` actions are untouched and remain
the route for anyone without WhatsApp. The button reads `WhatsApp school`
only when a number actually resolved, and plain `WhatsApp` otherwise.

## 37.2 What each document shares

| Document | Route | Number embedded |
| --- | --- | --- |
| Payment receipt | `/receipt/[id]` | the customer's own number |
| Delivery document | `/delivery/[id]` | the customer's own number |
| Monthly payment sheet | `/payment-sheet/[month]` | **never** --- marked `sensitive` |

`customer.phone` was already returned by `GET /api/receipts` and
`GET /api/deliveries`, and already declared by both page types, so no API
change and no new data exposure were needed.

## 37.3 Security

- **No private data leaves the server.** The shared text is only what was
  already printed on the document the Owner is looking at.
- **No application URL is ever placed in a shared message.** Every
  document page requires an Owner session, so a link to it would be
  useless to a recipient and a needless leak of the internal host.
- **The payment sheet never embeds a phone number.** It is marked
  `sensitive`, so it always degrades to the contact picker and renders a
  warning that it contains confidential salary information and that no
  recipient was chosen. Its route stays `guard(req, OWNER)`.
- **Authorisation is unchanged.** `GET /api/receipts`, `GET /api/deliveries`
  and `GET /api/payment-sheet` are still Owner-only server-side. Nothing
  here relies on the frontend hiding or disabling a button --- the tests
  assert the API returns 403 regardless of what the page renders.
- `rel="noreferrer noopener"` stops the internal host being sent to
  WhatsApp as a referrer and blocks the new tab reaching back into the
  opener.

## 37.4 Regression coverage

`tests/whatsapp-sharing.test.ts`, 15 tests. It renders the **real**
`DocumentActions` component with `renderToStaticMarkup` and asserts on the
actual markup, and it calls the real receipt/delivery/payment-sheet routes
for the authorisation half. Each control was mutation-tested:

| Mutation | Tests that failed | Everything else |
| --- | --- | --- |
| Let the payment sheet embed a customer phone number | `whatsapp-sharing` 11 only | all 99 others passed |
| Make `whatsappNumber` guess on unresolvable numbers | `whatsapp-sharing` 2 and 10 only | all 98 others passed |
| Drop `noreferrer` from the anchor | `whatsapp-sharing` 8 only | all 99 others passed |
| Widen `GET /api/receipts` from `OWNER` to `STAFF` | `whatsapp-sharing` 14 only | all 99 others passed |

## 37.5 Known limitations

- **Sharing has not been exercised on a real handset.** The generated
  `wa.me` URLs are asserted in tests, but no device or WhatsApp account
  was available in this environment to confirm the hand-off. The URL
  format follows WhatsApp's published `wa.me` scheme.
- **The number is used as stored.** If a customer's `phone` holds a
  Nigerian number in a form the helper cannot resolve, the action falls
  back to the contact picker rather than guessing. Fixing the stored
  number is a data-entry task, not a code change.
- **Only the three existing printables have the action.** Section 33
  mentions "other customer-facing printable documents where sensible";
  there are no others --- a `find` over `src/app` for pages outside
  `(app)` returns exactly these three.
- **Message content is the plain document text**, not a PDF or image.
  WhatsApp deep links cannot attach a file, so the recipient gets the
  details as text and the Owner can still use Print/Email for the PDF.

------------------------------------------------------------------------

# 38. IMPLEMENTED: UI, PWA and mobile polish (Task 5)

No table changed, no migration was created, no API route was added, and no
authorization rule was touched. Four real gaps were found and fixed; most
of what section 33 asks for was already in place and was verified rather
than rebuilt.

## 38.1 Verified as already implemented (do not redo)

Checked against the code, not assumed:

- **PWA core** - `src/app/manifest.ts` (standalone, `start_url: /login`,
  scope `/`, brand colours), `public/sw.js`, `public/offline.html`, and the
  service-worker registration in `src/app/layout.tsx`.
- **Offline safety** - `sw.js` caches only `/_next/static/` and
  `offline.html`. It never caches an API response, a document or a
  dashboard, which is what section 33's "do not cache private
  orders/financial pages on shared phones" requires.
- **Mobile sidebar** - the drawer already scrolls independently
  (`min-h-0 flex-1 overflow-y-auto overscroll-contain`), closes on Escape,
  and locks body scroll while open.
- **Modals** - the shared `Modal` is already a bottom sheet on phones
  (`items-end sm:items-center`, `max-h-[96dvh]`, `overscroll-contain`), and
  already handled the bottom safe area.
- **Tap targets and forms** - the shared `inputCls` and `Btn` are both
  `min-h-11` (44px), and `inputCls` is `text-base` on phones so iOS does
  not zoom on focus. 229 call sites use it.
- **Grouped pages** - `SchoolOrderGroups` exists and is used by both
  Worker Assignments and the Stage Ledger, so neither is a wide table.
- **Charts** - all charts are CSS percentage-width bars, so they are fluid
  at any width; no chart library is installed.
- **Print** - `globals.css` already has `@page { size: A4 portrait }`,
  `print-color-adjust: exact`, `break-inside: avoid` on rows and
  `table-header-group` so long tables repeat their header.
- **Navigation** - the sidebar groups match section 33 exactly for Owner,
  Project Manager and Worker.

## 38.2 What changed

Five changes, all additive:

1. **Safe-area insets.** `layout.tsx` sets `viewportFit: "cover"` and
   `appleWebApp.statusBarStyle: "black-translucent"`, which means content
   extends under the status bar and the home indicator, but only the Modal
   accounted for it. The app shell, the mobile top bar, the drawer header
   and the sidebar footer now reserve the correct inset. Each uses
   `max(<old padding>, env(safe-area-inset-*))`, so on a desktop browser -
   where the insets are 0 - the padding is exactly what it was before.
2. **Mobile menu toggle tap target.** It was `p-1` around a 24px icon,
   about 32px, while the drawer's close button right beside it was already
   `h-11 w-11`. The toggle now matches it, and gained `aria-expanded`.
3. **Login form on iOS.** The login page defined its own input class with
   `text-sm`, which makes iOS Safari zoom the page on focus. It now
   follows the shared convention: `text-base sm:text-sm` plus `min-h-11`.
   This was the only page in the app not using that convention.
4. **Install affordance.** Section 33 lists installable app behaviour and
   Android/iOS "Add to Home Screen" as requirements, but nothing handled
   `beforeinstallprompt`. New `src/components/InstallPrompt.tsx` shows the
   browser's own prompt from the sidebar, and renders nothing at all until
   the browser fires that event - so on iOS Safari, or any browser that
   does not offer it, there is no fake button that cannot install anything.
5. **Official logo fallback.** `GET /api/branding/logo` now falls back to
   the committed `public/matesther-logo.png` whenever no Owner upload
   exists (section 38.3), so the real mark is in use everywhere without
   touching the database.

## 38.3 The official logo

Found and wired in. The official mark is `public/matesther-logo.png` -
a 1254 x 1254 PNG, committed to `main` at `fd1cd40`. It exists there but not
in this working branch (the branch is cut from an earlier `main` commit), so
it was brought across with the single additive command
`git checkout origin/main -- public/matesther-logo.png`.

One additive change connects it to the machinery every slot already used:
`GET /api/branding/logo` returns the bundled file when the Owner has not
uploaded their own logo, and the upload still takes precedence. No component
changed, no database write, and the file is served byte-for-byte.

## 38.4 Security

No authorization, session or origin check was modified. The branding
endpoint is the only API the new tests touch, and its existing rules were
verified rather than changed: the logo upload stays Owner-only, the GET
stays public but only ever returns branding, and `no-store` plus
`X-Content-Type-Options: nosniff` are still set. `InstallPrompt` defers to
the browser's own install consent and cannot install anything silently.

## 38.5 Regression coverage

`tests/pwa-branding.test.ts`, 15 tests, taking the suite to 115. The
branding tests drive the real route with the real `sharp` and the real
Drizzle layer. The suite is 100 tests of Tasks 1-4 plus these 15, and all
100 pre-existing tests still pass unchanged.

Two notes on the new tests:

- **The byte-exactness test initially passed for the wrong reason.** A
  sharp-generated PNG re-encodes to byte-identical output, so a mutation
  that re-encoded the Owner's logo on the way out was invisible. The
  fixture now carries a 300 dpi density so re-encoding changes the bytes,
  and the test asserts that fact about itself first, so it cannot silently
  become vacuous again. (Level-0 compression also works but makes an
  873x641 image ~2.24 MB, over the route's 2 MB limit.)
- Four of the fifteen tests are **source-contract** checks: they read the
  shipped file and assert a CSS class is still present. `env(safe-area-
  inset-bottom)` and a 44px tap target cannot be observed without a real
  browser, which this suite deliberately does not need. They are labelled
  as source contracts in the file header rather than passed off as
  behavioural tests.

## 38.6 Deployment

No migration. No SQL. No schema change - `drizzle-kit generate` reports no
drift. Deploying Task 5 is a code deploy only.

## 38.7 Known limitations

- **Not verified on a real handset.** The safe-area and tap-target fixes
  follow the documented CSS and are asserted in the source, but no device
  was available. They need a quick look on an actual iPhone and Android
  phone, installed as a PWA.
- **The install button is Chromium-only in practice.** `beforeinstallprompt`
  is not implemented by iOS Safari, so iPhone users must use the browser's
  Share -> Add to Home Screen. That is a platform limitation, not a bug;
  the component hides itself rather than showing something that cannot work.
- **The fallback logo resolves from `process.cwd()/public`.** That is the
  project root under `next dev`/`next start` and in this test suite. If a
  future host ran the route from a different working directory, the fallback
  would 404 and slots would show the gold "M" until the Owner uploads, so the
  file must ship with the app.
- Section 33's item 7 - deriving a size's `completed` count from approved
  production, and the batch payroll query - was **not** part of this UI pass.
  It is resolved in section 39.6.

---

# 39. IMPLEMENTED: operational completion, integration and control (Task 5, this run)

**This is a different Task 5 from section 38.** Section 38 records an earlier UI/PWA/mobile
polish pass that also happened to be called Task 5. This section is the ERP operational
completion, integration and control pass. The full account, with every verification number, is
in **`TASK5-REPORT.md`**; what follows is only what a future reader of this file needs in order
not to redo or undo it.

## 39.1 Verified as already implemented (do not redo)

Checked against the code, not assumed:

- **Separation of duties** is enforced server-side in all four places it matters:
  `POST /api/inspections` refuses self-inspection including on split stages, `PUT
  /api/support-work` refuses a support worker approving their own work,
  `POST /api/production-corrections` refuses a worker correcting their own job, and
  `PUT /api/operations` refuses a submitter who is not the stage's own worker.
- **Worker isolation** on `GET /api/allocations` and `GET /api/operations` cannot be widened by
  omitting a parameter, by naming somebody else, or by using the `operationId` path.
- **`POST /api/auth/setup`** requires a private setup key *and* refuses once any user exists.
- **The production control board** already reports every figure section 33 asks for, derived,
  paginated, with no money key at any depth and no write method on the route.
- **Mobile and PWA** are as section 38 records: `inputCls` (269 call sites) is `min-h-11` and
  `text-base sm:text-sm` so iOS does not zoom, the sidebar is a scroll-locking drawer, modals are
  bottom sheets, worker job lists are cards, and the tables that exist scroll horizontally.
  An independent audit for this task found **no genuine usability defect** and changed no styling.
- **Material control**: the reports screen's materials section already reports purchased, used,
  stock and stock value per material, reading the material system's own figure.

## 39.2 What changed

- **`isReadyMadeMaterial()` in `src/lib/format.ts`** is now the one predicate behind three rules
  that must agree: a ready-made purchase is a cost and never labour, it never enters raw-material
  inventory, and issuing one never draws down the fabric shelf. `POST /api/material-purchases`
  used to add every purchase to `current_stock`, which let a finished garment bought on the
  general screen be issued again as though it were cloth. `POST /api/ready-made` writes to the
  same table and has never touched stock; the two now agree. Compared exactly, not
  case-insensitively, because that is how the costing SQL compares it.
- **Raw-material stock cannot go negative.** `POST /api/material-usage` counts the shelf *before*
  writing and refuses an issue whole — no partial issue, no silent clamping. `PUT` can only ever
  put material back, and that is now asserted rather than assumed: an edit whose net-out would
  grow is refused.
- **`orderFulfilment(orderId)` in `src/lib/production-control.ts`** is the one derived answer to
  "where is this order": ordered, released, in production, approved, remaining, assigned, awaiting
  inspection, rework, rejected, packed, delivered, ready for delivery, complete. It is the same
  `approved` the control board shows, so the order page, the board and the packing and delivery
  guards cannot disagree. `complete` is derived and returned beside `statusSaysComplete`, because
  `PUT /api/orders/[id]` does accept a free `status` and a hand-set COMPLETED must not be trusted.
- **`POST /api/packing` and `POST /api/deliveries` are bounded by approved production.** Packing
  used to accept any positive number against any order id; delivery was bounded only by what was
  ordered. An order that never entered production keeps the ordered ceiling it always had, so
  historical and off-floor orders still work.
- **`GET /api/dashboard` no longer computes its own profit.** It was `revenue − (expenses +
  material usage)` — no labour of any kind — on the most-read money figure in the business. It now
  calls `src/lib/order-cost.ts`, reports unattributable business costs *beside* order profit, and
  returns the old figure as `legacy`, rendered as "previously reported". The costing runs below
  the Project Manager early-return, so a PM request does not pay for financials it never sees.
- **`GET /api/attention`** is what needs a person today, pulled rather than pushed: overdue work,
  awaiting inspection, rework, outsourced not returned, unassigned stages, support work unjudged,
  approved garments undelivered, material at or below reorder level, and orders marked complete
  with batches still open. No notification table, queue or external service was added; every
  signal is derived from `productionControl` or from records that already exist. Staff-only, and
  read once per page load by a sidebar badge — never polled. It reads completed-status orders too,
  so a hand-set status cannot switch off the alarms about the work behind it.
- **`POST /api/payroll` takes `paidBy` from the session, not the request body.** It was the only
  actor in the API a caller could forge, on the one record where "who paid this person" is the
  whole audit.
- **`GET /api/orders/[id]` and `GET /api/material-purchases` stopped downloading the book.** The
  order page selected every production operation, quality check and rework record in the database
  and filtered in JavaScript; purchases selected every purchase, material and order with no
  pagination. Both are now scoped in SQL, purchases paged with `X-Total-Count` and still a bare
  array so no consumer changed.
- **The printed payment sheet now renders `notListed`**, which the API has returned since Task 4:
  how many workers it leaves out and the support deduction carried forward against their later
  piece-rate earnings — the difference between the sheet and the payroll screen.

- **`order_item_sizes.completed` is authoritative wherever production exists.** The derivation
  was already there (`completedForVariant`: approved at the last stage of each batch's own frozen
  route) but it only won when it was *greater than zero*, so a number somebody typed survived
  whenever production had approved nothing yet - twenty pieces awaiting inspection, or every piece
  rejected, still showed the typed figure as finished. Where a variant has any live batch the
  ledger now decides, **including when it says zero**; where it has no production at all the
  recorded figure stands rather than being quietly zeroed. The endpoint also returns `produced`
  and `completedRecorded` so a screen can tell the cases apart, and the order page no longer
  re-implements the fallback in JSX. The derivation moved into `completedForVariants()`, which
  answers for any number of variants in **two queries** instead of three per variant.
- **`payments`, `packing_records` and `deliveries` now record WHO entered them**
  (`recorded_by_id` + `recorded_by_name`, migration `0010_actor_audit`), taken from the session
  and never from the request body. See 39.6.

## 39.3 Schema, data and safety

**One additive migration: `0010_actor_audit`.** Six nullable columns (`recorded_by_id`,
`recorded_by_name` on `payments`, `packing_records` and `deliveries`) and three foreign keys to
`users` with `ON DELETE set null`. No `NOT NULL`, no default, **no data write and no backfill**:
every receipt, packing record and delivery already in the database keeps a NULL actor, because
that is the truth about it, and inventing a name on a historical financial document would be worse
than leaving the question open. `deploy/upgrade-actor-audit.sql` is the same statements idempotent
and guarded, with commented verification queries, and follows the house rule of SQL first then
code. Everything else in this task was schema-free.

After it, `drizzle-kit generate` reports "No schema changes, nothing to migrate"; the journal has
**11 entries** ending at `0010_actor_audit`, with 11 `.sql` files and 11 snapshots. No production
data was touched, nothing was seeded, no applied migration was re-run, no destructive SQL was
written, and no authorization was weakened — the only guard-level changes in this run are that
`GET /api/attention` is staff-only and `POST /api/packing` now 404s on an order that does not
exist.

## 39.4 Regression coverage

**278 tests, 0 failures**, all through the real route handlers: 252 at the start of this run, plus
7 for the returned-material rules, 7 for stock integrity and ready-made, 8 in
`tests/order-lifecycle-and-attention.test.ts` for the derived lifecycle, the packing and delivery
ceilings, the attention list, purchase pagination, the session-derived payment actor and one
authoritative profit across dashboard, reports and order page, and 11 in
`tests/variant-completion-and-actor.test.ts` for variant completion from approved production and
for the actor on receipts, packing and deliveries (including a forged actor in the body being
ignored, a Worker and a Project Manager being refused, and the migration itself being asserted
nullable, default-free and free of any data statement).

One existing fixture was corrected rather than the guard: the nine-cost-categories test catalogued
fabric with `currentStock: 0` and issued ten yards, which could only pass by drawing down an
empty shelf.

## 39.5 Known limitations and decisions left open

- `recorded_by_*` records who **created** a receipt, packing record or delivery, not who last
  edited it. An edit history for those three would need an `updated_by` pair or a document ledger
  — a second mechanism, so it is a decision rather than a default. Edits are OWNER-only.
- `GET /api/dashboard` still reads `productionOperations` whole. It genuinely summarises every
  stage, so the rows cannot be reduced without changing what the screen means; of its 23 columns
  only 5 are provably unused, so narrowing was reported rather than done.
- `/api/attention` derives up to 500 batches per call and reports `window.capped` when there is
  more.
## 39.6 Section 33's item 7, resolved

**A size's `completed` count now comes from approved production** wherever production exists -
see 39.2. The recorded figure survives only on a variant with no live batch at all, so a
historical or off-floor order keeps the number somebody wrote down instead of being zeroed.

**There is no batch payroll query to fix.** `src/lib/payroll.ts` contains no reference to
`production_batches` whatsoever: payroll is derived from approved inspections and attributed
allocations, which is batch-independent by design. The item existed in a secondhand note carried
forward from an earlier session, not in this codebase. The per-worker `completed` figure on the
workers screen is a different concept - operation-level work plus submitted shares, shown beside a
separate `approved` field - and was inspected and deliberately left alone rather than silently
redefined.

# 40. IMPLEMENTED: support-work lifecycle, route resolution, list bounds and audited test-data cleanup

Fifteen requirements were taken in one pass. This section records what a future reader must not
redo or undo. Nothing here is a second system: every item extends a mechanism the codebase
already had, and where an existing rule was in the way the rule was kept and the defect behind it
was fixed instead.

## 40.1 The two defects that were reported as one, and were not the UI's fault

The report was "product-specific routes are ignored; the history appears to show
organization-default routes." Two independent server-side causes, neither visible from the screen
that was blamed:

1. `listRoutes(productId?: number | null)` decided "no filter" by testing `productId === undefined`,
   and every caller passed `productId ?? null`. So `null` — intended as "every route" — became the
   filter "routes whose `product_id` IS NULL", and `GET /api/routes` returned **only**
   organisation-level routes. Reproduced directly: a route existed in the database with
   `productId: 1` and the endpoint returned `[]`. Fixed by replacing the positional argument with a
   named `RouteFilter` object, so "absent" and "explicitly null" can no longer be confused.
2. `resolveRoute` looked for a product route with `is_default = true`. A route saved against a
   garment WITHOUT that flag was invisible to it, so the organisation default won — an organisation
   default silently overriding an explicitly assigned product route, which is the exact thing
   requirement 7 forbids.

Alongside them: `PUT /api/routes` accepted a `productId` and dropped it, so a route could never be
moved onto a garment after creation; `resolveRoute`'s explicit-`routeId` path did not check
ownership at all; and `GET /api/production-orders` reported `defaultRouteId` as "the first route
whose product matches", which could be a retired route, an unflagged one the resolver would never
pick, or another organisation's. It now reports an active, owned route the resolver would actually
choose, falling back to the generic route as a named `defaultRouteName` /
`defaultRouteIsGeneric` rather than as `null` — because `null` there meant the organisation default
was never surfaced at all.

Historical production is untouched by all of this: a batch freezes its route at creation, so a
later edit to a route cannot rewrite what was already produced against it.

## 40.2 What changed

**Support work has a lifecycle** (`src/lib/support-work.ts`, `PUT /api/support-work`).
ASSIGNED → STARTED → SUBMITTED → APPROVED / REWORK, with PAUSED reachable from work in hand and
RESUMED back out of it. `SUPPORT_TRANSITIONS` is the table of legal moves and
`supportTransitionError` is the one place that consults it, so a rule cannot be satisfied in one
handler and forgotten in another. Enforced server-side: no submitting before anybody started (409),
no submitting or being inspected while paused, no self-approval, no over-delegation past what the
stage holds, no handing out another tailor's work, and a pause requires a written reason.

`supportStatusAfterInspection` compares against the quantity **ASSIGNED**, not the quantity
submitted. The first version compared against submitted, so "10 delegated, 4 handed back, 4 judged"
reported APPROVED with six pieces missing. A `SUBMITTED → STARTED` move exists for a partial
inspection, and `from === to` returns null, because a partial inspection is not a move.

**Production Control shows support work and respects its state** (`src/lib/production-control.ts`).
`supportByOperation()` answers for every stage in ONE grouped query rather than one per stage.
`flagsFor` raises `SUPPORT_PAUSED`, `SUPPORT_REWORK` and `SUPPORT_IN_PROGRESS`, and the first two
are in `BLOCKING_FLAGS` — so a paused support operation stops the board showing that stage as
ordinary work in progress, which is requirement 3. `?supportPausedOnly=1` filters to them.

**A tailor can hand out support work from their own production** (`GET /api/workers?supportHelpers=1`,
`/api/auth/me`). `/api/auth/me` now returns `workerId` and `workerName`, so a WORKER session knows
which production record it is without a second lookup or a name match in the browser. The helper
picker returns five columns, is org-scoped, and is filtered to the Support-Worker role. This is
bounded by what the caller holds, not by granting all workers a permission they should not have.

**Start Production opens the existing Assign Production workflow** (`src/app/(app)/orders/[id]/page.tsx`,
`production/assign/page.tsx`). The order page's button is now `href=/production/assign?orderId=…`
via the `Btn` component's new `href` prop, and the 69-line duplicate batch modal that used to sit
behind it was **deleted** along with its `batchModal` / `batchForm` / `emptyBatchForm` state. One
assignment interface, not two. The assign page reads `orderId` from `useSearchParams()` inside a
`Suspense` boundary, preselects the order, and shows the resolved route's provenance. The
preselection is revalidated server-side: an `orderId` belonging to another organisation, or to no
order at all, preselects nothing.

**Lists are bounded in SQL** (`GET /api/orders`, `/api/payments`, `/api/packing`, `/api/expenses`,
`/api/production-orders`, `/api/routes`). Filtering, searching and paging moved into the WHERE
clause; `X-Total-Count` carries the unpaginated total so a client can page without a second
request. `POST /api/orders` now takes its organisation from the session rather than a hardcoded `1`,
checks the customer belongs to that organisation, creates the order and its items in one
transaction, and derives `nextOrderNumber()` from the max sequence with a bounded retry on a unique
collision.

**Administrative test-data cleanup** (`src/lib/test-data-cleanup.ts`,
`src/app/api/test-data-cleanup/route.ts`, `src/app/(app)/settings/test-data/page.tsx`). See 40.4.

## 40.3 Performance: what was measured, and what the numbers do and do not say

`scripts/perf-probe.ts` drives the REAL route handlers through `tests/support/harness.ts` against
the real Drizzle layer on pg-mem, and reports three figures per endpoint: SQL statements executed
(one round trip each against a real database), rows returned, and bytes of JSON that reached the
browser — plus every full-table SELECT with no WHERE clause, because those get worse on their own
as the business grows. Statement counting lives in the driver shim behind `global.__PGMEM_COUNT__`,
so no application code is instrumented and the numbers describe the code that ships.

**The evidence is committed, because a before/after claim whose "before" only ever existed in a
terminal scrollback is a memory and not evidence:**

- `scripts/perf-report-baseline.txt` — measured on UNTOUCHED code, in a throwaway git worktree at
  the commit this branch started from, with only the probe and the counting shim copied in.
- `scripts/perf-report.txt` — the same probe, the same dataset, on the current code.

Both report the identical dataset: **24 orders, 36 batches, 72 inspections, 36 support
assignments.** That equality is what makes the comparison fair, and getting it was not free — see
40.7.

| Endpoint | Before | After | Change |
| --- | --- | --- | --- |
| Orders list | 7 stmts, 7.6 KB, **5** full-table reads | 8 stmts, 7.6 KB, **0** | every unbounded read removed; one extra statement is the count for `X-Total-Count` |
| Production orders (assign) | 9 stmts, 14.8 KB, **7** full-table reads | 9 stmts, 16.3 KB, **0** | every unbounded read removed at no statement cost; +1.5 KB is the route provenance the screen now shows |
| Routes list | 4 stmts, **0 rows**, 1 full-table read | 5 stmts, **1 row**, 0 | this is the 40.1 defect measured: the product route was in the database and the endpoint returned nothing |
| Payments list | 5 stmts, 6.4 KB, 3 full reads | 6 stmts, 6.4 KB, 2 | the third read was the `orderId` filter, now SQL |
| Packing list | 5 stmts, 3 full reads | 3 stmts, 1 full read | fewer statements AND fewer unbounded reads |
| Expenses list | 5 stmts, 5.1 KB, 3 full reads | 6 stmts, 5.1 KB, 2 | `category` pushed into the WHERE clause |
| Production control board | 12 stmts, 103.1 KB | 13 stmts, 117.7 KB | +14.6 KB is **new feature** — support figures and lifecycle state the board never returned before |
| Support work list | 12 stmts, 28.1 KB | 12 stmts, 34.8 KB | +6.7 KB is the lifecycle fields and the pause reasons |
| **Total, 27 calls** | **277 stmts, 547.2 KB, 80 unbounded reads** | **282 stmts, 598.7 KB, 63 unbounded reads** | |

Read honestly: **unbounded full-table reads fell from 80 to 63**, and the three list screens a
person actually pages through now do all their filtering in the database. Statements rose by five
and payload by 51 KB, and both increases are accounted for rather than waved away — four of the
five statements are pagination counts that buy an `X-Total-Count` header, and the payload growth is
data these screens did not previously return at all. Nothing was made smaller by returning less.

**The support payload, measured separately, because the table above cannot show it.** Adding
support figures to the board grew it from 103.1 KB to 151.6 KB — a 48 KB, 47% increase — of which
almost none was support work. A helper named `stageSupportOrEmpty` turned "this stage has no
support work" into a real object carrying ten zeros, for every stage of every batch, and most
stages of most batches have no support work. `ControlRow.support` is now `StageSupport | null`,
the helper is **deleted** rather than left exported for the next caller to rediscover, and the same
dataset now produces 117.7 KB instead of 151.6 KB — **33.9 KB, 22%, recovered**, with every support
figure still present. The one UI site that read `stage.support` unguarded was a latent crash on any
stage without support work, and is now guarded.

What is deliberately **not** claimed: no millisecond figure in either report is a latency
measurement. pg-mem has no network, no planner and no disk. The statement count transfers to real
PostgreSQL because one statement is one round trip; the timings do not.

## 40.4 The test-data cleanup, and what stops it being a delete button

`Settings → Test data` exists to clear one known test order (Glorious Hope School, 50 garments,
₦150,000) before go-live. It is a controlled administrative exception, never a general-purpose
bypass, and the ordinary protection against deleting an order with real approved production and
settled payments is **untouched and still asserted by test**.

- **OWNER-only, with the guard before any read.** A Project Manager, a Worker and every other role
  is refused without the order being looked at, so nothing about it is disclosed to them.
- **Org isolation returns 404**, indistinguishable from an order that does not exist.
- **Two steps that cannot be collapsed.** A dry-run preview that writes nothing, then an execution
  requiring the school's name and the order's number typed out, a written reason of at least ten
  characters, and an acknowledgement. The name comparison is `trim().toLowerCase()` on both sides;
  the order number must match exactly. Both are re-checked **inside the transaction**, against the
  order as it is at that moment.
- **A SHA-256 fingerprint** over the sorted per-table id sets, recomputed inside the transaction.
  A stale preview is 409 and must be taken again. The same fingerprint makes a **replayed**
  confirmation refuse, so one authorisation removes one order once.
- **Deletes are by explicit id lists, children before parents**, inside a single `db.transaction`.
  This matters because `support_assignments` is `ON DELETE SET NULL` and `material_usage` has no
  cascade at all — a blind parent delete would have orphaned both.
- **Inventory is restored, not lost**, using the material routes' own formula
  (`issued ?? used + returned + wasted`, minus what was returned), applied atomically as
  `greatest(0, coalesce(stock,0) + delta)`. If reversing a purchase would drive a stock figure
  negative — because the material has since been used on other orders — the purge **refuses with
  409** rather than forcing it to zero, which would hide a real shortage.
- **Ready-made garments stay purchases** in both directions and never become raw stock. A finished
  uniform is not a raw material.
- **Settled payroll is reported and never rewritten.** Payroll has no order column — accrual derives
  from `stage_inspections` and `support_inspections` — so removing those removes the accrual. A
  payment already banked is a fact, and is listed for the Owner rather than altered.
- **Shared master data is never touched**: customers, products, workers, routes, materials and
  organisations all survive.
- **Every act is recorded permanently.** `test_data_purges` stores the confirmation typed, the
  counts the preview promised beside the counts achieved, and the payroll and inventory reports.
  `order_deletions` stores every ordinary removal. The actor comes from the session; an actor named
  in the request body is ignored, and that is tested.
- `DELETE /api/orders/:id` now **requires `?reason=`** and goes through `deleteOrderIfSafe`. The
  orders screen asks for a reason and surfaces the server's answer if it refuses.

## 40.5 Schema, migrations and deployment

Two migrations, both **additive, idempotent, with no NOT NULL, no default, no backfill and no data
write of any kind**:

- `drizzle/0011_support_lifecycle.sql` → `deploy/upgrade-support-lifecycle.sql`. Four nullable
  columns on `support_assignments` (`started_at`, `paused_at`, `pause_reason`,
  `submitted_by_name`), `support_assignments_status_idx`, and the append-only
  `support_status_events`.
- `drizzle/0012_deletion_and_purge_audit.sql` → `deploy/upgrade-test-data-cleanup.sql`. The
  `order_deletions` and `test_data_purges` audit tables, four explicit indexes each **plus the index
  PostgreSQL creates for each primary key, so `pg_indexes` reports 5 each** — both files originally
  documented 4, which would have made a correct upgrade look like a broken one to whoever compared
  the numbers.

Both deploy scripts wrap their DDL in an explicit `BEGIN;` … `COMMIT;` and put every verification
query **after** the `COMMIT`, so one paste applies the upgrade, commits it, and prints the figures
that confirm it. The drizzle migrations contain **no** transaction control, because drizzle-kit owns
the transaction when it applies one. That asymmetry is deliberate and is asserted by
`tests/migration-safety.test.ts`; see 40.7 for the production incident that made it necessary.

The deploy script is deliberately RICHER than the migration and is organised in five numbered
sections: the two tables, their guarded foreign keys, the read-only verification queries, a pointer
to the separate atomicity probe, and the post-deploy queries that prove the trail works end to end.
**The probe is no longer one of those sections** — it lives in `deploy/verify-atomicity-probe.sql`,
described in 40.7. A migration has no business containing a test that writes and aborts, so the two
files are not interchangeable, and the deploy script must never be regenerated from the migration
without re-adding the transaction boundary, the verification queries and sections 4 to 5. That
warning is now backed mechanically rather than by memory alone: `tests/migration-safety.test.ts`
compares each deploy script against its migration DDL statement by statement and by object
inventory, so regenerating one from the other and losing content fails the suite.

`drizzle/meta/_journal.json` has 13 contiguous entries (0000–0012) with 13 snapshots, and
`npx drizzle-kit generate` reports "No schema changes, nothing to migrate" — so `src/db/schema.ts`
and the migration files agree.

0011 deliberately does **not** backfill a start time, a pause or an event onto existing support
assignments. Every row already in the database keeps NULL for all four columns, because that is the
truth about it: the system did not record when that helper began. Inventing a start time would put
a fabricated timestamp behind a payroll figure. Existing assignments keep their existing status —
ASSIGNED, SUBMITTED, APPROVED, REWORK and CANCELLED are all still legal states — so nothing
recorded becomes invalid. One behaviour does change for work not yet submitted: it must now be
STARTED first, which is the point of the change, and nothing historical is rewritten to make that
apply retroactively.

`deploy/UPDATE-INSTRUCTIONS.md` has a release section for each, in the house format: back up, paste
the SQL, run the verification query and compare the counts, then deploy the code. **SQL first, code
second.** Do not run `drizzle-kit migrate` against production.

## 40.6 Regression coverage

**386 tests, 0 failures**, up from 278 at the start of this run. `npx tsc --noEmit` clean.
`npm run build` succeeds and emits both new routes (`/api/test-data-cleanup`,
`/settings/test-data`). All through the real route handlers; no application logic is
re-implemented, copied or faked anywhere in the suite.

108 tests were added, in five files:

- `tests/support-lifecycle.test.ts` — 30
- `tests/test-data-cleanup.test.ts` — 28
- `tests/product-route-resolution.test.ts` — 19
- `tests/migration-safety.test.ts` — 21
- `tests/start-production-and-list-bounds.test.ts` — 10

`tests/migration-safety.test.ts` is new in kind rather than in subject: it holds the two migrations
mechanically to the promise every file in `deploy/` makes only in prose. No `DROP`, `TRUNCATE`,
`RENAME`, `DELETE`, `UPDATE` or `INSERT` outside a comment; every statement a guarded DDL form,
explicit transaction control or a read-only verification query; **no `RAISE` of any kind in either
migration file, because a migration must never fail on purpose**; a runnable verification SELECT
present and naming the tables it created; no drizzle `--> statement-breakpoint` marker leaked into a
file meant to be pasted into the SQL Editor; **exactly one `BEGIN;`/`COMMIT;` pair per deploy script,
bounding every DDL statement, with the first verification query after the `COMMIT`, and no
transaction control at all in the drizzle migrations**; both upgrade scripts applied **twice** against
the migrated database with the table set unchanged, the new tables still empty and a real order
created through the API still intact. Until now that promise was a comment, and a comment cannot fail
a build.

It also holds the separate probe file to its own contract: it exists, it says in terms that it is
**not a migration** and that running it is optional, both migration files point at it so it cannot be
orphaned again, it inserts only into the audit table it undoes, its `ROLLBACK` follows its `INSERT`,
it contains **no `COMMIT`** (which would make its row permanent) and **no DDL** (which would make it
a second, unreviewed migration), its deliberate abort is followed by an `EXCEPTION` handler so it
cannot halt a SQL editor, and it still raises loudly on a genuine rollback failure rather than
passing silently. Finally it pins the documented index and column counts — 5, 5, 14 and 15 — because
a verification figure that is wrong by one turns a successful deployment into an investigation.

It also compares each deploy script against its drizzle migration statement by statement, and by
object inventory — tables, indexes, new columns, foreign keys, **foreign-key targets and `ON DELETE`
behaviour** — so the two files cannot drift apart unnoticed. They are applied by different tools
(drizzle-kit for one, a person in a SQL editor for the other), so nothing else would catch it, and
they have drifted before.

Every one of those assertions was **negative-controlled**: the defect it forbids was reintroduced
into a copy of the file, the test was shown to fail, and the file was restored. Ten controls were
run — `RAISE EXCEPTION` back in the migration, `BEGIN`/`COMMIT` removed, a `COMMIT` added to the
probe, the probe's `EXCEPTION` handler removed, an index expectation reverted to 4, the probe file
deleted, transaction control added to the drizzle migration, DDL hidden in the probe file, one
foreign key's `ON DELETE` drifted in the deploy script only, and one index deleted from the deploy
script only. **All ten were caught.**

Worth recording, because it is the kind of mistake that reports success: the first version of the
consistency comparison split SQL on `;` without first unwrapping the `DO $$ … END $$;` guard blocks.
That truncates each block at its first inner semicolon, so only the first of four `ADD CONSTRAINT`
statements was ever compared — and the check still printed a confident "IDENTICAL" verdict. The
committed version unwraps the guard blocks first and asserts that it really did compare four
constraints, so the comparison cannot silently degenerate again.

Four existing fixtures were **corrected rather than the guards being weakened**:
`tests/support-payroll.test.ts`, `tests/support-cost-allocation.test.ts` and
`tests/reassignment-and-report-figures.test.ts` now start support work before submitting it, which
is the real workflow rather than a workaround; `tests/production-control.test.ts`'s `stageControl()`
fixture gained the `support` field. No test was deleted, and no assertion was relaxed to make
anything pass.

## 40.7 Known limitations, and things that are NOT verified

Stated plainly, because an unverified claim in this file is worse than none:

- **Transactional atomicity is not demonstrated by the suite, and cannot be.** pg-mem does not roll
  back: an insert followed by a throw inside `db.transaction` leaves both the row and the stock
  update. This was verified directly rather than assumed. `tests/test-data-cleanup.test.ts` says so
  at the top and asserts the ordering, the fingerprint and the guards that a rollback would have
  backed up, instead of faking a rollback assertion. The single-transaction structure is real in
  the code; only its failure behaviour is unproven here.

  **`deploy/verify-atomicity-probe.sql` is the manual probe to run against a real PostgreSQL before
  relying on that claim.** It is **optional, separate, and not part of any migration**: run it on its
  own, after the upgrade has been applied and verified. Probe A inserts one labelled row into
  `order_deletions` inside an explicit transaction it then rolls back — the exact mechanism Drizzle
  uses on failure — and Probe B raises inside a block whose handler catches it, which tests that an
  *error* undoes work too. Both report a result row rather than an error, and the verdict row reads
  `PASS - this server rolls back`. If it reports residue, transactions are not rolling back on that
  server and neither order removal nor the cleanup may be used until that is understood, because
  both could leave the database half-changed. **Do not delete that probe thinking it redundant — it
  is the only half of the guarantee that is tested anywhere.**

  **It used to be section 4 of the upgrade script, and that placement caused a production incident.**
  A probe proves rollback by aborting on purpose; a migration must never abort. Pasted as part of the
  whole file, with no `COMMIT` before it, its `RAISE EXCEPTION 'probe: deliberate abort'` aborted the
  single implicit transaction the entire upgrade was running in and rolled the upgrade back with it.
  The database was left unchanged and unharmed — the safe outcome — but the error gave whoever was
  deploying no way to tell from the script whether the tables had been created, and it took a catalog
  query to establish that they had not. The lesson is general and is now pinned by tests: **a test
  designed to fail must never share a submission with a migration designed to succeed**, and a
  hand-run deploy script must own its transaction rather than inherit one from whichever editor
  pastes it. This file also lost the probe once before, when the deploy script was regenerated from
  the `drizzle/` migration; it must survive any future rewrite, in its own file.

- **`purgeHistory` must order `desc` with a `limit`, never `asc` + `limit` + reverse.** Reversing an
  ascending slice returns the OLDEST window once the trail is longer than the limit - silently, and
  only in production, because no test database has 50 purges in it. This regression was introduced
  and caught during the merge of two revisions of this work; the correct form and its comment are in
  `src/lib/test-data-cleanup.ts`.
- **The performance probe was itself defective, and the defect flattered the results.** It submitted
  a stage before starting it and asked a stage for more pieces than the previous stage had approved,
  so every support handout was correctly refused and the probe built a dataset with **zero support
  assignments** — then reported a payload figure for support work anyway. The "151.2 KB" recorded
  during this run was measured on that empty set, which is why it is not quoted above as a before
  figure. Three separate causes had to be fixed before the probe produced real support work: a
  PENDING stage cannot be submitted against, a stage may only submit what the previous stage had
  approved, and the operation list was read before the ledger moved so `quantityRemaining` was
  stale at zero. All three are now comments in the probe, because each one looks like a reasonable
  thing to do.
- **`deploy/schema-only.sql` and `deploy/full-setup.sql` are stale, and were already stale before
  this run.** Neither contains `worker_roles`, `support_assignments`, `production_routes`,
  `production_route_stages`, `production_allocations`, `external_work_orders` or
  `production_movements` — so they have been missing tables since roughly migrations 0004–0006, not
  because of anything added here. **This release's DDL was deliberately NOT appended to them**:
  adding two tables to a file that is already seven short would make it look current when it is
  not, which is more dangerous than leaving it visibly old. A brand-new database should be built
  from the migrations in order. Fixing those two files properly is a decision for the business, not
  a side effect of this task.
- **`GET /api/dashboard` still reads `productionOperations` whole** (33 statements, 17 unbounded
  reads, unchanged). It genuinely summarises every stage, so the rows cannot be reduced without
  changing what the screen means. Same for `/api/reports` (25 statements, 14 unbounded reads). Both
  are reported rather than quietly narrowed — narrowing them was investigated and would have
  changed the figures the screens show.
- **Lint is at the baseline: 33 problems, 29 errors, 4 warnings — the same four warnings the
  untouched code produces.** Measured by linting a throwaway worktree at the baseline commit and
  diffing, not by inspection. The 29 `react-hooks/set-state-in-effect` errors are the repository's
  established data-loading pattern (`useEffect(load, [deps])` appears on nearly every page) and none
  were added; three sit in files this work rewrote, because rewriting a page in this codebase means
  writing the pattern the codebase uses.

  An earlier state of this work left `production/assign/page.tsx` one warning worse than baseline
  (`exhaustive-deps` for `load`) and recorded it here as an accepted cost. **That was settled rather
  than accepted**, by wrapping the loader in `useCallback([requestedOrderId])` and giving the effect
  `[load]`. `requestedOrderId` is a string primitive read off the query string, so the memo identity
  is stable across renders of the same URL: the effect still runs on mount and on a genuine URL
  change, never on an unrelated re-render, and both other call sites — the save handler and the
  Refresh button — keep working unchanged.

  `useEffectEvent` was investigated first and **rejected for a concrete reason**: it is stable in
  React 19.2 and is the hook designed for exactly this, but a function it returns may only be called
  from inside an effect, and `eslint-plugin-react-hooks` makes calling one elsewhere an error. This
  loader is called from three places, so an effect-event would have broken two of them or forced a
  second copy of the loader. No eslint suppression was added anywhere; this codebase has none and the
  first one should not be spent on a hook warning.
- **The end-to-end workflows are verified through the API, not through a browser.** All four (tailor
  support lifecycle, school-order start-production, product-route resolution, test-data cleanup) are
  driven through the real route handlers by the tests above, which is genuine verification of the
  server-side rules. No headless browser was run, so pixel-level rendering and client-side routing
  are covered by the successful production build and by reading the components, not by an automated
  click-through.

## 40.8 What a production-readiness review found afterwards, and what was done about it

This pass happened after the work above was believed finished, and it found one real defect. It is
recorded separately because the distinction between "introduced here" and "already there" is the
only thing that makes the list usable.

**FIXED — cross-organisation access to support work.** `PUT /api/support-work` looked its
assignment up by id alone, with no organisation predicate. Every actor rule on that route is derived
from identity — the caller's own linked worker record against the assignment's — *except*
`isSupervisor`, which is derived from the login ROLE alone, and a role says nothing about which
company you belong to. So an OWNER or PRODUCTION_MANAGER of one organisation could name an
assignment id belonging to another and inspect it, and inspection is what approves pieces and
therefore what makes them payable. Pausing and cancelling were reachable the same way, and
`GET /api/support-work/inspections` disclosed another organisation's inspection history — piece
rates and rework — to any supervisor, because its Worker branch checks participation and its
supervisor path checked nothing.

Both now resolve the assignment and refuse with **404** when it belongs to a different organisation,
so probing ids cannot distinguish "not yours" from "does not exist". A legacy row with no
organisation at all is not refused, matching `ownedBy` in `src/lib/production-route.ts`. This was
**pre-existing** — the identical unscoped lookup is at the baseline commit — but it is fixed here
because the lifecycle put three more supervisor-reachable actions behind the same lookup.
`tests/support-lifecycle.test.ts` pins it, and the test was verified to fail without the fix (a
foreign Owner gets **201** and the pieces become payable) and pass with it.

**FIXED — `GET /api/routes` could fail open.** It scoped with `session?.organizationId ?? null`, and
`null` is the value that means "apply NO organisation scope". `guard(req, STAFF)` had already
returned 401, so it was not reachable, but it depended on that rather than enforcing it. The route
now asks for the session and refuses without one, exactly as POST, PUT and DELETE on the same file
already did.

**FIXED — a comment that contradicted the rule it documented.** `SUPPORT_TRANSITIONS` said PAUSED
was reachable only from work "actually in hand … never from ASSIGNED", while the map itself allows
`ASSIGNED → PAUSED` and a test asserts it. The map is right and the comment was wrong: pausing
straight from ASSIGNED is how a tailor stops work they have found they cannot give, before a helper
starts it. A wrong comment on a security rule is how the next person "fixes" correct code, so the
comment was corrected rather than the behaviour.

**NOT CHANGED, deliberately — organisation scoping is inconsistent across the API, and it is
pre-existing.** Six read endpoints are guarded by ROLE but carry **no organisation predicate at
all**, at baseline and now: `/api/payments` (OWNER), `/api/packing` (OWNER), `/api/expenses`
(OWNER), `/api/reports` (OWNER), `/api/production-control` (STAFF) and `/api/dashboard` (ANYONE, so
every signed-in role). Each of them has zero references to `organizationId` in the whole file. Nothing
this work did removed a predicate from any route — verified by counting `organizationId` references
per route before and after, where every changed route kept or gained them — and the three list
endpoints that were rewritten for pagination were not given scoping they never had.

The reason this is reported rather than fixed in the same pass: **`payments` has no
`organization_id` column**, so scoping it means joining or subquerying `orders` on every financial
read, and doing that correctly across four endpoints plus their tests is a change to money-reporting
paths that deserves its own review rather than tagging along with a feature release.

It is also **not currently exploitable**, and the reason is itself the thing to flag: eight
endpoints hardcode `organizationId: 1` when *creating* records — `auth/setup`, `users`, `workers`,
`products`, `customers`, `materials`, `material-purchases` and `expenses` — so every user and every
record belongs to organisation 1 and there is no second organisation to be isolated from. The
application is single-organisation in fact while being multi-organisation in shape. **Enabling a
second organisation without first scoping those six read endpoints would expose one company's
payments, packing, expenses, reports, whole production board and dashboard to the other's Owner —
and the dashboard to any signed-in user at all.** That is the order the work has to happen in, and
it is the single most important thing on this list.

**NOT CHANGED — `deploy/schema-only.sql` is load-bearing and must not be regenerated from the
migrations.** See 40.7 and the note at the foot of `deploy/UPDATE-INSTRUCTIONS.md`: it carries ten
`ENABLE ROW LEVEL SECURITY` / `REVOKE ALL` statements and no `drizzle/` migration contains any RLS
or grant statement at all, so regenerating it would trade an incomplete schema for a complete one
with no row-level security.
