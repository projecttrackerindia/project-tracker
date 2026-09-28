# Sample organization for testing

`seed-sample-org.mjs` creates **Acme Software Pvt Ltd**: an organization on the Business plan with users of every role, an org
chart, two teams, seven projects on different timelines, and the data that goes with them (tasks, subtasks, checklists, comments,
dependencies, milestones, a sprint, time entries, custom fields, automation rules and chat). Everything is created through the
real API, so the application's own rules apply to it.

**Test data only.** All accounts share one well-known password. Delete the organization and its users before exposing the app to
anyone you do not trust (the compose file publishes the web port on the LAN when `WEB_BIND=0.0.0.0`).

## Sign in

Password for every account: **`Acme@Test2026!`**

| Email | Name | Role | Job role (org chart) | Reports to |
|---|---|---|---|---|
| `owner@acme-sample.test` | Arjun Mehta | **Owner** | CTO | - |
| `admin@acme-sample.test` | Divya Krishnan | **Admin** | Principal Manager | Arjun |
| `manager.delivery@acme-sample.test` | Rahul Verma | **Manager** | Delivery Manager | Divya |
| `manager.product@acme-sample.test` | Sneha Iyer | **Manager** | Product Manager | Divya |
| `lead@acme-sample.test` | Karthik Raman | Member | Project Lead | Rahul |
| `dev.frontend@acme-sample.test` | Meera Nair | Member | Developer | Karthik |
| `dev.backend@acme-sample.test` | Vikram Singh | Member | Developer | Karthik |
| `devops@acme-sample.test` | Lakshmi Menon | Member | Developer | Karthik |
| `qa@acme-sample.test` | Ananya Das | Member | Tester (QA) | Karthik |
| `designer@acme-sample.test` | Rohan Gupta | Member | Business Analyst | Sneha |
| `newjoiner@acme-sample.test` | Pooja Patel | Member | not placed | - |
| `client@acme-sample.test` | Sanjay Kapoor | **Guest** | - | - |

`newjoiner@` is set up like an account an administrator just created: the password above is its *temporary* one, and the first
sign-in shows "Choose your password" (nothing else works until it is replaced). Use it to test that flow.

The addresses use the reserved `.test` domain and every account has optional e-mail notifications switched off, so nothing is
ever mailed to them.

## The projects

| Key | Project | Timeline | State | Good for testing |
|---|---|---|---|---|
| CPR | Customer Portal Revamp | Software delivery | Active, Development in progress | The full feature set: subtasks, checklists, dependencies, milestones, sprint, custom fields, automation, comments, time logs; Code Review to Production are **locked** |
| MOB | Mobile App v2 | Software delivery | Just started | Requirements & Planning still open, so **Development is locked**: completing a Development task shows *Previous Step Not Completed* |
| MKT | Q4 Marketing Campaign | Marketing campaign | Active, content stage | A second timeline template |
| OFC | Office Relocation 2026 | Simple project | Planning, starts in the future | Simple timeline, future dates |
| PAY | Payments Gateway Upgrade | Software delivery | Behind schedule | Overdue tasks, Delayed health, Code Review in progress |
| WEB | Website Refresh | Simple project | **Completed** | Finished project: every stage and task done |
| RET | Retail Co Client Portal | Software delivery | Active | Shared with the client: the **Guest** sees only this project |
| SFC | Salesforce Service Cloud Setup | Simple project | Active | In the *Salesforce Projects* group |
| HRM | Payroll Automation | Simple project | Active | In the *HRMS* group |

The projects are spread over **project groups** (Employee Portal, Mobile Applications, Payment Engine, Salesforce Projects, HRMS, Other Projects, and an empty Data Team), so
the **Project status** page has several groups to open. *PAY*, *CPR* and *RET* also carry **delivery date changes with reasons** (the project's own due date and
tasks such as *Reconcile historical invoices* and *Dashboard UI*), and *Load test at 10k transactions per second* is waiting on a dependency.

## Things worth trying as each role

* **Owner (Arjun)** - everything: Billing, Members (Create user / Invite), Roles & permissions, Audit log, Organization chart, Settings.
* **Admin (Divya)** - like the Owner but Billing is view-only; can create users and manage roles below Admin.
* **Manager (Rahul, Sneha)** - runs projects, sees My team (their reporting line), timesheets and workload of their reports, reports; no Members, Audit log or Billing.
* **Members** - see the projects, but can only edit tasks assigned to them; Karthik (Project Lead) also has a **My team** page with his four reports.
* **Guest (Sanjay)** - sees one project only, read-only apart from commenting; no Members, Organization or Reports.
* **Stage order** - as Rahul open *Mobile App v2* or *Customer Portal Revamp*, try to complete a task in a locked stage or set a locked stage to Completed.
* **Task completion rules** - a task with open subtasks or checklist items cannot be moved to Done (*Dashboard UI* has both).
* **Reports / Timesheet / Calendar / Dashboard charts** - time was logged over the last week by nine people.
* **Project status** - open *Payment Engine* and *Payments Gateway Upgrade*: the due date moved 21 days, two tasks slipped, and one is waiting on another. **Project groups** (Owner / Admin) manages the list.
* **Chat** - the *Engineering* and *Leadership* groups and a direct chat between Karthik and Meera have messages.

Signing in to many accounts quickly hits the login rate limit (10 sign-ins a minute per address): use separate browser profiles or
private windows, or wait a minute when it says "Too many requests".

## More projects for the Project Status page

`seed-status-demo.mjs` adds ten projects to the sample organization, in three **project groups** - *Salesforce Projects* (CRM Implementation, Migration,
Integration), *Employee Portal* (Enhancement, API Upgrade, Mobile Application) and *Data Team* (Data Migration, Reporting Automation, Data Quality Improvement,
Data Warehouse Refresh) - with tasks, one completed project, delivery dates that moved (with the reason and what they depended on), one project that is
overdue, tasks waiting on other tasks, and **action items** (some overdue, some completed) on six of the projects, a **project type** on every project, and eleven **work tasks** (bug fixes, support, analysis ...), some referring to completed projects. Run it once, after `seed-sample-org.mjs`, against the same API (the sample accounts have e-mail switched off, so it
can run against the normal stack):

```bash
API=http://localhost:8080 node deploy/sample-org/seed-status-demo.mjs
```

Then sign in as `owner@acme-sample.test` and open **Project status** (the **Action Items** button in the top-right corner opens them). Running it again does not add the projects twice - it only adds action items to a project that has none.

## Running it again

The script refuses to run if `owner@acme-sample.test` already exists. To recreate the data, delete the organization (Admin portal
> Organizations) and remove the twelve `@acme-sample.test` users, or use an empty database.

Run it against an API that does **not** send e-mail (the normal container uses SMTP). With Docker Compose, from the repository root:

```bash
docker compose run -d --no-deps -p 127.0.0.1:18081:8080 --name pm-seed \
  -e Email__Provider=Log -e RateLimiting__Enabled=false -e App__RequireEmailVerification=false \
  -e Seed__Demo=false -e Seed__AdminEmail= -e Seed__AdminPassword= api
# wait until http://localhost:18081/health/ready says Healthy, then
API=http://localhost:18081 node deploy/sample-org/seed-sample-org.mjs
docker rm -f pm-seed
# put the new joiner back into "must choose a new password":
docker compose exec -T db psql -U postgres -d projectmanagement \
  -c "UPDATE \"Users\" SET \"MustChangePassword\" = true WHERE \"NormalizedEmail\" = 'newjoiner@acme-sample.test'"
```

The temporary container talks to the same database as the normal one; `Email__Provider=Log` is what keeps it from sending mail.
