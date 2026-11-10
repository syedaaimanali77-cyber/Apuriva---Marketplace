Admin/provider data table. Real `<table>` semantics with scoped headers; money columns use `numeric` for tabular figures.

```jsx
<Table caption="Recent payouts" rows={payouts} columns={[
  { key:'id', header:'Payout' },
  { key:'amount', header:'Net', align:'end', numeric:true },
  { key:'status', header:'Status', render: r => <Badge tone={r.tone}>{r.status}</Badge> }]} />
```
