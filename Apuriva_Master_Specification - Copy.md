# APURIVA — Master Product & Engineering Specification

**Working brand:** Apuriva
**Tagline:** Get the right help. Get it done.
**AI assistant:** Ask Apuriva
**Status:** Functional MVP specification
**Audience:** Claude Code / AI coding agent / development team
**Primary launch market:** Pakistan
**Architecture goal:** Production-minded MVP, modular and ready for future mobile apps and international expansion.

---

## 1. Executive Summary

Apuriva is a Pakistan-first, AI-assisted local-services marketplace connecting customers with verified service providers.

The core marketplace flow is:

Discover → Describe need → Match providers → Receive offers → Compare → Select → Pay/authorize → Service → Complete → Protect/dispute → Review

Apuriva is not merely a directory. It should support a real transactional marketplace with:

- Customers
- Providers
- Service catalog
- Service-specific request forms
- Natural-language and voice search
- Provider matching
- Offer negotiation
- Booking
- Payments
- Payment protection
- Messaging
- Reviews
- Disputes
- Safety workflows
- Provider earnings/payouts
- Admin operations
- AI assistant
- MCP tools
- Auditability
- Strong accessibility and security

The MVP must be fully functional at its core, while advanced features remain modular and can be implemented in Phase 2.

Do not build a fake UI-only prototype unless a real external integration is genuinely unavailable. Use realistic demo/sandbox behavior where appropriate.

---

## 2. Product Principles

These principles apply throughout the system.

### 2.1 Human + AI, not AI replacing governance

AI assists with discovery, interpretation, recommendations, summaries, drafting, and automation.

AI must not independently bypass:

- Authorization
- Payment controls
- Safety controls
- Admin permissions
- User ownership
- Confirmation requirements
- Marketplace rules

High-impact decisions remain human-controlled.

### 2.2 Server is authoritative

Never trust:

- Browser timers
- Frontend-only permissions
- Client-side payment status
- AI claims of success
- Client-side role checks
- Client-side ownership checks

The backend/database/payment provider must be authoritative.

### 2.3 Explainability

Important marketplace and AI actions should be understandable.

Examples:

- Why a provider was recommended
- Why an offer expired
- Why a payment failed
- What AI did
- What an admin changed

### 2.4 Safety over convenience

Critical actions require stronger controls.

### 2.5 Accessibility-first

Accessibility is a foundational requirement, not a final polish step.

### 2.6 Mobile-first but desktop-capable

The MVP is a responsive PWA/web app. The architecture must support future Android/iOS clients using the same APIs.

### 2.7 Pakistan-first, internationally extensible

Do not hard-code Pakistan into core business logic.

---

## 3. Brand & Visual Identity

### 3.1 Brand

**APURIVA**

The name is a working brand and can be replaced later.

Branding must be centralized so renaming does not require rewriting business logic.

Centralize:

- App name
- Logo
- Favicon
- App icon
- Tagline
- AI assistant name
- SEO metadata
- Social metadata
- Email templates
- Notification templates
- Legal/product references

### 3.2 Brand personality

The brand should feel:

- Modern
- Trustworthy
- Friendly
- Premium
- Human
- Helpful

Avoid:

- Corporate/cold aesthetics
- Childish/playful aesthetics
- Excessive futuristic AI imagery
- Generic marketplace visuals

### 3.3 Logo

Direction:

- Simple distinctive symbol + clean wordmark
- Geometric
- Abstract
- Connected/combined shapes
- Subtle concept of connection, service, or help
- Avoid generic wrench + robot + map-pin combinations

Logo should work as:

- Full logo
- App icon
- Favicon
- Avatar
- AI assistant icon
- Loading mark

### 3.4 Logo animation

Static by default.

Subtle animation may be used for:

- Loading
- Success
- Branded demo/marketing moments

Never delay the app for animation.

### 3.5 Colors

Primary palette direction:

- Blue-leaning teal
- Soft deep navy
- Warm amber accent
- Strong neutral foundation
- Semantic status colors

Exact values should be implemented as design tokens and checked for accessibility.

**Color behavior**

Teal:
- Primary actions
- Brand identity
- Links/interactive elements where appropriate

Deep navy:
- Headings
- Strong text
- Navigation
- High-contrast dark surfaces

Warm amber:
- Small accent
- Highlights
- Achievements
- Special recommendations
- Attention states that are not warnings

Semantic colors:
- Success
- Warning
- Error
- Info

Never communicate state through color alone. Use icon + text + color.

### 3.6 Typography

Use a highly readable modern sans for product UI.

Marketing may use a slightly more distinctive typographic treatment.

Urdu must use an appropriate RTL-compatible font stack.

Typography must support:

- English
- Urdu
- Mixed English/Urdu
- Roman Urdu input

### 3.7 Spacing

Adaptive density:

- Marketing: spacious
- Customer: comfortable
- Provider: moderately dense
- Admin: information-dense

Use a consistent spacing token system.

### 3.8 Radius

Use a coherent radius scale:

- Small for compact controls/data
- Medium for normal controls
- Larger for prominent cards/modals
- Pills for badges/tags only

Primary buttons use medium-rounded corners.

### 3.9 Cards

Mixed system:

- Simple list/settings rows: mostly flat
- Interactive cards: subtle elevation
- Important/active cards: stronger emphasis
- Provider cards: subtle elevation

### 3.10 Shadows

Very subtle.

Prefer spacing, borders, and surface contrast over heavy shadows.

### 3.11 Borders

Mixed but subtle:

- Inputs
- Cards
- Dividers
- Controls

Avoid excessive boxed-in layouts.

### 3.12 Backgrounds

Adaptive:

- Marketing can use more expressive branded surfaces
- Product UI uses soft neutral backgrounds
- Admin/provider can use denser neutral surfaces

### 3.13 Imagery

Use:

- Authentic photography
- Realistic service imagery
- Minimal illustrations for onboarding/empty states
- Generated placeholders only for demo data where needed

Avoid generic cheesy stock-photo aesthetics.

### 3.14 Motion

Smart hybrid:

- Subtle transitions
- Meaningful status motion
- Offer arrival animations
- Booking timeline transitions
- Upload progress
- Success/error micro-interactions
- More expressive marketing motion

Respect prefers-reduced-motion.

---

## 4. Technology Stack

### 4.1 Frontend

- Next.js
- React
- TypeScript
- Responsive PWA
- Accessible custom design system built on reliable accessible primitives

### 4.2 Backend

Use a modular monolith.

One deployable backend application with clear internal modules.

Suggested modules:

- Auth
- Users
- Customer profiles
- Provider profiles
- Services
- Categories
- Requests
- Offers
- Matching
- Bookings
- Payments
- Payouts
- Messaging
- Notifications
- Reviews
- Disputes
- Safety
- Support
- AI
- MCP
- Admin
- Analytics
- Audit
- Files
- Location

Do not start with microservices.

### 4.3 Database

Use a relational database with JSON fields.

Core relational entities should remain strongly structured.

JSON is appropriate for variable service-specific data.

Examples:

- Photographer package data
- AC repair details
- Electrician skills
- Vehicle information
- Service-specific requirements

