Immediate-effect toggle (settings, personalization, notification categories). For form values that need saving, use Checkbox instead.

```jsx
<Switch id="pz" label="Personalized recommendations" description="Uses your history to rank results." checked={on} onChange={setOn} />
```

Implemented as `role="switch"` with `aria-checked`.
