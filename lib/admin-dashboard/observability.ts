/**
 * Spec 037 §9 "Observability" — one structured stdout event per dashboard request, following the
 * repository's `console.info(JSON.stringify({ event, … }))` convention. It carries the correlation
 * id and the load time only (master spec §117) — never a figure, an item or a setting.
 */
export type AdminDashboardServedEvent =
  | 'admin_dashboard.overview_served'
  | 'admin_dashboard.queue_served'
  | 'admin_dashboard.config_served';

export function logServed(event: AdminDashboardServedEvent, correlationId: string, startedAt: number): void {
  console.info(JSON.stringify({ event, correlationId, durationMs: Date.now() - startedAt }));
}
