Radio plus a `RadioGroup` fieldset/legend wrapper — the legend is what screen readers announce as the question.

```jsx
<RadioGroup legend="Pricing model">
  <Radio name="pm" label="Fixed price" checked={v==='fixed'} onChange={()=>setV('fixed')} />
  <Radio name="pm" label="Get offers" description="Providers send you quotes." checked={v==='quote'} onChange={()=>setV('quote')} />
</RadioGroup>
```
