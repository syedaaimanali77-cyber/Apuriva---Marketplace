Modal surface: `role="dialog"`, `aria-modal`, Escape to close, focus moved to the first control.

```jsx
<Dialog open={open} onClose={close} title="Change your offer"
  footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button>Send revised offer</Button></>}>
  …
</Dialog>
```

For destructive or high-risk confirmations use `ConfirmDialog`, which binds the confirmation to the exact parameters.
