# Provider sidebar, drawer and customer-card correction

This release keeps the existing provider business logic unchanged and updates only the provider presentation layer.

## Changes

- Removed the duplicate provider avatar/name/location block from desktop and mobile navigation.
- Added a compact mobile drawer header and close action.
- Reduced sidebar width, spacing and visual weight.
- Stabilized mobile drawer scrolling and body scroll restoration.
- Hides bottom navigation while the drawer is open to avoid split navigation layers.
- Prevents horizontal page movement while the drawer is open.
- Formats customer names, cities and states for display without changing stored values.
- Makes unlocked lead information and customer actions feel like one consistent card.

## Unchanged

Lead matching, CRM synchronization, pricing, credits, Razorpay, outcome rules, reminders and stored provider/customer data are unchanged.
