Apuriva's primary discovery control — keyword, natural-language or voice. Renders as a real `role="search"` form.

```jsx
<SearchField value={q} onChange={e=>setQ(e.target.value)} onSubmit={run}
  placeholder="Need an electrician tomorrow around DHA…" />
```

AI interprets the phrasing; results still come from authoritative search. Never show AI-invented providers.
