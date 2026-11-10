import { PlaceholderPage } from '@/app/_components/PlaceholderPage';

export default function AdminUsersPage() {
  return (
    <PlaceholderPage
      title="Users"
      density="dense"
      description="User account administration (search, suspend, view activity) is coming in a later spec. Role assignment already exists under Settings."
      links={[{ href: '/admin/settings', label: 'Go to Settings' }]}
    />
  );
}
