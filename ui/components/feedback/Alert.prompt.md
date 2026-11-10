Inline, in-flow message tied to the surrounding content. Error tone uses `role="alert"`; others `role="status"`.

```jsx
<Alert tone="error" title="Payment wasn't completed" actions={<Button size="sm">Try again</Button>}>
  No charge was confirmed.
</Alert>
```

Icon + text + colour together — never colour alone.
