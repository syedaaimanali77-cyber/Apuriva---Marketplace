Inline approval the assistant must obtain before booking, paying, cancelling or changing account settings.

```jsx
<AiConfirmationCard summary="I can book this for you now."
  parameters={[{label:'Provider',value:'Ali Raza'},{label:'Service',value:'AC Repair'},
               {label:'When',value:'Thu 14 Mar, 5:00 PM'},{label:'Price',value:'Rs. 3,200 PKR'}]}
  confirmLabel="Yes, book it" onConfirm={go} onCancel={stop} />
```

Low-risk actions (search, summarise, translate) need no confirmation. Restricted actions are never offered here at all.
