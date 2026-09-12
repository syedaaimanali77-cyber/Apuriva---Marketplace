import { PlaceholderPage } from '@/app/_components/PlaceholderPage';

/** Spec 014 §2 AC-6/§8 risk 6 — the admin "Settings" nav destination. Role/permission
 * configuration (spec 009) already exists and lives here rather than as an orphaned route now
 * that Settings is its own nav item; feature flags (spec 041) will join once implemented. */
export default function AdminSettingsPage() {
  return (
    <PlaceholderPage
      title="Settings"
      density="dense"
      description="Role and permission configuration already exists — reachable here. Feature-flag management (spec 041) will join once implemented."
      links={[{ href: '/admin/roles', label: 'Roles & permissions' }]}
    />
  );
}
