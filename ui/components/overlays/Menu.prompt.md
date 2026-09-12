Dropdown for account, role switching and row-level actions. Closes on outside click and Escape.

```jsx
<Menu trigger={<IconButton icon="menu" label="Account menu" />} items={[
  { label: 'Switch to provider mode', icon: 'briefcase', onSelect: swap },
  { separator: true },
  { label: 'Log out', icon: 'log-out', tone: 'danger', onSelect: out },
]} />
```

Role switching lives here, not in the primary navigation (master spec §9.3).
