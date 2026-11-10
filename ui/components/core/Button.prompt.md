The standard Apuriva action. One `primary` per view; everything else is `secondary` or `ghost`.

```jsx
<Button variant="primary" size="md" iconLeft="sparkles">Ask Apuriva</Button>
<Button variant="secondary">Compare offers</Button>
<Button variant="danger" iconLeft="circle-x">Cancel booking</Button>
```

Variants: primary (teal), secondary (teal outline), ghost, accent (amber — highlights/achievements only, never warnings), danger, inverse (on navy surfaces). Sizes sm 32 / md 40 / lg 48; md and lg meet the 44px touch target with surrounding padding — prefer `lg` on mobile primary actions. `loading` blocks activation and announces aria-busy.
