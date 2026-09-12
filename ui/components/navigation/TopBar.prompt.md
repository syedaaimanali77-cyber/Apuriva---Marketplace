App header. Start slot for the logo, centre for search or title, end for notifications / assistant / account.

```jsx
<TopBar start={<Logo size={20} />} end={<><IconButton icon="bell" label="Notifications" /><Avatar name="Sana K" size="sm" /></>}>
  <SearchField size="md" />
</TopBar>
```
