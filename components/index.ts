/**
 * Public entry point for the integrated APURIVA Design System primitives (spec 002).
 * Every later screen spec imports from here (`@/components`), not from `ui/` directly —
 * `ui/` stays the design system's own source, this module is the app-facing integration of it.
 *
 * Dialog, Menu, and Tabs are named by spec 002 but have no implementation present in ui/ (only
 * referenced in ui/_ds_manifest.json's component registry — no .jsx/.d.ts files exist for them in
 * this export of the design system). They are intentionally omitted here rather than
 * reimplemented from scratch. `ConfirmDialog` is the one exception: spec 008 needs a destructive
 * confirmation dialog for its own UI (§5) and builds one from existing tokens (./ConfirmDialog.tsx)
 * the same way app/account/_components/AccountMenu.tsx builds its own dropdown for the same
 * reason — not a `ui/` design-system component, but exported from here since it's a genuinely
 * reusable app-facing primitive. `PriceDisplay`/`FAQList`/`PackageCard` are spec 011's own
 * additions, built the same way, for the same reason. `Map` (spec 012) is the same case as
 * `Dialog`/`Menu`/`Tabs` above — named by spec 002, no `ui/` implementation exists — built here
 * instead, deliberately vendor-agnostic since no maps vendor is selected yet (spec 012 §8 risk
 * #1). `AddressForm` (spec 012) is its own addition, the same way as `PriceDisplay` etc.
 * `SearchBar`/`ResultCard`/`IntentChip` (spec 013) are the same case again — named by spec 013,
 * no `ui/` implementation exists, built here. `ActiveBookingBanner`/`Switch` (spec 014) DO have a
 * real `ui/` implementation (`ui/components/marketplace/ActiveBookingBanner`,
 * `ui/components/forms/Switch`) and are thin re-exports, the same way `Table` is — unlike
 * `BottomTabBar`/`SideNav` (also spec 014), which are named in `ui/_ds_manifest.json`'s registry
 * but (like `Dialog`/`Menu`/`Tabs`) have no `.jsx` on disk to import, so they're built directly in
 * `app/components/` instead — app-shell chrome alongside `AppHeader`, not generic design-system
 * primitives, so they're intentionally not re-exported from this barrel either.
 */
export * from './ActiveBookingBanner';
export * from './Alert';
export * from './AddressForm';
export * from './Badge';
export * from './Button';
export * from './Card';
export * from './Checkbox';
export * from './ConfirmDialog';
export * from './EmptyState';
export * from './ErrorState';
export * from './FAQList';
export * from './FormField';
export * from './Icon';
export * from './IconButton';
export * from './Input';
export * from './IntentChip';
export * from './Map';
export * from './OtpInput';
export * from './PackageCard';
export * from './PriceDisplay';
export * from './Radio';
export * from './ResultCard';
export * from './SearchBar';
export * from './Select';
export * from './Skeleton';
export * from './Switch';
export * from './Table';
export * from './Toast';
