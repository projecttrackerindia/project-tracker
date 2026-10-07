#!/usr/bin/env node
// Sets up the "Razor pay" integration in Project Tracker through its public API: the project (linked to the MuleSoft team, owned by
// Prasanna), its tasks for both endpoints, the API document, one API definition with the two endpoints (POST /api/v1/create and
// GET /api/v1/razorpay/payments/status), their request flow diagrams and full response field tables. It is safe to run again: whatever
// already exists (by name, method + path or title) is reused and repaired in place - never duplicated.
//
//   PT_EMAIL='you@example.com' PT_PASSWORD='…' node scripts/seed-razorpay-project.mjs
//   or, without a password (recommended for a script): PT_API_KEY='pmk_…' node scripts/seed-razorpay-project.mjs
//   optional: PT_BASE=https://projecttracker.in  PT_TEAM=MuleSoft  PT_PROJECT='Razor pay'  PT_ASSIGNEE=Prasanna  PT_DRY=1 (only shows what it would do)
//
// An API key is the safer way to run this: Settings -> API keys -> New key (Read/write), in the workspace this should run in. It can be
// revoked afterwards and never needs a password to be typed or stored anywhere. The password path still works for a one-off run.

const BASE = (process.env.PT_BASE ?? 'https://projecttracker.in').replace(/\/$/, '') + '/api/v1';
const EMAIL = process.env.PT_EMAIL, PASSWORD = process.env.PT_PASSWORD, API_KEY = process.env.PT_API_KEY;
const TEAM = process.env.PT_TEAM ?? 'MuleSoft';
const PROJECT = process.env.PT_PROJECT ?? 'Razor pay';
const ASSIGNEE = process.env.PT_ASSIGNEE ?? 'Prasanna';
const DOC_TITLE = 'Razor pay API';
const DRY = process.env.PT_DRY === '1';
const GROUP = process.env.PT_GROUP;   // name of the project group; by default the MuleSoft/integration one, or the first
if (!API_KEY && (!EMAIL || !PASSWORD)) { console.error('Set PT_API_KEY (recommended), or PT_EMAIL and PT_PASSWORD, as environment variables.'); process.exit(1); }

let token = API_KEY ?? '';
const say = (m) => console.log(m);
async function call(method, path, body, { allow404 = false } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) {
    if (allow404 && res.status === 404) return null;
    const why = json?.message ?? json?.errors?.map((e) => e.message).join('; ') ?? text.slice(0, 200);
    throw new Error(`${method} ${path} -> ${res.status} ${why}`);
  }
  return json && 'data' in json ? json.data : json;
}
const items = (x) => (Array.isArray(x) ? x : x?.items ?? []);
const doc = (...paras) => JSON.stringify({ type: 'doc', content: paras.map((p) => (typeof p === 'string' ? { type: 'paragraph', content: [{ type: 'text', text: p }] } : p)) });
const h = (text, level = 2) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
const bullets = (...t) => ({ type: 'bulletList', content: t.map((x) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: x }] }] })) });
const diagram = (code) => ({ type: 'codeBlock', attrs: { language: 'mermaid' }, content: [{ type: 'text', text: code }] });

// A JSON Schema with a description on every property: the Documents module turns this into the same per-field table the source document
// shows ("RESPONSE FIELDS": name, type, example, description), on screen and in the exported PDF - not just a raw JSON example.
const schema = (properties, required = []) => JSON.stringify({ type: 'object', properties, ...(required.length ? { required } : {}) });
const field = (type, description, example) => ({ type, description, ...(example !== undefined ? { example } : {}) });

// ---------------------------------------------------------------------------------------------------------- content from the Razor pay document
const FLOW = `flowchart LR
  A[Payment Engine Portal] -->|POST /api/v1/create| B[API Gateway - MuleSoft]
  B -->|Validate CLIENT-ID, CORRELATION-ID| C[Razor pay Integration Flow]
  C -->|Create Order| D[Razorpay Payment Gateway]
  D -->|Order JSON| C
  C --> B
  B -->|Order details| A`;
const FLOW_STATUS = FLOW.replace('POST /api/v1/create', 'GET /api/v1/razorpay/payments/status').replace('Create Order', 'Get Payment').replace('Order JSON', 'Payment JSON').replace('Order details', 'Payment status');

