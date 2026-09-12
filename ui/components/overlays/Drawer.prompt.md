Side panel (filters, provider preview, admin detail) or bottom sheet on mobile.

```jsx
<Drawer open={open} onClose={close} title="Filters" side="end"
  footer={<><Button variant="ghost" fullWidth>Reset</Button><Button fullWidth>Show 24 results</Button></>}>…</Drawer>
```

`side="start"|"end"` mirror in RTL — never use `left`/`right`.
