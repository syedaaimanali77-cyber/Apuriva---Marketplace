import { PlaceholderPage } from '@/app/_components/PlaceholderPage';

/** Spec 014 §2 AC-6/§8 risk 6 — the admin "Settings" nav destination. Role/permission
 * configuration (spec 009) already exists and lives here rather than as an orphaned route now
 * that Settings is its own nav item; AI usage & cost (spec 033) joins it the same way, and
 * feature flags (spec 041) will once implemented. */
export default function AdminSettingsPage() {
  return (
    <PlaceholderPage
      title="Settings"
      description="Role and permission configuration and AI usage & cost already exist — reachable here. Feature-flag management (spec 041) will join once implemented."
      links={[
        { href: '/admin/roles', label: 'Roles & permissions' },
        { href: '/admin/settings/ai-usage', label: 'AI usage & cost' },
      ]}
    />
  );
}