const headerParams = (idExample) => [
  { name: 'CORRELATION-ID', in: 'header', required: true, type: 'string', description: 'Unique identifier used to correlate and trace the API request across systems.', example: 'GDHY43c57WG76', schema: null },
  { name: 'CLIENT-ID', in: 'header', required: true, type: 'string', description: 'Unique identifier assigned to the client/application for authentication.', example: '78g65*******fa2b', schema: null },
  { name: 'CLIENT-SECRET', in: 'header', required: true, type: 'string', description: 'Secret credential associated with the client. Keep it confidential; never expose it in documentation or logs.', example: null, schema: null },
  { name: 'Authorization', in: 'header', required: true, type: 'string', description: 'HTTP Basic authentication header (base64 of the fixed username:password issued for this integration).', example: null, schema: null },
  ...(idExample ? [{ name: 'id', in: 'header', required: true, type: 'string', description: 'Unique identifier generated by Razorpay for the payment transaction.', example: idExample, schema: null }] : []),
];

const createResponseSchema = schema({
  id: field('string', 'Unique identifier assigned to the order by Razorpay.', 'order_Tf3F1WeyNIcRGr'),
  entity: field('string', 'Identifies the type of resource returned. For this response, the value is order.', 'order'),
  amount: field('number', 'Total payment amount associated with the order, in the smallest currency unit (paise for INR).', 501),
  amount_paid: field('number', 'Amount already paid for the order.', 0),
  amount_due: field('number', 'Amount remaining to be paid for the order.', 501),
  currency: field('string', 'Currency in which the order amount is specified.', 'INR'),
  receipt: field('string', "Receipt/reference identifier supplied by the caller when creating the order - echoed back as-is.", 'HL1070003'),
  offer_id: field('string', 'Identifier of an applied Razorpay offer, if any. Returns null when no offer applies.', null),
  status: field('string', 'Current status of the order, such as created, attempted, or paid.', 'created'),
  attempts: field('number', 'Number of payment attempts made for the order.', 0),
  notes: field('array', 'Additional metadata supplied when creating the order. Empty when no notes are provided.', []),
  created_at: field('number', 'Unix timestamp indicating when the order was created.', 1790073272),
}, ['id', 'entity', 'amount', 'amount_paid', 'amount_due', 'currency', 'receipt', 'status', 'attempts', 'created_at']);

const createEndpoint = {
  method: 'POST', path: '/api/v1/create', tag: 'Payment', deprecated: false,
  summary: 'Implemented the Razorpay Create API to initiate payment orders and support seamless payment processing.',
  details: {
    description: 'Developed the Razor pay Create API to initiate payment orders and generate the required order details for seamless and secure payment processing. It is the first step of the payment flow: the order is created on the server side and its order_id is then used by the web or mobile checkout to collect the payment.',
    auth: 'inherit',
    parameters: headerParams(null),
    requestBody: { contentType: 'application/json', required: true, description: "Amount (in paise), currency and the caller's receipt reference.",
      schema: schema({ amount: field('number', 'Payment amount in the smallest unit of the currency (paise for INR).', 100), currency: field('string', 'Three-letter ISO currency code.', 'INR'), receipt: field('string', "The caller's own reference for this order; echoed back as-is in the response.", 'FSTNHLLONS000005023376') }, ['amount', 'currency', 'receipt']),
      example: '{\n  "amount": 100,\n  "currency": "INR",\n  "receipt": "FSTNHLLONS000005023376"\n}' },
    responses: [
      { status: '201', description: 'Created (Payment is successful)', contentType: 'application/json', schema: createResponseSchema, example: '{\n  "id": "order_Tf3F1WeyNIcRGr",\n  "entity": "order",\n  "amount": 100,\n  "amount_paid": 0,\n  "amount_due": 100,\n  "currency": "INR",\n  "receipt": "HL1070003",\n  "offer_id": null,\n  "status": "created",\n  "attempts": 0,\n  "notes": [],\n  "created_at": 1787902621\n}' },
      { status: '400', description: 'MuleSoft rejected the request for a missing required field.', contentType: 'application/json',
        schema: schema({ error: field('object', 'The error envelope.'), 'error.statuscode': field('integer', 'HTTP-equivalent status code echoed inside the error envelope.', 400), 'error.errorType': field('string', 'Machine-readable error classification (MuleSoft-side or APIKit validation error type).', 'APIKIT:BAD_REQUEST'), 'error.description': field('string', 'Human-readable description of what went wrong.', 'required key [amount] not found') }),
        example: '{\n  "error": {\n    "statuscode": 400,\n    "errorType": "APIKIT:BAD_REQUEST",\n    "description": "required key [amount] not found"\n  }\n}' },
    ],
    errors: [{ code: 'APIKIT:BAD_REQUEST', message: 'required key [amount] not found', description: 'A required body field is missing.' }],
    samples: [{ title: 'Create an order (masked)', language: 'curl', code: 'curl --request POST "https://<host>/api/v1/create" \\\n  --header "Content-Type: application/json" \\\n  --header "CORRELATION-ID: GDHY43c57WG76" \\\n  --header "CLIENT-ID: <client id>" \\\n  --header "CLIENT-SECRET: <client secret>" \\\n  --header "Authorization: Basic <base64 username:password>" \\\n  --data-raw \'{"amount": 100, "currency": "INR", "receipt": "FSTNHLLONS000005023376"}\'' }],
    dependencies: [{ name: 'Razorpay (Payment Gateway)', note: 'Creates the order; MuleSoft passes the call through.' }],
    flow: FLOW,
  },
};

