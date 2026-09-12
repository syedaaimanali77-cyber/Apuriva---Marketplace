Filter chip / removable token. Becomes a real button when `onClick` is supplied (with aria-pressed).

```jsx
<Tag icon="map-pin" selected onClick={toggle}>DHA</Tag>
<Tag onRemove={() => clear('budget')}>Under Rs. 3,000</Tag>
```
