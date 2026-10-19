/**
 * BrowserContext network lock. Install on a FRESH context BEFORE any page/navigation: every request is decided by decide() BEFORE it
 * leaves the browser; a refused request is aborted and never reaches any server. Service workers are blocked (they could otherwise
 * bypass context interception) and WebSockets are refused. `enforce:false` reproduces the former record-only behaviour and exists
 * only so the negative tests can show RED.
 */
import type { Browser, BrowserContext } from 'playwright-core';
import { decide, type Decision, type LockConfig } from './fullapp-guard';

export interface Logged { method: string; url: string; decision: Decision }
export interface LockedContext { context: BrowserContext; log: Logged[]; violations: () => Logged[] }

export async function newLockedContext(browser: Browser, cfg: LockConfig, enforce = true): Promise<LockedContext> {
  const context = await browser.newContext({ serviceWorkers: enforce ? 'block' : 'allow' });
  const log: Logged[] = [];
  await context.route('**/*', async (route) => {
    const r = route.request();
    const decision = decide(r.method(), r.url(), cfg);
    log.push({ method: r.method(), url: r.url(), decision });
    if (decision.allow || !enforce) await route.continue(); else await route.abort('blockedbyclient');
  });
  await context.routeWebSocket(/.*/, (ws) => {
    log.push({ method: 'WS', url: ws.url(), decision: { allow: false, severity: 'violation', reason: 'websocket refused' } });
    if (enforce) void ws.close(); else ws.connectToServer();
  });
  context.on('serviceworker', (w) => log.push({ method: 'SW', url: w.url(), decision: { allow: false, severity: 'violation', reason: 'service worker started inside the lock' } }));
  return { context, log, violations: () => log.filter((l) => l.decision.severity === 'violation') };
}
