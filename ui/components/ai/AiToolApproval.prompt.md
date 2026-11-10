Permission gate for one MCP tool call, with the arguments it will run against.

```jsx
<AiToolApproval toolLabel="Send a message to Ali Raza" state="pending"
  description="I'll ask whether the AC is on the second floor."
  args={[{label:'conversation',value:'REQ-2841'},{label:'length',value:'1 message'}]}
  onApprove={ok} onDeny={no} />
```

Approval here is a UI courtesy — authorization is still enforced server-side. The AI is never the security boundary.
