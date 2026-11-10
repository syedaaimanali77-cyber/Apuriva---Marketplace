Confirmation bound to concrete parameters — required for booking, payment, cancellation and any AI high-risk action.

```jsx
<ConfirmDialog open={open} title="Confirm booking"
  parameters={[{label:'Provider',value:'Ali Raza'},{label:'Service',value:'AC Repair'},
               {label:'When',value:'Thu 14 Mar, 5:00 PM'},{label:'Price',value:'Rs. 3,200'}]}
  confirmLabel="Confirm & pay" onConfirm={go} onCancel={close} />
```

If any parameter changes, re-confirm.
