The Ask Apuriva surface — a drawer on mobile, a side panel on desktop, opened from `AiAssistantLauncher`. Never a bottom-nav tab.

```jsx
<AiAssistantPanel composerValue={q} onComposerChange={e=>setQ(e.target.value)} onSend={send}
  footer={<AiSuggestedActions actions={['Compare offers','Book the top match']} />}>
  <AiMessage role="user">Need an electrician tomorrow in DHA.</AiMessage>
  <AiMessage>I found 6 available electricians.</AiMessage>
</AiAssistantPanel>
```

The composer accepts English, Urdu and Roman Urdu, plus voice and photo attachments.