Do not put the entire marketplace into arbitrary JSON.

### 4.4 Monorepo

Use a monorepo.

Suggested structure:

```
apps/
 web/
 api/
 worker/
packages/
 ui/
 types/
 config/
 validation/
 auth/
 ai/
 mcp/
 database/
 location/
 payments/
future:
 apps/
 mobile/
```

Keep applications independently deployable while sharing stable packages.

---

## 5. Internationalization

### 5.1 MVP language strategy

- English = default UI
- Urdu = full UI option
- Roman Urdu = supported natural input/chat/search style
- AI understands mixed English + Urdu + Roman Urdu
- Proper RTL support for Urdu

Roman Urdu is not a separate formal translated UI locale.

### 5.2 International readiness

Pakistan-first, but design for future countries.

Do not hard-code:

- Currency
- Country
- Address format
- Phone format
- Tax rules
- Payment rules
- Timezone
- Service-area assumptions

Use configuration/localization.

---

## 6. Currency & Money

Store money as:

```
integer minor_units + currency_code
```

Example:

```
250000 + PKR
```

for Rs. 2,500.00 when the currency uses two decimal places.

Never use floating-point arithmetic for financial calculations.

Money layer must handle:

- Service amount
- Commission
- Customer fees
- Discounts
- Refunds
- Partial refunds
- Provider earnings
- Payouts
- Adjustments

Formatting happens at presentation layer.

---

## 7. Time & Timezones

- Store authoritative timestamps in UTC
- Preserve relevant timezone context
- Display local time in UI
- Appointment time must retain intended local timezone
- Critical deadlines calculated server-side
- Never trust device clock
- Use a proper timezone database
- Handle daylight-saving rules where applicable

---

## 8. Location & Addresses

Use a provider-agnostic location abstraction.

The location layer should support swapping providers without rewriting the marketplace.

Capabilities:

- Maps
- Geocoding
- Reverse geocoding
- Distance
- Travel estimation where available
- Service area checks
- Navigation links

Address model:

- Structured address
- User-friendly label
- Latitude/longitude where appropriate
- Geographic hierarchy
- Privacy-aware exact-location visibility

Never expose exact coordinates unnecessarily.

Before provider selection: approximate area may be visible.

After booking: exact operational address can be revealed when necessary.

---

## 9. Authentication & Accounts

### 9.1 Authentication

Support:

- Phone + OTP
- Email + password
- Google
- Apple where supported

Phone + OTP should be the primary fast path.

### 9.2 Account model

One identity/account can have:

- Customer profile
- Provider profile

A user does not need duplicate accounts.

### 9.3 Role switching

Smart hybrid:

- Account menu quick switch
- Persistent mode indicator
- Customer mode
- Provider mode

Do not clutter the main navigation.

---

## 10. Onboarding

First-time experience:

- Very short value introduction
- Skippable
- Do not block exploration
- Ask location only when useful
- Signup only when needed
- Provider onboarding begins separately via "Become a Provider"

Guest browsing is allowed.

---

## 11. Guest Experience

Guests can:

- Browse categories
- Search services
- Search providers
- View provider profiles
- View reviews
- View portfolios
- Compare providers
- Use basic AI discovery
- Prepare a request
- Prepare a booking

Account is required for actions that need identity, including:

- Submitting a request
- Messaging
- Booking
- Payment
- Saving providers
- Tracking a personal booking

---

## 12. Location Permission UX

Do not request location immediately on first launch.

Ask when it provides value.

Example:

```
Find providers near you
Allow Apuriva to use your location for more accurate results.
>
[Allow Location] [Enter Area Manually]
```

If denied:

- Allow city/area/manual address
- Do not block general discovery

---

## 13. Home Personalization

Smart hybrid personalization.

New user: Curated/popular content

Returning user: Recent/relevant services, Saved providers

Active booking: Booking takes priority

Recommendations may use:

- Location
- History
- Preferences
- Availability
- Service relevance

Users can control personalization.

Show why recommendations appeared where useful.

---

## 14. Service Catalog

Seed 8 MVP categories:

1. Home Repair & Maintenance
2. Cleaning
3. Beauty & Wellness
4. Photography & Video
5. Moving & Delivery
6. Events
7. Automotive
8. Personal & Professional Services

Taxonomy:

```
Category
 └── optional subcategory
 └── service
```

Not every category needs a subcategory.

Admins control the catalog.

AI may suggest categories/services, but admin approves official additions.

---

## 15. Category Pages

Category landing pages should include:

- Category header
- Popular services
- Service-specific search
- Recommended/featured providers
- Nearby availability
- Relevant filters
- AI assistance
- View all services

Do not make category pages just lists.

---

## 16. Service Detail Pages

Each service page can include:

- Service overview
- Typical pricing/range
- What's included
- Packages
- Estimated duration
- Requirements/preparation
- FAQs
- Recommended providers
- Availability
- Service-specific reviews
- Book / Request Service
- Ask Apuriva

Pricing display depends on pricing model:

- Fixed → exact price
- Package → starting price
- Variable → typical range
- Quote → get offers
- Hourly → hourly rate

---

## 17. Service Requirements

Every service may define:

- Required fields
- Optional fields
- Service-specific questions
- Media requirements
- Duration
- Buffers
- Pricing model
- Verification requirements

AI can collect the same information conversationally.

Example AC Repair:

```
AC type: Split / Window
Problem: Not cooling
Brand: Optional
Photo: Optional
Access notes: Optional
```

Required data must be validated before submission.

---

## 18. Service FAQs

Official FAQs:

- Owned/controlled by admin
- AI may draft suggestions
- Admin reviews before publishing

Providers may add service-specific FAQs to their own offerings.

No AI-generated customer-facing FAQ should become official without appropriate review.

---

## 19. Search

Search is a major Apuriva differentiator.

Support:

- Keyword search
- Natural-language search
- Voice input
- Filters
- Location
- Service/category detection
- AI interpretation
- Autocomplete
- Recent searches

Example:

> "Need an electrician tomorrow around DHA, preferably under Rs. 3,000."

Interpretation:

```
Service: Electrician
Time: Tomorrow
Area: DHA
Budget: <= Rs. 3,000
```

AI interprets intent, but actual results must come from authoritative data/search infrastructure.

Never let AI invent providers/services.

---

## 20. Search Autocomplete

Suggestions can include:

- Recent searches
- Popular services
- Categories
- Service names
- Location suggestions
- Natural-language completions
- AI suggestions where useful

Example:

```
fix my ac...
AC Repair
AC Maintenance
Emergency AC Repair
AC Repair near me
```

---

## 21. Search Results Loading

Smart hybrid:

- Continuous/infinite loading on mobile
- Load more/pagination where useful on desktop
- Preserve filters
- Preserve sorting
- Preserve location
- Fast initial result set
- Skeleton loaders

Do not load hundreds of providers unnecessarily.

---

## 22. Empty Search Results

Never dead-end.

If no good match:

```
We couldn't find a match nearby.
Try:
- Expand service area
- Change date/time
- Adjust budget
- Browse nearby providers
- Post a request
```

AI can suggest the best next step.

---

## 23. Provider Matching