const statusResponseSchema = schema({
  id: field('string', 'Unique identifier assigned to the payment transaction by Razorpay.', 'pay_Rop5tyzxBi'),
  entity: field('string', 'Identifies the type of resource returned. For this response, the value is payment.', 'payment'),
  amount: field('integer', 'Payment amount in the smallest unit of the currency. For INR, the amount is represented in paise.', 100),
  currency: field('string', 'Currency in which the payment was processed.', 'INR'),
  status: field('string', 'Current status of the payment, such as authorized, captured, or failed.', 'authorized'),
  order_id: field('string', 'Unique identifier of the Razorpay order associated with the payment.', 'order_RTsgyur9699Xi2'),
  invoice_id: field('string', 'Identifier of the invoice associated with the payment, if applicable. Returns null when no invoice is associated.', null),
  international: field('string', 'Indicates whether the payment was processed as an international transaction.', 'false'),
  method: field('string', 'Payment method used by the customer, such as upi, card, netbanking, or wallet.', 'upi'),
  amount_refunded: field('number', 'Total amount refunded against the payment, represented in the smallest currency unit.', 0),
  refund_status: field('string', 'Current refund status of the payment, if applicable.', null),
  captured: field('string', 'Indicates whether the authorized payment has been captured.', 'false'),
  description: field('string', 'Description or purpose associated with the payment transaction.', 'Payment for Loan FSAPLALONS000005012407'),
  card_id: field('string', 'Identifier of the card used for the payment, if the payment method is card.', null),
  bank: field('string', 'Name or identifier of the bank used for the payment, where applicable.', null),
  wallet: field('string', 'Wallet used for the payment, where applicable.', null),
  vpa: field('string', 'Virtual Payment Address (VPA) used for the UPI transaction.', 'd*******y'),
  email: field('string', "Customer's email address associated with the payment.", 'c******@example.com'),
  contact: field('string', "Customer's contact number associated with the payment.", '********7685'),
  notes: field('object', 'Additional metadata associated with the payment, such as loan number and customer name.'),
  fee: field('string', 'Payment processing fee charged for the transaction, if available.', null),
  tax: field('string', 'Tax amount applicable to the payment processing fee, if available.', null),
  error_code: field('string', 'Error code returned if the payment failed. Returns null when there is no error.', null),
  error_description: field('string', 'Detailed description of the payment error, if applicable.', null),
  error_source: field('string', 'Identifies the source or component where the payment error occurred.', null),
  error_step: field('string', 'Identifies the step in the payment flow where the error occurred.', null),
  error_reason: field('string', 'Specifies the reason for the payment failure or error.', null),
  acquirer_data: field('object', 'Contains transaction details provided by the acquiring bank or payment network, such as RRN and UPI transaction ID.'),
  created_at: field('string', 'Unix timestamp indicating when the payment was created.', '1753562735'),
  'upi.vpa': field('string', 'Virtual Payment Address used for the UPI payment.', 'devpk@pay'),
  'upi.flow': field('string', 'UPI payment flow used for the transaction, such as collect.', 'collect'),
}, ['id', 'entity', 'amount', 'currency', 'status', 'order_id', 'method']);

