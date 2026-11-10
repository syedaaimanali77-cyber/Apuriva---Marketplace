Countdown for the 2-minute offer window. Turns red and becomes assertive to screen readers under 30 seconds.

```jsx
<OfferTimer secondsRemaining={42} />
<OfferTimer expired />
```

**This display is cosmetic.** Expiry is decided server-side; always re-check with the backend before enabling Accept.