Use a transparent rule-based matching engine first.

Hard eligibility rules before ranking.

Eligibility may include:

- Service match
- Service area
- Availability
- Provider status
- Verification
- Required skills
- Capacity
- Reliability requirements

Then weighted ranking.

Potential ranking factors:

- Service match
- Availability
- Location
- Rating/review quality
- Response/reliability
- Price/budget fit
- Experience
- Verification
- Historical performance

Weights can differ by service.

Admins can configure business-level weights.

AI can suggest ranking improvements but cannot silently rewrite ranking rules.

---

## 24. Fair Provider Exposure

Prevent new providers from being permanently buried.

Smart hybrid:

- Quality/relevance remains primary
- New providers receive limited exploration exposure
- No hidden pay-to-rank manipulation
- Poor performance still affects ranking
- Monitor provider exposure/fairness
- Admin visibility into ranking behavior

Sponsored placements, if later enabled, are separate from organic ranking.

---

## 25. Sponsored Providers

Phase 2 feature.

If enabled:

- Clearly label "Sponsored"
- Never secretly manipulate organic ranking
- Cannot bypass hard eligibility/safety rules
- Organic ranking remains separate
- Sponsored changes are auditable

---

## 26. Pricing Models

Support:

**Fixed** — Provider publishes fixed price.

**Package** — Provider publishes packages.

**Hourly** — Provider sets hourly rate.

**Quote/request** — Customer submits request and providers send offers.

**Custom** — Customer/provider agree through offer flow.

AI may provide price guidance but never force prices.

---

## 27. Customer Budget

Budget is optional.

Customer may enter:

- Target amount
- Budget range
- "I'm not sure"

AI may suggest a range where enough data exists.

Providers can submit offers outside the suggested budget.

Actual offer price must always be explicit.

---

## 28. Request Creation

Request can include:

- Service
- Description
- Structured service fields
- Budget
- Preferred date/time
- Location
- Attachments
- Additional instructions
- Urgency

Media:

- Optional by default
- Service may recommend/require it
- AI can explain why it helps
- Preview before submit
- Multiple attachments within limits
- Customer controls sharing

---

## 29. Request Distribution

Use smart provider pool distribution.

Process:

```
Request
 ↓
Eligibility rules
 ↓
Matching/ranking
 ↓
Relevant provider pool
 ↓
Notify providers
```

Do not blast every provider.

Pool size should be configurable.

---

## 30. Provider Request Actions

Action depends on pricing model.

- Fixed/instant: **Accept**
- Quote-based: **Send Offer**
- Unsuitable: **Decline**

Provider may request clarification where appropriate.

---

## 31. Offer System

Core flow:

```
Request
→ Provider response
→ Offer
→ Customer comparison
→ Accept
→ Booking/payment
```

Offer fields may include:

- Price
- Currency
- Included items
- Provider message
- Availability
- Estimated duration
- Terms
- Expiration
- Offer version
- Audit metadata

---

## 32. Offer Timer

The agreed offer/request response window is:

**2 minutes**

Critical rule: The browser timer is cosmetic. The server/database decides expiry.

At expiry:

- Offer becomes Expired
- Cannot be accepted
- Remains in history
- Fresh offer required if still appropriate
- Provider can send a new offer if request remains active

---

## 33. Pre-booking Chat

Allow limited request-specific communication before provider selection.

Use cases:

> "Is the AC on the second floor?"

Rules:

- Conversation tied to request
- Contact-sharing protections
- Anti-spam limits
- May expire/close after selection
- Full ongoing conversation after provider selection

---

## 34. Offer Comparison

Show comparable offers with:

- Price
- Availability/arrival
- Rating
- Distance
- Badges
- What's included
- Provider message
- Why this provider/offer?
- Top Match indicator

Customer makes final decision.

---

## 35. Provider Comparison

Allow comparison of up to 3 providers/offers when comparison makes sense.

Disable comparison where it has little value.

---

## 36. Negotiation

Customer: Accept, Decline, Request change

Provider: Accept, Send revised offer

Every price change is recorded.

Final price must be confirmed by both sides.

AI can help structure communication but cannot secretly change the agreed amount.

---

## 37. Request Status

Customer sees:

```
Finding your provider

Request sent
↓
Providers notified
↓
Offers received
↓
Provider selected
↓
Payment
↓
Booking confirmed
```

Show:

- Current state
- Useful live information
- Offer timer
- Number of offers
- Relevant activity

Avoid overwhelming users.

---

## 38. Request Cancellation

Before provider selection:

- Generally quick cancellation
- Check current state
- Check any financial consequence
- Show consequence before confirmation
- Notify affected providers
- Record cancellation

---

## 39. Booking

Booking must be server-authoritative.

Before final confirmation:

- Revalidate provider availability
- Revalidate slot
- Revalidate price
- Revalidate permissions
- Revalidate offer state
- Prevent race-condition double booking

If slot disappears:

> "This time is no longer available."

Offer alternatives.

---

## 40. Provider Availability

Support:

- Weekly recurring schedule
- Date-specific overrides
- Blocked periods
- Existing bookings
- Service-specific durations
- Buffer times
- Instant availability
- Timezone awareness
- Double-booking prevention

Example:

```
Normal:
Mon-Fri 9:00-18:00

Override:
Friday unavailable
```

---

## 41. Provider Service Areas

Providers can configure:

- Radius
- Specific cities/areas
- Service-specific coverage
- Remote/online
- Travel limitations
- Minimum travel requirements

Examples:

```
AC Repair:
Lahore + 20 km

Online tutoring:
Nationwide/online
```

---

## 42. Provider Availability Visibility

Customer-facing states:

- Available
- Busy
- Unavailable

Provider may remain discoverable while unavailable.

Booking/offer actions disabled when unavailable.

Matching engine considers availability.

Customer can save/follow provider and optionally request availability notifications.

---

## 43. Arrival & Service Start

Provider workflow:

```
I've Arrived
↓
Start Service
```

Location/time signals may support verification but must not alone falsely change state.

Customer gets updates.

---

## 44. Service Progress

Core status: **In Progress**

Optional milestones:

- Started
- Working
- Almost done
- Custom service milestone

Do not force providers to constantly update status.

---

## 45. Completion

Provider can mark service complete.

Completion evidence:

- Optional by default
- Required by service/policy where needed
- Photos
- Videos
- Documents
- Admin can require evidence in disputes

Customer can view relevant evidence.

---

## 46. Payment Architecture

Payment timing is service-aware.

Examples:

- **Scheduled/fixed service** — Payment or authorization at booking.
- **Offer-based service** — Customer selects offer → payment/authorization.
- **Deposit service** — Deposit first, remainder later.
- **Final adjustments** — Customer explicitly approves before additional charge.

Never silently charge a changed amount.

Use a payment provider's supported authorization/hold/capture/payout capabilities.

Do not represent Apuriva as an escrow service unless legally and technically appropriate.

---

## 47. Payment Protection

Where money is paid before completion:

- Use provider-supported mechanisms
- Payment/authorization state tracked
- Provider payout not final until appropriate completion state
- Protection window configurable
- Customer can confirm completion
- Disputes can affect payout
- Automatic progression prevents abandoned bookings from staying stuck
- Admin rules configurable