const statusEndpoint = {
  method: 'GET', path: '/api/v1/razorpay/payments/status', tag: 'Payment', deprecated: false,
  summary: 'Retrieves the current status of a Razorpay payment.',
  details: {
    description: 'Retrieves the payment status from Razor pay using the payment reference provided by the source system. Use it to verify whether a payment was successful, failed, pending, or is in another applicable state.',
    auth: 'inherit',
    parameters: headerParams('pay_Rg4xmKitUeqHO1'),
    requestBody: null,
    responses: [
      { status: '200', description: 'Successful response', contentType: 'application/json', schema: statusResponseSchema, example: '{\n  "id": "pay_Rop5tyzxBi",\n  "entity": "payment",\n  "amount": 100,\n  "currency": "INR",\n  "status": "authorized",\n  "order_id": "order_RTsgyur9699Xi2",\n  "method": "upi",\n  "amount_refunded": 0,\n  "captured": "false",\n  "description": "Payment for Loan FSAPLALONS000005012407",\n  "vpa": "d*******y",\n  "email": "c******@example.com",\n  "contact": "********7685",\n  "error_code": "null",\n  "created_at": "1753562735",\n  "upi.vpa": "devpk@pay",\n  "upi.flow": "collect"\n}' },
      { status: '400', description: 'Razorpay rejected the request - the payment id does not exist.', contentType: 'application/json',
        schema: schema({ error: field('object', 'The error envelope.'), 'error.statuscode': field('integer', 'HTTP-equivalent status code echoed inside the error envelope.', 400), 'error.errorType': field('string', 'Machine-readable error classification (MuleSoft-side or APIKit validation error type).', 'HTTP:BAD_REQUEST'), 'error.description': field('string', 'Human-readable description of what went wrong.', 'The id provided does not exist') }),
        example: '{\n  "error": {\n    "statuscode": 400,\n    "errorType": "HTTP:BAD_REQUEST",\n    "description": "The id provided does not exist"\n  }\n}' },
      { status: '500', description: "Unhandled MuleSoft expression error - the required 'id' header was missing and not validated before use.", contentType: 'application/json',
        schema: schema({ error: field('object', 'The error envelope.'), 'error.statuscode': field('integer', 'HTTP-equivalent status code echoed inside the error envelope.', 500), 'error.errorType': field('string', 'Machine-readable error classification (MuleSoft-side or APIKit validation error type).', 'MULE:UNKNOWN'), 'error.description': field('string', 'Human-readable description of what went wrong.', 'Expression {paymentId} evaluated to null.') }),
        example: '{\n  "error": {\n    "statuscode": 500,\n    "errorType": "MULE:UNKNOWN",\n    "description": "Expression {paymentId} evaluated to null."\n  }\n}' },
    ],
    errors: [
      { code: 'HTTP:BAD_REQUEST', message: 'The id provided does not exist', description: 'The payment id is unknown to Razorpay.' },
      { code: 'MULE:UNKNOWN', message: 'Expression {paymentId} evaluated to null.', description: 'The id header is missing and is not validated before use.' },
    ],
    samples: [{ title: 'Check a payment (masked)', language: 'curl', code: 'curl --request GET "https://<host>/api/v1/razorpay/payments/status" \\\n  --header "CORRELATION-ID: GDHY4357WG76" \\\n  --header "CLIENT-ID: <client id>" \\\n  --header "CLIENT-SECRET: <client secret>" \\\n  --header "Authorization: Basic <base64 username:password>" \\\n  --header "id: pay_Rg4xmKitUeqHO1"' }],
    dependencies: [{ name: 'Razorpay (Payment Gateway)', note: 'Returns the payment object.' }],
    flow: FLOW_STATUS,
  },
};

