import { PlaceholderPage } from '@/app/_components/PlaceholderPage';

/** Spec 014 §2 AC-6/§8 risk 6 — the admin "Operations" nav destination. Links out to the
 * already-implemented spec-009 approvals/post-action-review flows rather than moving those
 * routes' files (see spec 014 §8 risk 6 for why). */
export default function AdminOperationsPage() {
  return (
    <PlaceholderPage
      title="Operations"
      density="dense"
      description="Approvals and post-action reviews already exist — reachable here rather than as orphaned routes now that Operations is its own nav item."
      links={[
        { href: '/admin/approvals', label: 'Pending approvals' },
        { href: '/admin/actions/review', label: 'Post-action review' },
        { href: '/admin/operations/refunds', label: 'Refunds' },
        { href: '/admin/operations/payouts', label: 'Payouts' },
      ]}
    />
  );
}