---

## 48. Payouts

Provider payout lifecycle:

```
Pending
→ Eligible
→ Paid
```

Provider earnings dashboard:

- Gross
- Servio/Apuriva fee
- Refunds
- Adjustments
- Net
- Pending
- Upcoming
- Paid
- Booking-level details
- Filters
- Exportable statements

Payout methods:

- Bank
- Supported mobile wallets
- Default payout method
- Secure payout details
- Re-authentication for changes
- Failed payout recovery

Payment provider should handle sensitive payment credentials where possible.

---

## 49. Refunds

Support:

- Full refund
- Partial refund
- Automatic policy-driven refund
- Admin-controlled override where permitted

Status:

```
Requested
→ Processing
→ Completed / Failed
```

Refunds must reconcile with provider earnings.

All refunds audited.

---

## 50. Cancellation Policy

Smart hybrid.

Platform defaults. Service/category can override. Provider chooses from allowed options. Customer sees policy before booking/payment.

Possible timing-based policy:

```
>24h: free
12–24h: small fee
<12h: higher fee
```

Actual policy must be configurable.

---

## 51. No-show

Flow:

```
Report
→ Gather relevant signals
→ Other party responds
→ Apply policy
→ Resolve
```

Use:

- Booking timing
- Status history
- Location signals where appropriate
- Communications

Do not automatically accuse based solely on GPS/timestamps.

Repeated verified no-shows can affect reliability.

---

## 52. Reviews

Only eligible completed bookings can generate verified reviews.

Review system:

- Rating
- Text
- Optional media if supported
- Provider response
- Report review

Moderation:

- Spam detection
- Manipulation signals
- Profanity checks
- AI flags suspicious patterns
- Admin reviews disputed cases

Do not automatically suppress legitimate criticism.

---

## 53. Blocking & Reporting

Users can: Block, Report

Blocking may prevent future contact/matching where appropriate.

Existing booking communication required for safety/support remains available.

Safety team can override where necessary.

---

## 54. Messaging Privacy

Do not publicly expose personal phone/email.

Before selection:

- Request-specific messaging
- Approximate area
- Necessary service information

After booking:

- Operational information can be shared as needed

Use Servio/Apuriva communication by default.

Detect risky off-platform transaction/contact sharing.

Do not aggressively block legitimate service information.

---

## 55. Messaging Retention

- Active booking/request chats remain accessible
- Historical retention follows configurable policy
- Users can access permitted history
- Sensitive data follows retention rules
- Admin access restricted and audited

---

## 56. File Uploads

Support: Images, Videos, Documents

Requirements:

- File type limits
- File size limits
- Upload progress
- Preview where possible
- Secure storage
- Malware/security checks where applicable
- Access control
- Private storage for sensitive files
- Signed/time-limited URLs

Storage architecture:

- Object storage for files
- CDN for appropriate public media
- Private object storage for verification/evidence
- Image/video optimization

---

## 57. Notifications

Channels: Push, SMS, Email

Categories:

- Booking
- Messages
- Payments
- Security
- Promotions
- Provider requests/earnings
- Operational updates

Users control normal notification preferences.

Security/payment/necessary operational notifications may remain enabled.

---

## 58. Marketing Notifications

Marketing requires appropriate consent.

Keep marketing separate from transactional notifications.

Users can: Opt in, Opt out, Manage preferences

Do not use promotional notifications excessively.

---

## 59. Customer Navigation

Mobile primary navigation:

```
Home
Explore
Requests
Bookings
Account
```

AI is contextual, not a permanent required tab.

---

## 60. Provider Navigation

```
Dashboard
Requests
Schedule
Earnings
Account
```

---

## 61. Admin Navigation

```
Overview
Operations
Users
Marketplace
Analytics
Settings
```

---

## 62. Customer Support

Smart hybrid:

- AI handles common questions
- User can request human
- In-app support tickets
- Chat for active/urgent cases
- Category-based issue reporting
- Booking/payment/dispute context attached automatically
- Ticket history
- Priority
- Safety/payment escalation

---

## 63. Admin Support Workspace

Unified support inbox containing:

- Queue
- Priority
- Customer/provider
- Booking
- Payment
- Dispute
- Conversation
- Internal notes
- Attachments
- Assignment
- Team
- SLA/deadline
- AI summary
- Audit trail

---

## 64. Safety Incidents

Dedicated Safety Report workflow.

Capabilities:

- Serious issue reporting
- Priority classification
- Evidence preservation
- Restricted access
- Safety-team escalation
- Temporary restrictions where justified
- Human review
- Appropriate emergency guidance
- Full audit trail

AI must not independently decide serious safety enforcement.

---

## 65. Urgent Jobs

Some services can be marked urgent-capable.

Customer may select: **Urgent / ASAP**

Matching prioritizes currently available providers.

Urgent services can have different pricing/response rules.

AI must clarify that Apuriva is a marketplace, not an emergency authority.

For genuine emergencies, direct users to appropriate local emergency services.

---

## 66. Provider Account Lifecycle

Internal provider states:

```
Draft
Pending Verification
Active
Paused
Restricted
Suspended
Banned
```

Customer-facing status should be simplified.

---

## 67. Customer Account Lifecycle

```
Active
Restricted
Suspended
Banned
Deletion Pending
```

Use clear explanations and appeal/support paths where appropriate.

---

## 68. Admin Moderation

Admin actions:

- Warning
- Restriction
- Suspension
- Ban
- Content removal/hiding
- Booking intervention
- Authorized payout freeze
- Fraud escalation
- Safety escalation

Require:

- Reason
- Evidence where appropriate
- Audit record
- Appropriate approval for high-impact actions
- Appeal/review mechanism

---

## 69. Admin RBAC

Roles:

- **Super Admin** — Highest platform control.
- **Operations Admin** — Requests, bookings, providers.
- **Support Admin** — Support tickets and user support.
- **Finance Admin** — Payments, refunds, payouts.
- **Trust & Safety Admin** — Reports, disputes, safety.
- **Content/Marketplace Admin** — Services, categories, FAQs.
- **Analytics Admin** — Reporting/analytics.

Use least privilege.

---

## 70. Admin Approval / Four-Eyes

Risk-based:

- **Low risk** — One authorized admin.
- **Medium risk** — Authorized admin + reason/audit.
- **High risk** — Second-admin approval where appropriate.
- **Critical** — Elevated authorization + audit.

Potentially sensitive:

- Large refund
- Payout intervention
- Permanent ban
- Permission/security changes
- High-value financial adjustments

Emergency path must require post-action review.

---

## 71. Admin Configuration

Business admins can configure approved business features.

Examples:

- Service/category availability
- Urgent service
- Promotions
- AI suggestions
- Marketplace features
- Provider/customer capabilities
- Notification types
- Fees
- Cancellation policies
- Matching weights
- Service rules

Developers retain control of:

- Authentication/security
- Infrastructure
- Payment credentials
- Database infrastructure
- MCP authorization
- Safety-critical technical controls

---

## 72. Audit Logging

Audit all sensitive/admin actions.

Record:

- Actor
- Role
- Action
- Target
- Timestamp
- Before/after values where appropriate
- Reason
- Approval
- Request/correlation ID

Examples:

- Provider approval
- Commission change
- Refund
- Dispute resolution
- Booking intervention
- Permission change
- Service rule change
- Moderation
- Payout intervention

Audit logs are distinct from ordinary application logs.

---

## 73. Data Privacy

Backend is the authoritative privacy/security layer.

Frontend provides: Controls, Explanations, Settings

Database access uses least privilege.

MCP tools inherit backend authorization.

Sensitive fields have stricter access policies.

---

## 74. Privacy & Security Center

Users can manage:

- Profile visibility
- Location
- Personalization
- Marketing
- Data export
- Account deletion
- Sessions
- Security
- Connected login methods
- Privacy policy
- Terms

---

## 75. Account Deletion

Flow:

```
Request deletion
→ Security confirmation
→ Deletion pending/grace period
→ Resolve active bookings
→ Delete/anonymize personal data where appropriate
→ Retain legally/operationally required records
→ Confirm completion
```

Never delete required financial/audit records indiscriminately.

---

## 76. Data Export

Users can request applicable personal data including:

- Profile
- Bookings
- Reviews
- Permitted messages
- Saved preferences
- Receipts/transaction records
- Provider service metadata

Do not expose:

- Other users' information
- Security secrets
- Internal fraud signals
- Internal ranking signals
- Admin-only data

Generate exports asynchronously and securely.

---

## 77. Security Sessions

Users can see:

- Active sessions/devices
- Appropriate approximate device/location information
- Login/security alerts

Actions: Log out device, Log out all devices

Sensitive actions require re-authentication.

---

## 78. 2FA / MFA

- **Customers** — Optional
- **Providers** — Strongly encouraged/required for sensitive actions
- **Admins** — Mandatory MFA

Sensitive actions may require step-up authentication.

---

## 79. Fraud & Abuse

Smart hybrid:

- Rule-based safeguards
- Risk signals
- AI-assisted anomaly detection
- Rate limiting
- Device/account signals where appropriate
- Human review for serious enforcement
- Appeals
- Audit trail

Never permanently ban solely from an AI prediction.

---

## 80. AI Architecture

### 80.1 AI provider abstraction

Use one primary AI provider/model for MVP.

Put it behind an AI service abstraction.

Do not make business logic depend directly on a particular model.

Future model switching should be possible through configuration.

### 80.2 Task routing

Start with one reliable model.

Architecture should allow later routing by task:

- Natural-language service understanding
- Conversation
- Translation
- Summarization
- Voice transcription
- Recommendation assistance
- Admin assistance

Route later by: Cost, Latency, Quality, Task complexity

Do not over-engineer MVP.

---

## 81. AI Memory

Separate:

- **Conversation history** — What was actually said.
- **AI memory** — Small set of useful, relevant, permitted preferences.

Memory must not automatically become a copy of all conversations.

Users can: View, Delete, Reset

Sensitive data should not be casually remembered.

---

## 82. AI Conversation History

Users can:

- View conversations
- Search conversations
- Delete individual conversations
- Clear history
- Start temporary/private AI conversations where appropriate

Retention follows platform policy.

Transactional records remain governed by booking/payment systems.

---

## 83. AI Proactive Suggestions

AI can proactively surface useful, low-noise suggestions.

Examples:

> "Your booking starts in 30 minutes. Want directions?"
> "You have not selected an offer yet. 42 seconds remain."
> "Your provider marked the service complete. Would you like to review it?"

AI must not: Spam, Make purchases without permission, Send messages without permission, Constantly interrupt

Users can disable non-essential proactive suggestions.

---

## 84. AI Notification Transparency

System notification:

> "Your booking has been confirmed."

AI suggestion:

> "Servio suggests leaving 15 minutes early."

System facts are authoritative.

AI suggestions are clearly suggestions.

AI cannot rewrite system status.

---

## 85. AI Activity History

Show meaningful AI actions.

Example:

```
Today · 4:32 PM
✓ Searched for electricians
✓ Checked Ali's availability
✓ Prepared booking
✓ Booking confirmed after your approval
```

User can inspect: What happened, When, Related request/booking, Result, Whether confirmation was required

Do not expose raw MCP internals.

---

## 86. AI Undo

Only show Undo when an action is genuinely reversible.

Never pretend an irreversible action can be undone.

If irreversible: Explain, Offer recovery path

---

## 87. AI Autonomy

Risk-based autonomy model.

**Low risk** — Automatic: Search, Filter, Summarize, Translate, Calculate, Read information

**Medium risk** — Confirmation/context: Send message, Modify preferences, Create draft/request

**High risk** — Explicit confirmation + secure UI: Booking, Payment, Cancellation, Payout, Account/security changes

**Restricted** — Human/admin: Safety enforcement, Serious disputes, Bans, Financial investigations

Core flow:

```
AI requests action
→ MCP validates
→ Backend authorizes
→ Action executes
→ Result returned
→ AI reports truthfully
```

---

## 88. MCP Architecture

Use small, domain-specific MCP tools.

**Read tools** examples:

- search_services
- search_providers
- get_provider
- get_availability
- get_booking
- get_offers
- get_earnings
- get_notifications

**Action tools** examples:

- Create request
- Send offer
- Accept offer
- Create booking
- Cancel booking
- Send message
- Request payment authorization
- Mark arrived
- Start service
- Complete service
- Create support case

Every tool must have:

- Strict schema
- Authentication
- Authorization
- Ownership checks
- Risk level
- Confirmation requirement
- Audit behavior
- Idempotency where state-changing

Do not create one giant servio_do_everything tool.

---

## 89. MCP Authorization

Authorization must validate:

1. Authenticated identity
2. Current role/mode
3. Resource ownership
4. Booking/request context
5. Tool risk
6. Required confirmation
7. Permission scope
8. Audit requirements

Example:

Customer asks: "Cancel my booking."

Backend verifies:

- Booking belongs to user
- Booking is cancellable
- User has permission
- Confirmation requirements met
- Current state valid

AI is never the security boundary.

---

## 90. MCP Confirmation

Risk-based.

- **Low risk** — No confirmation
- **Medium** — Conversational confirmation where appropriate
- **High** — Structured confirmation UI
- **Financial/security** — Secure authorization

Confirmation must be bound to exact parameters.

Example:

```
Provider
Service
Date/time
Location
Price
Currency
```

If parameters change, confirmation must be obtained again.

---

## 91. MCP Idempotency

Every important state-changing tool uses idempotency keys.

Backend/database enforces uniqueness where appropriate.

Retries return the original result instead of duplicating actions.

Payment provider idempotency must be used where supported.

Important actions:

- Booking
- Payment
- Offer
- Cancellation
- Withdrawal
- Refund

---

## 92. MCP Errors

Backend returns structured errors.

AI translates them into natural language.

Never claim success without confirmed backend success.

Retry only safely retryable errors.

Example:

> "Ali is no longer available at 5 PM."
> Options: Find another provider / Check Ali's next availability / Choose another time

---

## 93. Prompt Injection Defense

Treat all external/user content as untrusted:

- User messages
- Provider descriptions
- Reviews
- Uploaded files
- Search results
- Tool output

Rules:

- Separate system/developer instructions from retrieved content
- MCP tools enforce authorization independently
- Validate tool arguments server-side
- Never follow instructions embedded in content
- Limit AI data access
- Sanitize/validate uploads
- Log suspicious tool patterns
- Require confirmation for risky actions

---

## 94. AI Cost Controls

Implement:

- Per-user usage limits
- Token/time limits
- Rate limits
- Model routing
- Safe caching/reuse
- Admin usage monitoring
- Cost alerts
- Abuse detection

Do not break critical transactional workflows ambiguously because of an AI limit.

---

## 95. Real-Time Architecture

Use smart hybrid real-time architecture.

**HTTP** — Normal CRUD and standard APIs.

**WebSockets** — Live offers, Booking status, Chat, Timers, Other interactive real-time features

**Push notifications** — Background/mobile alerts.

Server remains source of truth.

Support: Reconnect, Retry, Connection state, Authoritative state refresh

---

## 96. Background Jobs

Use background queue/workers for:

- Offer expiration
- Notifications
- Media processing
- AI summaries
- Analytics processing
- Scheduled reminders
- Cleanup

Use: Retries, Backoff, Idempotent workers, Dead-letter/error handling, Monitoring

Critical timers remain server/database authoritative.

---

## 97. Search Infrastructure

Smart hybrid:

- Database filtering for authoritative structured fields
- Full-text search
- Semantic/vector search where useful
- Optional embeddings for natural language
- AI intent interpretation

Do not let AI fabricate results.

---

## 98. API Architecture

Use versioned APIs.

Start: `/api/v1/`

Use stable contracts.

Include:

- Backward compatibility where practical
- Deprecation process
- OpenAPI specification
- Human-readable docs
- Authentication requirements
- Examples
- Error codes

Future mobile clients use the same backend APIs.

---

## 99. API Response Standard

Consistent conventions for:

- Success
- Validation errors
- Auth errors
- Permission errors
- Not found
- Conflict/state errors
- Rate limits
- Pagination
- Correlation IDs

Use machine-readable error codes + human-readable messages.

---

## 100. Rate Limiting

Smart hybrid.

Different limits for:

- Authentication
- Search
- Messaging
- AI
- MCP
- Payment
- Security

Use: User limits, IP/device signals where appropriate, Burst handling, HTTP 429, Admin-configurable thresholds

---

## 101. API Documentation

Use:

- OpenAPI
- Human-readable docs
- Request/response examples
- Error code docs
- Auth docs
- MCP documentation separately

Keep docs synchronized with implementation.

---

## 102. File/Media Architecture

Use object storage.

**Public media** — CDN where appropriate, Optimized delivery

**Private/sensitive** — Private bucket/storage, Signed URLs, Strict access policies

Do not store large files in relational DB blobs unless there is a compelling specific reason.

---

## 103. PWA / Responsive Behavior

Use adaptive responsive layouts.

Breakpoints should be content-driven:

- Mobile
- Large mobile/small tablet
- Tablet
- Desktop
- Wide desktop

Do not target individual phone models.

Offline:

- Cache safe app shell/static assets
- Show offline status
- Allow previously loaded safe content where appropriate
- Queue only explicitly supported safe actions
- Never claim booking/payment/message success without server confirmation
- Retry safe operations when connection returns

---

## 104. Loading States

Use:

- Skeletons for content-heavy screens
- Spinners for short actions
- Progress indicators for uploads/long operations
- Safe optimistic UI

Never leave users uncertain whether something is happening.

---

## 105. Error States

Errors should be: Plain-language, Actionable, Honest, Context-specific

Example:

```
We couldn't load your offers.
Your request is still active.
[Try Again]
```

Payment:

```
Payment wasn't completed.
No charge was confirmed.
[Try Again] [Change Payment Method]
```

Preserve entered data where possible.

Technical details only for developers/admins.

---

## 106. Accessibility

Accessibility-first.

Requirements:

- Semantic HTML
- Keyboard navigation
- Screen-reader support
- Accessible labels
- Focus states
- Contrast
- Touch targets
- Reduced motion
- Accessible forms
- Accessible errors
- Accessible dialogs
- Accessible menus
- RTL support
- Urdu accessibility

Testing:

- Automated accessibility checks in CI
- Keyboard testing
- Screen-reader checks
- Contrast validation
- Focus testing
- Touch-target testing
- Reduced-motion testing
- RTL/Urdu testing
- Manual review of critical journeys

---

## 107. Browser/Device Compatibility

Test critical flows across:

- Chrome
- Safari
- Edge
- Firefox
- iOS Safari
- Android Chrome

Test: Responsive sizes, Touch, Mouse, Keyboard, PWA install behavior where supported

---

## 108. Performance

Set measurable performance budgets.

Optimize:

- Initial load
- Core Web Vitals
- Images
- Bundles
- Lazy loading
- API response times
- Caching
- Mobile performance

Test slow networks.

Monitor real-world performance.

---

## 109. SEO

Public pages should be SEO-friendly.

Include:

- Titles
- Descriptions
- Structured data where appropriate
- Canonical URLs
- Sitemap
- Robots rules
- Open Graph
- Social previews

Indexable:

- Public service pages
- Public category pages
- Public provider profiles where appropriate

Never index:

- Private profiles/data
- Bookings
- Payments
- Messages
- Admin
- Sensitive personal data

---

## 110. Demo Mode

Include realistic controlled seed data.

Seed:

- Customer accounts
- Provider accounts
- Admin accounts
- 8 categories
- Multiple services
- Provider profiles
- Packages
- Portfolio placeholders
- Reviews
- Requests
- Offers
- Bookings
- Notifications
- Different availability states

Demo data must be clearly identifiable and separated from production data.

---

## 111. Demo Access

Provide:

- Pre-created demo accounts
- One-click Customer demo
- One-click Provider demo
- One-click Admin demo
- Clear Demo Mode label
- Reset demo data
- Safe simulated behavior

No real money.

---

## 112. Demo Payments

Use official payment-provider sandbox/test environment where available.

Support simulated: Success, Failure, Pending, Cancellation

Keep payment architecture as close to production as practical.

Never process real money in demo mode.

---

## 113. Payments & Financial Testing

Test:

- Successful payment
- Failed payment
- Pending payment
- Refund
- Partial refund
- Cancellation fee
- Payout pending
- Payout failure
- Duplicate payment attempts
- Idempotency
- Price change confirmation

---

## 114. CI/CD

Use:

- Lint
- Typecheck
- Unit tests
- Integration tests
- MCP tests
- Security/permission tests
- E2E tests

Pull requests automatically validate.

Successful changes can deploy to staging.

Production deployment requires controlled approval.

Database migrations must be reviewed and safe.

Failed checks block deployment.

Have rollback strategy.

---

## 115. Testing Strategy

Test core business logic.

Test:

- Auth
- Roles
- Ownership
- Matching
- Offers
- 2-minute expiration
- Booking
- Payment state
- Refunds
- Payouts
- Messaging permissions
- Reviews
- Disputes
- Safety
- MCP authorization
- MCP confirmation
- Idempotency
- AI tool behavior
- Accessibility
- Responsive UI