const TASKS = [
  { title: 'Build the Create Order API (POST /api/v1/create)', priority: 'High', done: true, description: 'MuleSoft flow that creates a Razorpay order from amount, currency and receipt and returns the order details.' },
  { title: 'Build the Payment Status API (GET /api/v1/razorpay/payments/status)', priority: 'High', done: true, description: 'MuleSoft flow that returns the current status of a Razorpay payment from the payment id header.' },
  { title: 'Document both endpoints in Project Tracker (headers, responses, request flow)', priority: 'Medium', done: true, description: 'API reference with the two endpoints, lifecycle stage Production, version 1.0.1, request flow diagrams, full response field tables and masked examples.' },
  { title: 'SECURITY FINDING: enforce CLIENT-SECRET validation in MuleSoft', priority: 'Critical', done: false, description: 'Confirmed on UAT 2026-09-22: CLIENT-SECRET is sent with every call but a deliberately invalid value still succeeded on both endpoints. Ask the platform/security team to verify server-side enforcement of this header as a priority.' },
  { title: 'Fix HTTP 500 on the status API when the id header is missing', priority: 'High', done: false, description: 'A missing id header surfaces as MULE:UNKNOWN "Expression {paymentId} evaluated to null". Validate the header before use and return 400 with a clear message.' },
  { title: 'Return 400 consistently for missing required body fields on Create Order', priority: 'Medium', done: false, description: 'Today APIKIT returns required key [amount] not found. Agree the error envelope with consumers and document it.' },
  { title: 'Plan the payment-signature verification API (step 5 of the flow)', priority: 'Medium', done: false, description: 'The merchant verifies the payment signature on the backend through a separate API that is not part of this release.' },
  { title: 'UAT regression and sign-off for v1.0.1', priority: 'Medium', done: false, description: 'Re-run the happy path and the SECURITY FINDING scenarios on both endpoints after the fixes above.' },
];

