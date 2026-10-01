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

## A. Multi-role workers

Allow a worker to be assigned multiple roles/specialties, such as: -
Project Supervisor - Cutter - Tailor - any other production role.

Their work area should show all jobs assigned to them across all roles.

## B. Monthly bank payment sheet

Add a printable monthly payment list showing how much is expected to be
paid to each staff member, suitable for sending to the bank.

## C. WhatsApp sharing

Add WhatsApp sharing to the documents created so far: - receipts; -
delivery documents; - payment page/payment document; - other appropriate
customer-facing documents.

These three requests are the **starting point for the next development
session**.

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
