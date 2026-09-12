import { PlaceholderPage } from '@/app/_components/PlaceholderPage';

/** Spec 014 §2 AC-6 — the admin "Overview" nav destination. Dashboard content itself (spec 037)
 * is out of this spec's scope; this links to what already exists. */
export default function AdminOverviewPage() {
  return (
    <PlaceholderPage
      title="Overview"
      density="dense"
      description="Admin dashboard content is coming soon (spec 037). In the meantime, jump straight to what's already built."
      links={[
        { href: '/admin/operations', label: 'Operations' },
        { href: '/admin/users', label: 'Users' },
        { href: '/admin/marketplace/catalog', label: 'Marketplace' },
      ]}
    />
  );
}
