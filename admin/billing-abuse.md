# Card testing and the billing abuse posture

Card testers use any reachable payment integration to validate stolen card
numbers in bulk. The merchant absorbs the disputes, the fees, and eventually
the processor's attention — this is the default experience of shipping a
payment form with no controls, not a hypothetical.

Everything a tester wants is one thing: **a cheap, fast accept/decline
oracle.** Every control below is the same move — make an attempt cost
something, or make the answer slow, ambiguous, or unavailable.

## What already holds, structurally

A PaymentIntent exists only for a session-authenticated owner of the target
account (`accountOwner` in `admin/index.mjs`'s route table). There is no
anonymous endpoint to point a script at, which is worth more than every tuning
knob below combined: it converts unlimited free attempts into attempts that
cost an account. It also makes signup velocity load-bearing here — whatever
bounds account creation bounds payment attempts from above.

## What the handler does (rove#339)

Guards in `admin/index.mjs`, all keyed on the account:

| guard | threshold | effect |
|---|---|---|
| subscribe attempts | 5 per hour | `429 billing_attempt_rate_limited` |
| declines (`payment_intent.payment_failed`) | 5 per day | 24h hold |
| distinct card fingerprints | 3 per day | 24h hold |
| `charge.dispute.created` | any | 24h hold |

A hold is time-boxed and expires on its own; an operator clears it early by
deleting `account/{aid}/billing/hold`. It is deliberately not a suspension: at
this layer a customer whose bank declines five times is indistinguishable from
a tester, and a false positive costs a sale. Suspending the tenant is a
person's call on evidence the handler cannot see (rove#335's
`/_control/suspend`).

Distinct fingerprints is the sharper axis. One card declining five times is a
customer with a problem; five cards declining once each is not.

**Know what the attempt limit bounds: the client secret.** Once the browser
holds one, confirmations go straight to Stripe and never touch our handler. We
bound how many secrets an account may mint and how long a visibly-testing
account keeps getting new ones. Blocking an individual attempt is Radar's job.

## What Stripe has to do (the configuration half)

The dashboard is not in this repo, so this is the checklist rather than the
change. The defaults are a floor, not a configuration.

1. **Turn on Radar's card-testing protections** and review the built-in rules,
   rather than assuming the defaults cover it.
2. **Velocity rules on the tester's shape** — many distinct cards from one
   IP/email/device in a short window, and repeated declines from one source.
   Take the exact metric identifiers from Radar's rule editor autocomplete;
   they are Stripe's vocabulary and change independently of this doc, so
   copying a spelling out of prose is how a rule silently matches nothing.
3. **Request 3DS on elevated risk.** A tester cannot complete an authentication
   challenge at the cardholder's bank; a real customer taps once. This is the
   highest-value single rule.
4. **Alert on the decline rate**, not just on volume. A decline-rate spike with
   a flat customer count is the incident signature.
5. Custom rules need **Radar for Fraud Teams** (a paid add-on). That is a cost
   decision — make it deliberately rather than discovering the standard tier
   cannot express the rules above.

## Keep feeding Radar client signals

`admin/_static/pages/billing.js` loads Stripe.js from `js.stripe.com` — Stripe
requires that origin, and it is also what gives Radar its device fingerprint. A
future tightening of the page's external-host posture would degrade fraud
scoring silently rather than break anything visibly. If that tradeoff is
revisited, revisit it knowingly.

## Never build

Any endpoint that validates a card as a feature: `$0` authorizations exposed as
a public path, "check this card" affordances, or a SetupIntent flow with looser
limits than the payment path. Testers use whichever door has the fewest
controls, so a second door with weaker rules is worse than no second door.
