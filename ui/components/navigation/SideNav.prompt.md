Desktop primary navigation — same IA as the mobile tab bar, different layout. Pass `{ section: 'Label' }` entries to group items (admin).

```jsx
<SideNav tone="dark" activeId="overview" onSelect={go}
  header={<Logo tone="light" size={20} />}
  items={[{id:'overview',label:'Overview',icon:'layout-dashboard'},{section:'Marketplace'},…]} />
```
