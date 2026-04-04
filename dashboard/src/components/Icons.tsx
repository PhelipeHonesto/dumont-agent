/** Inline SVG icons for the dashboard. No external icon library needed. */

const S = { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

type P = { size?: number; color?: string };

export function ShieldCheck(p: P) { const sz = p.size ?? 14; return (<svg {...S} width={sz} height={sz} color={p.color} aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></svg>); }
export function ShieldAlert(p: P) { const sz = p.size ?? 14; return (<svg {...S} width={sz} height={sz} color={p.color} aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>); }
export function ShieldX(p: P) { const sz = p.size ?? 14; return (<svg {...S} width={sz} height={sz} color={p.color} aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><line x1="9" y1="9" x2="15" y2="15" /><line x1="15" y1="9" x2="9" y2="15" /></svg>); }
export function Clock(p: P) { const sz = p.size ?? 14; return (<svg {...S} width={sz} height={sz} color={p.color} aria-hidden="true"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>); }
export function TrendUp(p: P) { const sz = p.size ?? 12; return (<svg {...S} width={sz} height={sz} color={p.color} aria-hidden="true"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" /></svg>); }
export function TrendDown(p: P) { const sz = p.size ?? 12; return (<svg {...S} width={sz} height={sz} color={p.color} aria-hidden="true"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6" /><polyline points="17 18 23 18 23 12" /></svg>); }
export function Plane(p: P) { const sz = p.size ?? 40; return (<svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" stroke={p.color ?? "currentColor"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" /></svg>); }

// ── New icons for communication layer ────────────────────────────────────

export function Mail(p: P) { const sz = p.size ?? 14; return (<svg {...S} width={sz} height={sz} color={p.color} aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" /></svg>); }
export function Phone(p: P) { const sz = p.size ?? 14; return (<svg {...S} width={sz} height={sz} color={p.color} aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" /></svg>); }
export function MessageSquare(p: P) { const sz = p.size ?? 14; return (<svg {...S} width={sz} height={sz} color={p.color} aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>); }
export function Globe(p: P) { const sz = p.size ?? 14; return (<svg {...S} width={sz} height={sz} color={p.color} aria-hidden="true"><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>); }
export function Mic(p: P) { const sz = p.size ?? 14; return (<svg {...S} width={sz} height={sz} color={p.color} aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="22" /></svg>); }
export function Send(p: P) { const sz = p.size ?? 14; return (<svg {...S} width={sz} height={sz} color={p.color} aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>); }
export function FileText(p: P) { const sz = p.size ?? 14; return (<svg {...S} width={sz} height={sz} color={p.color} aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>); }
export function Inbox(p: P) { const sz = p.size ?? 14; return (<svg {...S} width={sz} height={sz} color={p.color} aria-hidden="true"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></svg>); }
export function Zap(p: P) { const sz = p.size ?? 14; return (<svg {...S} width={sz} height={sz} color={p.color} aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>); }
