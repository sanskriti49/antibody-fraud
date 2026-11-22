---
id: pb-account-takeover
version: 1
title: Account takeover after a credential change
status: approved
trigger: behaviour_shift, new_device
trigger: behaviour_shift, recent_reset
trigger: sensitive_payee_transition
---
# Account takeover after a credential change

Synthetic guidance for the ContextCon fraud lab. Not operational advice.

## Typical sequence
- A sign-in from an unfamiliar device with typing and interaction timing far from the customer's baseline.
- A password reset in the same session, often within minutes.
- A new payee registered, then a large transfer to it.

## Investigation checklist
- Compare the session's device and network with the account's 30-day history.
- Check whether the timing shift persists across every step or only one.
- Confirm whether the reset and the new payee belong to the same session.
- Look for an active verified pattern match and open its origin case.
- Check graph paths for the payee or device on other recently challenged accounts.

## Action guidance
- Step-up verification through an independent channel before any new payee is usable.
- Block when the session repeats a verified takeover pattern or the transfer adds an amount spike.
- Hold the new payee until the customer confirms it out of band.

## Benign explanations
- A new phone or keyboard changes timing for a genuine customer. See pb-legitimate-lookalikes.
- A forgotten password produces a reset without any takeover.
