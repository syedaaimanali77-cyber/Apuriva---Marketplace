import { PlaceholderPage } from '@/app/_components/PlaceholderPage';

/** Spec 014 §2 AC-4/AC-5 — the shared "Account" nav destination for both customer and provider
 * mode. Profile/payment-method content itself is out of this spec's scope; the settings already
 * built by earlier specs are linked from here. */
export default function AccountPage() {
  return (
    <PlaceholderPage
      title="Account"
      description="Manage your addresses and privacy & security settings."
      links={[
        { href: '/account/addresses', label: 'Addresses' },
        { href: '/account/notifications', label: 'Notifications' },
        { href: '/account/privacy-security', label: 'Privacy & security' },
      ]}
    />
  );
}