Critical examples:

- Customer cannot cancel another customer's booking.
- Repeated booking tool call cannot create two bookings.
- AI cannot bypass provider availability.
- AI cannot claim payment succeeded when backend says failed.

---

## 116. Backup & Disaster Recovery

Use:

- Automated backups
- Point-in-time recovery where supported
- Backup retention
- Encryption
- Recovery testing
- File backup protection
- Documented disaster recovery
- Protection against casual production deletion

---

## 117. Observability

Use:

- Structured logs
- Error tracking
- Performance monitoring
- MCP execution tracing
- Background job monitoring
- Health checks
- Critical alerts
- Request/correlation IDs

Keep audit logs separate from normal application logs.

Important AI trace:

```
User
→ AI
→ MCP tool
→ authorization
→ backend
→ result
→ AI response
```

---

## 118. Environments & Secrets

Separate: Development, Staging, Production

Use environment variables and secret management.

Never commit:

- API keys
- Payment secrets
- Database passwords
- MCP credentials
- AI credentials

Provide: `.env.example`

Public config must be separated from secrets.

---

## 119. Feature Flags

Use feature flags for:

- New features
- Gradual rollout
- Environment-specific activation
- Emergency kill switches

Business admins may control approved business-level flags.

Developers control security/technical flags.

All flag changes are audited.

---

## 120. International Expansion

MVP launches in Pakistan.

Architecture must support future:

- Countries
- Currencies
- Languages
- Address systems
- Payment systems
- Tax rules
- Timezones
- Service areas

Do not hard-code country assumptions.

---

## 121. MVP Scope

Build a fully functional core MVP.

### MVP must include

**Customer**

- Guest browsing
- Signup/login
- Customer profile
- Search
- Natural-language search
- Service categories
- Service pages
- Service-specific request forms
- Location
- Requests
- Offers
- Offer timer
- Offer comparison
- Provider comparison
- Booking
- Payment sandbox/integration architecture
- Messaging
- Booking status
- Completion
- Reviews
- Support
- Notifications
- Privacy/security settings
- AI assistant

**Provider**

- Signup
- Provider profile
- Verification workflow foundation
- Services
- Packages
- Pricing
- Availability
- Service areas
- Incoming requests
- Accept/decline/send offer
- Negotiation
- Messaging
- Booking management
- Arrival/start/complete
- Evidence
- Earnings
- Payout settings foundation
- Reviews
- Support

**Admin**

- Dashboard
- Users
- Providers
- Services
- Categories
- Requests
- Bookings
- Payments
- Refunds
- Disputes
- Support
- Safety
- Moderation
- RBAC
- Audit logs
- Analytics
- Feature flags
- Configuration
- Policy management

**AI/MCP**

- AI chat
- Service intent extraction
- Search assistance
- Provider recommendation
- Natural-language request creation
- MCP read tools
- MCP action tools
- Risk-based confirmation
- Authorization
- Idempotency
- Activity history
- AI memory
- AI conversation history
- Cost controls
- Prompt-injection defenses

---

## 122. Phase 2

Keep these modular:

- Advanced fraud/ML
- Advanced ML ranking
- Sponsored listings
- More sophisticated AI coaching
- Advanced automation
- Native Android app
- Native iOS app
- Deep BI analytics
- Advanced provider growth tools
- More advanced payout automation
- Expanded countries/currencies
- Advanced recommendation models
- Dark mode

---

## 123. Navigation Details

### Customer

**Home** — Personalized discovery, Search/AI entry, Active booking, Recommendations

**Explore** — Categories, Services, Providers, Search, Filters

**Requests** — Active requests, Offers, Expired requests, Request history

**Bookings** — Upcoming, Active, Completed, Cancelled, Disputed

**Account** — Profile, Saved providers, Notifications, Privacy/security, AI memory/history, Payment methods, Settings, Help

### Provider

**Dashboard** — Today's work, New requests, Upcoming bookings, Earnings snapshot

**Requests** — New, Responded, Offers, History

**Schedule** — Availability, Calendar, Overrides, Blocked periods

**Earnings** — Pending, Eligible, Paid, Payouts, Statements

**Account** — Profile, Services, Packages, Verification, Service areas, Notifications, Security, Help

### Admin

**Overview** — Marketplace health, Requests, Bookings, Revenue, Alerts

**Operations** — Requests, Bookings, Disputes, Support, Safety

**Users** — Customers, Providers, Admins, Moderation

**Marketplace** — Categories, Services, Providers, Matching rules, Pricing policies, Cancellation policies

**Analytics** — Funnel, Revenue, Supply/demand, Provider performance, Retention, Service trends, AI usage

**Settings** — Feature flags, Policies, Notifications, Integrations, Admin roles, System configuration

---

## 124. Core Data Model

At minimum, design entities for:

```
User
CustomerProfile
ProviderProfile
AdminProfile
Role
Permission
Category
Subcategory
Service
ServiceField
ServiceRequirement
ServiceFAQ
ServicePackage
ProviderService
ProviderAvailability
ProviderAvailabilityOverride
ProviderServiceArea
Request
RequestFieldValue
RequestAttachment
RequestProviderMatch
Offer
OfferRevision
OfferMessage
Booking
BookingStatusHistory
BookingMilestone
Payment
PaymentAttempt
PaymentAuthorization
Refund
RefundLine
Payout
PayoutMethod
Conversation
ConversationParticipant
Message
MessageAttachment
Review
ReviewResponse
ReviewReport
Dispute
DisputeEvidence
DisputeMessage
DisputeResolution
DisputeAppeal
SafetyReport
SupportTicket
SupportMessage
SupportNote
Notification
NotificationPreference
AIConversation
AIMessage
AIMemory
AIAction
AIToolCall
AuditLog
FeatureFlag
Policy
PolicyVersion
PolicyAcceptance
Session
SecurityEvent
FileAsset
Location
Address
AnalyticsEvent
```

Use appropriate foreign keys, indexes, unique constraints, state transitions, and JSON fields.

Do not implement all of these as isolated disconnected tables; model real relationships.

---

## 125. Important State Machines

Implement explicit state machines for:

**Request**

```
Draft
→ Submitted
→ Matching
→ Offers Open
→ Provider Selected
→ Booking Created
→ Cancelled / Expired / Completed
```

**Offer**

```
Draft
→ Sent
→ Viewed
→ Revised
→ Accepted / Declined / Expired / Withdrawn
```

**Booking**

```
Pending
→ Confirmed
→ Provider En Route
→ Arrived
→ In Progress
→ Completed
→ Protected
→ Settled
```

Possible alternate states: Cancelled, Disputed, Refunded, Failed

**Payment**

```
Created
→ Requires Action
→ Authorized / Pending
→ Captured
→ Failed
→ Refunded / Partially Refunded
```

**Payout**

```
Pending
→ Eligible
→ Processing
→ Paid
→ Failed
```

State transitions must be validated server-side.

---

## 126. API Domains

Suggested API organization:

