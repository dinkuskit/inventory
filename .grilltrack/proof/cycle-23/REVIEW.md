# Cycle 23 review — stock.unpack

Source identity is the commit that lands this cycle.

## Standards

- Feature-local `stock.unpack` through `src/features/stock-reservation/index.ts`
- Schema v8 remaps predecessor `active` reservation rows to `not_shipped`
- No Woo/Katana/Stripe mutation, no Worker route, no npm publish

## Source intent

- Commerce names one ticket; no quantity; no order number
- Packed bags return to the same Not shipped ticket
- Pack-some leftover stays reserved and joins the unpacked bags
- Available unchanged; shelf only via existing release
- Revert-from-Delivered and unpack-some stay out

Result: clean
