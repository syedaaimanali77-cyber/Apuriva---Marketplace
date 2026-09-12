A provider's offer against a request — the unit of the offer comparison screen.

```jsx
<OfferCard providerName="Ali Raza" rating={4.8} reviewCount={126} verified topMatch
  price="Rs. 3,200" arrival="Arrives in ~35 min" duration="1–2 hrs"
  includes={['Gas top-up','30-day warranty']} message="I can be there by 5 PM."
  secondsRemaining={42}
  actions={<><Button size="sm">Accept offer</Button><Button size="sm" variant="ghost">Request change</Button></>} />
```

Expired offers stay visible in history, dimmed and non-actionable.