// ---------------------------------------------------------------------------------------------------------- the run
(async () => {
  let me;
  if (API_KEY) {
    me = (await call('GET', '/me')).user;   // GET /me returns the workspace context ({ user, workspaces, current, ... }), not a bare user
    say(`Using an API key, acting as ${me.displayName} (${me.email}).`);
  } else {
    const login = await call('POST', '/auth/login', { email: EMAIL, password: PASSWORD });
    if (!login?.accessToken) throw new Error('Sign-in needs more than a password (two-step verification). Use an account without it, or run with PT_API_KEY instead.');
    token = login.accessToken;
    me = login.user;
    say(`Signed in as ${me.displayName} (${me.email}).`);
  }

  // team
  const teams = items(await call('GET', '/teams'));
  let team = teams.find((t) => t.name.toLowerCase() === TEAM.toLowerCase());
  if (!team) {
    if (DRY) say(`[dry] would create the team "${TEAM}"`);
    else { team = await call('POST', '/teams', { name: TEAM, description: 'MuleSoft integration team' }); say(`Created the team "${TEAM}".`); }
  } else say(`Team "${team.name}" found.`);

  // who the tasks go to: a named team member (by default "Prasanna"), falling back to whoever is running this
  const members = items(await call('GET', '/workspace/members'));
  const assignee = members.find((m) => m.displayName.toLowerCase().includes(ASSIGNEE.toLowerCase())) ?? me;
  if (assignee.id !== me.id) say(`Tasks will be assigned to ${assignee.displayName} (${assignee.email}).`);
  else if (members.length && !members.some((m) => m.displayName.toLowerCase().includes(ASSIGNEE.toLowerCase()))) say(`No workspace member matches "${ASSIGNEE}"; assigning to ${me.displayName} instead.`);
  if (team && !DRY) {
    const teamDetail = await call('GET', `/teams/${team.id}`, undefined, { allow404: true });
    if (!(teamDetail?.members ?? []).some((m) => m.userId === assignee.id)) {
      try { await call('POST', `/teams/${team.id}/members`, { userId: assignee.id }); say(`Added ${assignee.displayName} to "${team.name}".`); }
      catch (e) { say(`  (could not add ${assignee.displayName} to "${team.name}": ${e.message})`); }
    }
  }

  // project: created if missing; repaired in place (name, team, owner) if it already exists under a different team or a near match
  const projects = items(await call('GET', '/projects?pageSize=200'));
  let project = projects.find((p) => p.name.toLowerCase() === PROJECT.toLowerCase())
    ?? projects.find((p) => p.name.toLowerCase().replace(/[\s-]/g, '') === PROJECT.toLowerCase().replace(/[\s-]/g, ''));
  if (!project) {
    const groups = items(await call('GET', '/project-groups'));
    const group = groups.find((g) => GROUP ? g.name.toLowerCase() === GROUP.toLowerCase() : /mule|integration|api/i.test(g.name)) ?? groups[0];
    const body = { projectGroupId: group?.id ?? null, name: PROJECT, key: null, description: 'Razorpay payment integration on MuleSoft: Create Order and Payment Status APIs for the Payment Engine Portal.', priority: 'High', status: 'Active', ownerId: assignee.id, teamId: team?.id ?? null, startDate: '2026-08-30', dueDate: null, memberIds: [assignee.id, me.id], projectType: 'Integration', deliveryMethod: 'Agile' };
    if (DRY) say('[dry] would create the project'); else { await call('POST', '/projects', body); project = items(await call('GET', '/projects?pageSize=200')).find((p) => p.name.toLowerCase() === PROJECT.toLowerCase()); say(`Created the project ${project.key} · ${project.name}, team "${team?.name ?? '-'}", owner ${assignee.displayName}.`); }
  } else {
    say(`Project ${project.key} · ${project.name} found.`);
    const needsName = project.name !== PROJECT, needsTeam = team && project.teamId !== team.id, needsOwner = project.ownerId !== assignee.id;
    if (needsName || needsTeam || needsOwner) {
      if (DRY) say(`  [dry] would update: ${[needsName && 'name', needsTeam && 'team', needsOwner && 'owner'].filter(Boolean).join(', ')}`);
      else {
        await call('PUT', `/projects/${project.id}`, { name: PROJECT, description: project.description, priority: project.priority, status: project.status, ownerId: assignee.id, teamId: team?.id ?? project.teamId, startDate: project.startDate, dueDate: project.dueDate, version: project.version, projectType: project.projectType, deliveryMethod: project.deliveryMethod });
        say(`  updated: ${[needsName && 'name', needsTeam && `team -> ${team.name}`, needsOwner && `owner -> ${assignee.displayName}`].filter(Boolean).join(', ')}.`);
        project = items(await call('GET', '/projects?pageSize=200')).find((p) => p.id === project.id);
      }
    }
    if (!DRY && project) {
      const existingMembers = items(await call('GET', `/projects/${project.id}/members`, undefined, { allow404: true }));
      if (!existingMembers.some((m) => m.userId === assignee.id)) { try { await call('POST', `/projects/${project.id}/members`, { userId: assignee.id }); } catch { /* already a member */ } }
    }
  }

  // tasks for both endpoints, assigned to the named person
  if (project) {
    const statuses = items(await call('GET', `/projects/${project.id}/statuses`));
    const doneStatus = statuses.find((s) => s.category === 'Done') ?? statuses.find((s) => /done|complete/i.test(s.name));
    const todoStatus = statuses.find((s) => s.category === 'Todo') ?? statuses[0];
    const have = items(await call('GET', `/projects/${project.id}/tasks?pageSize=200`));
    const byTitle = new Map(have.map((t) => [t.title.toLowerCase(), t]));
    for (const t of TASKS) {
      const existing = byTitle.get(t.title.toLowerCase());
      if (existing) {
        if (!DRY && existing.assignee?.id !== assignee.id) {
          try {
            await call('PUT', `/tasks/${existing.id}`, { title: existing.title, description: existing.description, statusId: existing.statusId, priority: existing.priority, assigneeId: assignee.id, startDate: existing.startDate, dueDate: existing.dueDate, estimatedHours: existing.estimatedHours, actualHours: existing.actualHours, labelIds: (existing.labels ?? []).map((l) => l.id), version: existing.version, milestoneId: existing.milestoneId, stageId: existing.stageId });
            say(`  task reassigned to ${assignee.displayName}: ${t.title}`);
          } catch (e) { say(`  (could not reassign "${t.title}": ${e.message})`); }
        } else say(`  task exists: ${t.title}`);
        continue;
      }
      if (DRY) { say(`  [dry] task: ${t.title}`); continue; }
      await call('POST', `/projects/${project.id}/tasks`, { title: t.title, description: t.description, statusId: (t.done ? doneStatus : todoStatus)?.id ?? null, priority: t.priority, assigneeId: assignee.id, startDate: null, dueDate: null, estimatedHours: null, labelIds: null, parentTaskId: null });
      say(`  task created, assigned to ${assignee.displayName}: ${t.title}`);
    }
  }

  // document
  const types = items(await call('GET', '/document-types'));
  const apiType = types.find((t) => t.code === 'API');
  const found = items(await call('GET', `/documents?q=${encodeURIComponent(DOC_TITLE)}&pageSize=50`)).find((d) => d.title.toLowerCase() === DOC_TITLE.toLowerCase() && (!project || d.projectId === project.id));
  let document = found;
  if (!document) {
    if (DRY) { say('[dry] would create the API document'); return; }
    await call('POST', '/documents', { title: DOC_TITLE, typeId: apiType.id, projectId: project?.id ?? null, teamId: team?.id ?? null, visibility: 'Project', tags: ['mulesoft', 'razor pay api'], sections: null });
    document = items(await call('GET', `/documents?q=${encodeURIComponent(DOC_TITLE)}&pageSize=50`)).find((d) => d.title.toLowerCase() === DOC_TITLE.toLowerCase() && (!project || d.projectId === project.id));
    say(`Created the document ${document.key} · ${document.title}.`);
    const full = await call('GET', `/documents/${document.id}`);
    const d = full.document ?? full;
    await call('PUT', `/documents/${document.id}/sections`, {
      revision: d.revision ?? full.revision, sections: [
        { key: 'overview', content: doc(h('Overview'), 'This API lets merchant systems create Razorpay payment orders and check payment status. It runs on MuleSoft and passes calls to Razorpay. Create Order is the first step of the payment flow: it creates an order on the server side, which the web or mobile checkout then uses to collect payment.', h('Flow', 3), bullets('The merchant backend calls Create Order with amount, currency and receipt.', 'The API returns an order_id and order metadata.', 'order_id is passed to the checkout on the client side.', 'The customer completes the payment.', 'The merchant verifies the payment signature on the backend (separate API).'), diagram(FLOW)) },
        { key: 'authentication', content: doc(h('Authentication'), 'Static headers, no token endpoint. Every request carries CORRELATION-ID (caller-generated trace id), CLIENT-ID and CLIENT-SECRET (issued per source system) and Authorization (HTTP Basic).', 'Never expose CLIENT-SECRET or the Basic credentials in client code, logs or public documentation.', 'SECURITY FINDING (UAT, 2026-09-22): CLIENT-SECRET is sent with every call but was not enforced by MuleSoft; a deliberately invalid value still succeeded on both endpoints. The platform/security team should verify server-side enforcement as a priority.') },
        { key: 'requests', content: doc(h('Requests and responses'), 'Both endpoints are described in the API reference tab with their headers, full response field tables, example requests and responses, and request flow.') },
      ],
    });
    say('Filled the Overview, Authentication and Requests sections.');
  } else say(`Document ${found.key} · ${found.title} found; its text is left as it is.`);

  // API reference: one API, two endpoints
  const overview = await call('GET', `/documents/${document.id}/api`);
  let def = (overview.definitions ?? []).find((d) => d.name.toLowerCase() === 'razor pay');
  if (!def) {
    const made = await call('POST', `/documents/${document.id}/api/definitions`, { name: 'Razor pay', description: 'Create Razorpay payment orders and check payment status. Hosted on MuleSoft (Dev environment: DocTracker).', basePath: '/api/v1', version: '1.0.1', auth: 'Basic', authNote: 'Static headers (CORRELATION-ID + CLIENT-ID + CLIENT-SECRET + HTTP Basic), no token endpoint.', servers: [], stage: 'Production' });
    def = made.definition ?? made; say('Created the API "Razor pay" (Production, v1.0.1).');
    if (!def.id) def = ((await call('GET', `/documents/${document.id}/api`)).definitions ?? []).find((d) => d.name.toLowerCase() === 'razor pay');
  } else say('API "Razor pay" found.');
  const existing = items(await call('GET', `/documents/${document.id}/api/endpoints?definitionId=${def.id}&pageSize=100`));
  for (const ep of [createEndpoint, statusEndpoint]) {
    const match = existing.find((e) => e.method.toUpperCase() === ep.method && e.path === ep.path);
    if (match) {
      if (!DRY) { await call('PUT', `/documents/${document.id}/api/endpoints/${match.id}`, { definitionId: def.id, method: ep.method, path: ep.path, summary: ep.summary, tag: ep.tag, deprecated: false, ownerId: assignee.id, details: ep.details }).catch((e) => say(`  (could not refresh "${ep.method} ${ep.path}": ${e.message})`)); }
      say(`  endpoint exists (refreshed): ${ep.method} ${ep.path}`); continue;
    }
    if (DRY) { say(`  [dry] endpoint: ${ep.method} ${ep.path}`); continue; }
    await call('POST', `/documents/${document.id}/api/endpoints`, { definitionId: def.id, method: ep.method, path: ep.path, summary: ep.summary, tag: ep.tag, deprecated: false, ownerId: assignee.id, details: ep.details });
    say(`  endpoint added: ${ep.method} ${ep.path}`);
  }
  say('Done. Open Documents -> ' + DOC_TITLE + ' -> API reference.');
})().catch((e) => { console.error('\nStopped: ' + e.message); process.exit(1); });
