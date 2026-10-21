import type { ArchData, ArchNodeData } from './ArchCanvas';

const N = (id: string, icon: string, label: string, x: number, y: number, notes?: string): ArchNodeData => ({ id, kind: 'icon', icon, label, x, y, w: 160, h: 64, ...(notes ? { notes } : {}) });
const F = (id: string, label: string, x: number, y: number, w: number, h: number, color: string): ArchNodeData => ({ id, kind: 'frame', label, x, y, w, h, color });

/** Starting points: a request flow through an API gateway and MuleSoft's three API layers, an integration hub, and a WhatsApp support flow. */
export const TEMPLATES: { key: string; label: string; data: ArchData }[] = [
  {
    key: 'request', label: 'Request flow (API-led)',
    data: {
      nodes: [
        F('f1', 'MuleSoft (Anypoint)', 420, -40, 600, 170, '#00a0df'),
        N('client', 'mobile', 'Customer app', 0, 0), N('gw', 'gateway', 'API gateway', 210, 0, 'Policies: client_id enforcement, rate limit, JWT'),
        N('exp', 'mulesoft', 'Experience API', 440, 0), N('proc', 'mulesoft', 'Process API', 640, 0), N('sys', 'mulesoft', 'System API', 840, 0),
        N('db', 'loan', 'Loan system', 1080, 0), N('logs', 'logs', 'Logs & monitoring', 640, 200),
      ],
      edges: [
        { id: 'e1', source: 'client', target: 'gw', label: 'HTTPS', line: 'solid', animated: true, sourceHandle: 'r', targetHandle: 'l' },
        { id: 'e2', source: 'gw', target: 'exp', label: 'client_id', line: 'solid', sourceHandle: 'r', targetHandle: 'l' },
        { id: 'e3', source: 'exp', target: 'proc', label: '', line: 'solid', sourceHandle: 'r', targetHandle: 'l' },
        { id: 'e4', source: 'proc', target: 'sys', label: '', line: 'solid', sourceHandle: 'r', targetHandle: 'l' },
        { id: 'e5', source: 'sys', target: 'db', label: 'SQL / SOAP', line: 'solid', sourceHandle: 'r', targetHandle: 'l' },
        { id: 'e6', source: 'proc', target: 'logs', label: 'events', line: 'dotted', sourceHandle: 'b', targetHandle: 't' },
      ],
    },
  },
  {
    key: 'hub', label: 'Integration hub',
    data: {
      nodes: [
        N('sf', 'crm', 'Salesforce', 0, 0), N('ss', 'portal', 'Self-service app', 0, 110), N('wa', 'whatsapp', 'WhatsApp', 0, 220),
        N('gw', 'gateway', 'API gateway', 240, 110), N('mule', 'mulesoft', 'MuleSoft', 470, 110),
        N('loan', 'loan', 'Loan system', 720, 0), N('col', 'collection', 'Collections', 720, 110), N('hr', 'hrms', 'Darwinbox', 720, 220), N('pay', 'payment', 'Payment gateway', 720, 330),
      ],
      edges: [
        { id: 'e1', source: 'sf', target: 'gw', label: '', line: 'solid', sourceHandle: 'r', targetHandle: 'l' },
        { id: 'e2', source: 'ss', target: 'gw', label: '', line: 'solid', sourceHandle: 'r', targetHandle: 'l' },
        { id: 'e3', source: 'wa', target: 'gw', label: '', line: 'solid', sourceHandle: 'r', targetHandle: 'l' },
        { id: 'e4', source: 'gw', target: 'mule', label: '', line: 'solid', animated: true, sourceHandle: 'r', targetHandle: 'l' },
        { id: 'e5', source: 'mule', target: 'loan', label: '', line: 'solid', sourceHandle: 'r', targetHandle: 'l' },
        { id: 'e6', source: 'mule', target: 'col', label: '', line: 'solid', sourceHandle: 'r', targetHandle: 'l' },
        { id: 'e7', source: 'mule', target: 'hr', label: '', line: 'solid', sourceHandle: 'r', targetHandle: 'l' },
        { id: 'e8', source: 'mule', target: 'pay', label: '', line: 'dashed', sourceHandle: 'r', targetHandle: 'l' },
      ],
    },
  },
  {
    key: 'support', label: 'WhatsApp support flow',
    data: {
      nodes: [
        N('cust', 'user', 'Customer', 0, 0), N('wa', 'whatsapp', 'WhatsApp', 210, 0), N('ai', 'box', 'AI support employee', 420, 0),
        N('kb', 'note', 'Knowledge', 420, 140), N('api', 'mulesoft', 'Loan details API', 640, 140), N('tkt', 'settings', 'Ticket', 640, 0), N('team', 'users', 'Support team', 860, 0),
      ],
      edges: [
        { id: 'e1', source: 'cust', target: 'wa', label: 'message', line: 'solid', both: true, sourceHandle: 'r', targetHandle: 'l' },
        { id: 'e2', source: 'wa', target: 'ai', label: '', line: 'solid', both: true, sourceHandle: 'r', targetHandle: 'l' },
        { id: 'e3', source: 'ai', target: 'kb', label: 'answers from', line: 'dotted', sourceHandle: 'b', targetHandle: 't' },
        { id: 'e4', source: 'ai', target: 'api', label: 'lookup', line: 'dashed', sourceHandle: 'b', targetHandle: 'l' },
        { id: 'e5', source: 'ai', target: 'tkt', label: 'raises', line: 'solid', animated: true, sourceHandle: 'r', targetHandle: 'l' },
        { id: 'e6', source: 'tkt', target: 'team', label: 'assigned', line: 'solid', sourceHandle: 'r', targetHandle: 'l' },
      ],
    },
  },
];
