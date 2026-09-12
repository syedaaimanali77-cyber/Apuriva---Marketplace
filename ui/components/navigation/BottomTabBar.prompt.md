Mobile primary navigation. The item set is fixed per persona (master spec §59–§61) — the AI assistant is never one of these tabs.

```jsx
<BottomTabBar activeId="home" onSelect={go} items={[
  {id:'home',label:'Home',icon:'house'},{id:'explore',label:'Explore',icon:'compass'},
  {id:'requests',label:'Requests',icon:'file-text',badge:2},
  {id:'bookings',label:'Bookings',icon:'calendar'},{id:'account',label:'Account',icon:'user'}]} />
```
