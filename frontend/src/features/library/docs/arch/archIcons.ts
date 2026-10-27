/**
 * Architecture Studio's component library: simple outline glyphs (24×24, stroke) with a default colour and label. They are generic shapes,
 * not product logos - the label says what the box is (e.g. "MuleSoft", "Salesforce").
 */
export interface ArchIcon { key: string; label: string; category: string; color: string; paths: string }

const I = (key: string, label: string, category: string, color: string, paths: string): ArchIcon => ({ key, label, category, color, paths });

export const CATEGORIES = ['Clients', 'Network & security', 'Integration', 'Compute', 'Data', 'Business apps', 'Channels', 'Observability', 'Generic'] as const;

export const ARCH_ICONS: ArchIcon[] = [
  I('user', 'User', 'Clients', '#5c7cfa', '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>'),
  I('users', 'Team', 'Clients', '#5c7cfa', '<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.5 3-6 7-6s7 2.5 7 6"/><circle cx="17" cy="7" r="2.5"/><path d="M17 12c3 0 5 2 5 5"/>'),
  I('web', 'Web app', 'Clients', '#4fa3f7', '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/>'),
  I('mobile', 'Mobile app', 'Clients', '#4fa3f7', '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/>'),
  I('desktop', 'Desktop', 'Clients', '#4fa3f7', '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>'),
  I('partner', 'Partner system', 'Clients', '#8b6cf0', '<path d="M3 12l4-4 4 3 3-3 7 7-4 4-6-5-3 3z"/>'),

  I('gateway', 'API gateway', 'Network & security', '#e0a83e', '<path d="M4 6h16v12H4z"/><path d="M4 10h16M9 14h6"/><path d="M1 12h3M20 12h3"/>'),
  I('loadbalancer', 'Load balancer', 'Network & security', '#e0a83e', '<circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="19" r="2.5"/><circle cx="12" cy="19" r="2.5"/><circle cx="19" cy="19" r="2.5"/><path d="M12 7.5v9M12 9l-6 7.5M12 9l6 7.5"/>'),
  I('firewall', 'Firewall', 'Network & security', '#ef5c6e', '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 9h18M3 15h18M9 4v5M15 9v6M9 15v5"/>'),
  I('auth', 'Identity / SSO', 'Network & security', '#ef5c6e', '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15" r="1.5"/>'),
  I('cdn', 'CDN / DNS', 'Network & security', '#35b8c9', '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>'),
  I('vpn', 'VPN / private link', 'Network & security', '#35b8c9', '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>'),

  I('mulesoft', 'MuleSoft', 'Integration', '#00a0df', '<circle cx="12" cy="12" r="9"/><path d="M7 15V9l5 5 5-5v6"/>'),
  I('api', 'REST API', 'Integration', '#35c491', '<path d="M8 6l-5 6 5 6M16 6l5 6-5 6"/><path d="M14 4l-4 16"/>'),
  I('esb', 'Integration flow', 'Integration', '#00a0df', '<circle cx="5" cy="12" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 12h5l5-6M12 12l5 6"/>'),
  I('queue', 'Queue', 'Integration', '#c55aa8', '<rect x="2.5" y="8" width="19" height="8" rx="1"/><path d="M7 8v8M11.5 8v8M16 8v8"/>'),
  I('topic', 'Event stream', 'Integration', '#c55aa8', '<path d="M3 7h12M3 12h18M3 17h12"/><path d="M17 4l3 3-3 3M17 14l3 3-3 3"/>'),
  I('webhook', 'Webhook', 'Integration', '#c55aa8', '<circle cx="6" cy="17" r="2.5"/><circle cx="18" cy="17" r="2.5"/><circle cx="12" cy="6" r="2.5"/><path d="M8.5 17h7M10.8 8.2 7.2 14.8M13.2 8.2l3.6 6.6"/>'),
  I('sftp', 'SFTP / file drop', 'Integration', '#8b6cf0', '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5 12 11l2.5 2.5"/>'),
  I('scheduler', 'Scheduler / batch', 'Integration', '#8b6cf0', '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/>'),

  I('server', 'Server', 'Compute', '#576277', '<rect x="4" y="3" width="16" height="7" rx="1.5"/><rect x="4" y="14" width="16" height="7" rx="1.5"/><path d="M8 6.5h.01M8 17.5h.01"/>'),
  I('container', 'Container', 'Compute', '#4fa3f7', '<path d="M12 2.5 21 7.5v9L12 21.5 3 16.5v-9z"/><path d="M12 12 21 7.5M12 12 3 7.5M12 12v9.5"/>'),
  I('function', 'Function', 'Compute', '#e0a83e', '<path d="M14 4h-2a3 3 0 0 0-3 3v10a3 3 0 0 1-3 3H5M6 11h8"/><path d="M15 13l5 6M20 13l-5 6"/>'),
  I('cluster', 'Cluster', 'Compute', '#576277', '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
  I('cloud', 'Cloud', 'Compute', '#35b8c9', '<path d="M7 18a5 5 0 0 1-.7-9.9A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"/>'),

  I('database', 'Database', 'Data', '#35c491', '<ellipse cx="12" cy="5.5" rx="7.5" ry="3"/><path d="M4.5 5.5v13c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-13M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"/>'),
  I('cache', 'Cache', 'Data', '#ef5c6e', '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
  I('storage', 'Object storage', 'Data', '#e0a83e', '<path d="M4 7l8-4 8 4-8 4z"/><path d="M4 7v10l8 4 8-4V7M12 11v10"/>'),
  I('warehouse', 'Data warehouse', 'Data', '#8b6cf0', '<path d="M3 21V9l9-6 9 6v12"/><path d="M7 21v-8h10v8M7 17h10"/>'),
  I('file', 'File', 'Data', '#576277', '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4M9 13h6M9 17h6"/>'),

  I('crm', 'CRM (Salesforce)', 'Business apps', '#00a1e0', '<path d="M7 18a5 5 0 0 1-.7-9.9A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"/><path d="M9 13h6"/>'),
  I('erp', 'ERP', 'Business apps', '#5c7cfa', '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 9v12"/>'),
  I('hrms', 'HRMS (Darwinbox)', 'Business apps', '#35c491', '<circle cx="12" cy="7" r="3"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/><path d="M3 11h4M17 11h4"/>'),
  I('loan', 'Loan system', 'Business apps', '#e0a83e', '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h4"/>'),
  I('payment', 'Payment gateway', 'Business apps', '#35c491', '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M2.5 9.5h19M6 15h3"/>'),
  I('bank', 'Bank / CBS', 'Business apps', '#576277', '<path d="M3 10 12 4l9 6H3zM5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/>'),
  I('collection', 'Collections', 'Business apps', '#c55aa8', '<circle cx="12" cy="12" r="9"/><path d="M15 9.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .9-3 2s1.3 1.8 3 2 3 .9 3 2-1.3 2-3 2c-1.4 0-2.5-.5-3-1.5M12 6v12"/>'),

  I('whatsapp', 'WhatsApp', 'Channels', '#25d366', '<path d="M4 20l1.3-4A8 8 0 1 1 8 18.7z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1-1.5-2-1-1 1c-1-.5-2-1.5-2.5-2.5l1-1-1-2z"/>'),
  I('email', 'E-mail', 'Channels', '#4fa3f7', '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>'),
  I('sms', 'SMS', 'Channels', '#8b6cf0', '<path d="M4 4h16v12H8l-4 4z"/><path d="M8 9h8M8 12h5"/>'),
  I('voice', 'Voice / IVR', 'Channels', '#ef5c6e', '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>'),
  I('portal', 'Self-service portal', 'Channels', '#5c7cfa', '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 14h8"/>'),

  I('logs', 'Logs', 'Observability', '#576277', '<path d="M4 5h16M4 10h16M4 15h10M4 20h7"/>'),
  I('monitor', 'Monitoring', 'Observability', '#35b8c9', '<path d="M3 12h4l3-7 4 14 3-7h4"/>'),
  I('alert', 'Alerting', 'Observability', '#ef5c6e', '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>'),

  I('box', 'Component', 'Generic', '#576277', '<rect x="4" y="4" width="16" height="16" rx="3"/>'),
  I('note', 'Note', 'Generic', '#e0a83e', '<path d="M5 3h10l4 4v14H5z"/><path d="M15 3v4h4M8 12h8M8 16h6"/>'),
  I('settings', 'Config', 'Generic', '#576277', '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>'),
];

export const iconByKey = new Map(ARCH_ICONS.map((i) => [i.key, i]));
export const SWATCHES = ['#5c7cfa', '#4fa3f7', '#35b8c9', '#00a0df', '#35c491', '#e0a83e', '#ef5c6e', '#c55aa8', '#8b6cf0', '#576277'];
