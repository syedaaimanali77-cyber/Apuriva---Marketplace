/**
 * Public entry point for the integrated APURIVA Design System primitives (spec 002).
 * Every later screen spec imports from here (`@/components`), not from `ui/` directly —
 * `ui/` stays the design system's own source, this module is the app-facing integration of it.
 *
 * Dialog, Menu, and Tabs are named by spec 002. Earlier exports of the design system shipped no
 * implementation for them; the restored ui/ now includes them (ui/components/overlays,
 * ui/components/navigation), but nothing re-exports them here until a screen adopts them — the
 * app-built stand-ins described below stay in place until then. `ConfirmDialog` is one: spec 008 needs a destructive
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
 * `ui/components/forms/Switch`) and are thin re-exports, the same way `Table` is. `Logo`/`TopBar`
 * are thin re-exports too (used by the app shell: `AppHeader`, `AuthShell`), as are `ListRow`/`Tag`
 * (placeholder pages, search suggestions, category filter chips).
 * `Textarea`/`RequestStatusTimeline` (spec 015) are thin re-exports for the same reason: both
 * already exist under `ui/` (`ui/components/forms/Textarea`,
 * `ui/components/marketplace/RequestStatusTimeline`) and spec 015 is simply the first screen to
 * need them, so nothing is reimplemented here. `BottomTabBar`/
 * `SideNav` (also spec 014) stay built directly in `app/components/` and are not re-exported: the
 * ui/ versions render `<button onClick>` items, while the app shell needs real `next/link`
 * navigation links — so those styles follow the ui/ components but the markup stays link-based.
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
export * from './ListRow';
export * from './Logo';
export * from './Map';
export * from './OtpInput';
export * from './PackageCard';
export * from './PriceDisplay';
export * from './Radio';
export * from './RequestStatusTimeline';
export * from './ResultCard';
export * from './SearchBar';
export * from './Select';
export * from './Skeleton';
export * from './Switch';
export * from './Table';
export * from './Tag';
export * from './Textarea';
export * from './Toast';
export * from './TopBar';