```
/api/v1/auth
/api/v1/users
/api/v1/customers
/api/v1/providers
/api/v1/categories
/api/v1/services
/api/v1/search
/api/v1/requests
/api/v1/offers
/api/v1/bookings
/api/v1/payments
/api/v1/refunds
/api/v1/payouts
/api/v1/messages
/api/v1/reviews
/api/v1/disputes
/api/v1/safety
/api/v1/support
/api/v1/notifications
/api/v1/ai
/api/v1/admin
```

Use OpenAPI.

---

## 127. MCP Tool Examples

**Read:**

```
search_services
search_providers
get_service
get_provider
get_provider_availability
get_request
get_offers
get_booking
get_customer_profile
get_provider_earnings
get_notifications
```

**Actions:**

```
create_service_request
send_provider_message
send_offer
accept_offer
request_offer_change
create_booking
cancel_booking
authorize_payment
mark_provider_arrived
start_service
complete_service
create_support_ticket
submit_review
```

Admin tools should be separately permissioned and should not be exposed to ordinary customer/provider AI contexts.

---

## 128. Acceptance Criteria

The MVP is not "done" because screens exist.

It is done when critical flows work end-to-end.

**Customer flow**

```
Guest
→ Search
→ Service
→ Request
→ Provider matching
→ Offers
→ Compare
→ Select
→ Payment sandbox
→ Booking
→ Chat
→ Service
→ Complete
→ Review
```

**Provider flow**

```
Signup
→ Profile
→ Services
→ Availability
→ Request
→ Offer
→ Chat
→ Booking
→ Arrive
→ Start
→ Complete
→ Earnings
```

**Admin flow**

```
Login
→ Dashboard
→ User/provider management
→ Marketplace configuration
→ Booking/dispute/support operations
→ Audit log
→ Analytics
```

**AI flow**

```
Natural language
→ Intent extraction
→ Real search
→ Real provider data
→ Explainable recommendation
→ Confirmation
→ MCP action
→ Backend authorization
→ Real result
→ AI truthful response
```

---

## 129. Claude Development Workflow

Claude must NOT build the entire system in one giant unverified pass.

Use small vertical slices.

For each slice:

1. Plan
2. Implement database/backend
3. Implement API
4. Implement frontend
5. Implement tests
6. Run lint
7. Run typecheck
8. Run tests
9. Verify UI
10. Fix issues
11. Update docs
12. Update BUILD_STATUS.md
13. Move to next slice

Never claim something works without verifying it.

---

## 130. BUILD_STATUS.md

Maintain:

- Completed
- In Progress
- Blocked
- Tested
- Known Limitations
- Next Recommended Task

Also track:

- Environment setup
- External integrations
- Test status
- Migration status
- Demo credentials
- Known bugs

---

## 131. Recommended Build Order

**Milestone 1 — Foundation**

- Monorepo
- Next.js app
- Backend modular monolith
- Database
- Environment config
- Design tokens
- UI primitives
- Authentication foundation

**Milestone 2 — Accounts**

- Customer profile
- Provider profile
- Admin RBAC
- Role switching
- Sessions/security

**Milestone 3 — Marketplace**

- Categories
- Services
- Service fields
- Provider services
- Service pages
- Search
- Location

**Milestone 4 — Requests & Matching**

- Request creation
- Provider eligibility
- Matching
- Request distribution
- 2-minute offer system
- Offer expiration

**Milestone 5 — Offers & Booking**

- Offers
- Negotiation
- Comparison
- Availability
- Booking
- Booking states

**Milestone 6 — Payments**

- Payment abstraction
- Sandbox
- Authorization/capture where supported
- Refunds
- Protection window
- Payout foundation

**Milestone 7 — Communication**

- Conversations
- Messaging
- Notifications
- Attachments

**Milestone 8 — Completion & Trust**

- Arrival
- Start
- Progress
- Completion
- Evidence
- Reviews
- Reports
- Disputes
- Safety

**Milestone 9 — AI**

- AI abstraction
- Natural-language search
- AI assistant
- Memory/history
- AI activity
- Cost controls

**Milestone 10 — MCP**

- Read tools
- Action tools
- Authorization
- Confirmation
- Idempotency
- Error handling
- Audit

**Milestone 11 — Admin**

- Dashboard
- Operations
- Support
- Marketplace configuration
- Analytics
- Audit
- Feature flags

**Milestone 12 — Hardening**

- Security
- Accessibility
- Performance
- SEO
- Browser compatibility
- Offline/PWA
- Backup/recovery
- CI/CD
- Documentation

---

## 132. Non-Negotiable Rules for Claude

1. Do not expose secrets.
2. Do not trust frontend authorization.
3. Do not trust AI authorization.
4. Do not trust browser timers.
5. Do not use floating point for money.
6. Do not create duplicate bookings on retries.
7. Do not claim a payment succeeded without backend/payment-provider confirmation.
8. Do not claim an MCP action succeeded without tool confirmation.
9. Do not allow AI to invent providers/services.
10. Do not allow AI to bypass permissions.
11. Do not permanently ban users solely from AI predictions.
12. Do not expose sensitive personal information unnecessarily.
13. Do not publicly expose personal phone numbers/emails.
14. Do not index private marketplace data.
15. Do not silently change confirmed prices.
16. Do not silently override ranking rules.
17. Do not make safety decisions solely through AI.
18. Do not implement critical state transitions only in the frontend.
19. Do not hard-code Pakistan-specific assumptions into core architecture.
20. Do not over-engineer the MVP into microservices.
21. Do not build fake "working" integrations when an external provider is required.
22. Use sandbox/test environments for demo payments.
23. Keep advanced Phase 2 features modular.
24. Maintain tests for critical business rules.
25. Maintain BUILD_STATUS.md.

---

## 133. Final Claude Instruction

You are the lead engineer responsible for implementing Apuriva from this specification.

Do not treat this document as a suggestion list. Treat it as the source of truth for product behavior and architecture.

When a requirement is ambiguous:

1. Prefer the explicitly documented rule.
2. Preserve the Smart Hybrid approach.
3. Prefer simple, maintainable MVP architecture.
4. Avoid unnecessary dependencies.
5. Do not invent external credentials.
6. Use environment variables for integrations.
7. Use sandbox/mock adapters when external credentials are unavailable.
8. Keep production integration points clearly defined.
9. Explain any unavoidable deviation.
10. Update BUILD_STATUS.md.

Before implementation, create a concise implementation plan.

Then work milestone-by-milestone in vertical slices.

For every completed slice:

- Run tests
- Run typecheck
- Run lint
- Verify critical UI flows
- Verify permissions
- Verify error states
- Verify loading states
- Verify mobile responsiveness
- Update documentation
- Update BUILD_STATUS.md

Do not proceed indefinitely without verification.

The finished MVP should feel like a coherent real product, not a collection of disconnected screens.

---

## 134. Product North Star

Apuriva should feel like:

> A trusted modern service companion that helps people find the right person, get the job done, and stay protected throughout the experience.

The customer should be able to say:

> "I need help with something."

And Apuriva should make the path from that sentence to a successful real-world service simple, transparent, safe, and intelligent.

**APURIVA**
*Get the right help. Get it done.*
