Wrapper that gives any control its label, help text and error message with correct associations.

```jsx
<FormField label="Preferred date" htmlFor="date" help="We'll confirm with the provider." required>
  <Input id="date" type="date" />
</FormField>
```

Errors replace help text, render with an alert icon, and must be referenced by the control's `aria-describedby`.
